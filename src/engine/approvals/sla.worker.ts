/**
 * The SLA sweeper: what happens to an approval nobody looked at.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * Today an unreviewed message waits forever. `message_history` rows sit at
 * `status='QUEUED'` with `queued_message->>'approvalStatus'='PENDING_APPROVAL'`
 * and nothing ages them out, notifies anyone, or reports them — a provider on
 * holiday means every message routed to them stops, silently, with no signal
 * anywhere. There is no deadline column to sweep, which is why P2 added
 * `approvals.sla_deadline` and the index that makes this query cheap.
 *
 * Three expiry policies, from `approval_policies.sla.onExpiry`:
 *
 *   escalate  reopen for the fallback approver and notify them. The default,
 *             and the only one that keeps a human in the loop.
 *   decline   drop the message. For time-sensitive content where a late send is
 *             worse than none — an appointment reminder for yesterday.
 *   approve   send it anyway. Only sane for low-stakes playbooks, and it is the
 *             reason `sla.onExpiry` is policy data rather than a global setting.
 *
 * ESCALATION GOES THROUGH THE ENGINE ITSELF. The notification is a
 * `system.approval_escalation` playbook — this service telling someone something
 * happened is the same problem it solves for everyone else, and using a private
 * side channel here would be an admission that the abstraction does not hold.
 * P7 owns playbooks, so P6 leaves an injected `notify` hook: unset, escalation
 * still reopens the approval and logs, it just does not send mail yet.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { Queue, Worker, type Job } from 'bullmq';
import { and, asc, eq, isNotNull, lt } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Logger } from 'winston';

import type { Db } from '../../db/index.js';
import { approvals } from '../../db/schema.js';
import { metricsRegistry, promClient } from '../../platform/observability/metrics.js';
import type { TenantScope } from '../../platform/db/tenant-scope.js';
import type { ApprovalService } from './approval.service.js';
import type { ApprovalSla, PolicyService } from './policy.service.js';
import { SYSTEM_ACTOR, transition, appendAudit } from './state-machine.js';

export const SLA_QUEUE_NAME = 'outreach-approval-sla';

export const approvalsExpiredTotal = new promClient.Counter({
  name: 'outreach_approvals_expired_total',
  help: 'Approvals that passed their SLA deadline without a decision',
  labelNames: ['tenant', 'action'] as const,
  registers: [metricsRegistry],
});

export const approvalsPendingGauge = new promClient.Gauge({
  name: 'outreach_approvals_pending',
  help: 'Approvals currently awaiting a decision',
  labelNames: ['tenant'] as const,
  registers: [metricsRegistry],
});

export interface EscalationNotice {
  scope: TenantScope;
  approvalId: string;
  messageId: string;
  /** Who it was assigned to and went unanswered by. */
  originalApproverRef: string | null;
  /** Who it has been reassigned to. */
  fallbackApproverRef: string;
  waitedMs: number;
}

export interface SlaSweepReport {
  scanned: number;
  escalated: number;
  declined: number;
  approved: number;
  failed: number;
}

export interface SlaSweeperDeps {
  db: Db;
  logger: Logger;
  approvals: ApprovalService;
  policies: PolicyService;
  /** P7 wires the `system.approval_escalation` playbook here. */
  notify?: (notice: EscalationNotice) => Promise<void>;
  /** Rows per sweep. Bounded so one enormous backlog cannot monopolise a worker. */
  batchSize?: number;
}

/**
 * The sweep itself, with no queue attached — so it can be called directly from
 * a test, or from an operator script, without Redis.
 */
export class SlaSweeper {
  constructor(private readonly deps: SlaSweeperDeps) {}

  async sweep(now: Date = new Date()): Promise<SlaSweepReport> {
    const due = await this.deps.db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.status, 'PENDING_APPROVAL'),
          isNotNull(approvals.slaDeadline),
          lt(approvals.slaDeadline, now),
        ),
      )
      .orderBy(asc(approvals.slaDeadline))
      .limit(this.deps.batchSize ?? 200);

    const report: SlaSweepReport = {
      scanned: due.length,
      escalated: 0,
      declined: 0,
      approved: 0,
      failed: 0,
    };

    for (const row of due) {
      const scope: TenantScope = {
        tenantId: row.tenantId,
        ...(row.subTenantId ? { subTenantId: row.subTenantId } : {}),
      };

      try {
        const policy = await this.deps.policies.load(scope, { policyId: row.policyId });
        const sla: ApprovalSla = policy?.sla ?? {};
        // Escalation is the default because it is the only outcome that does not
        // decide on a human's behalf.
        const action = sla.onExpiry ?? 'escalate';

        // EXPIRED first, always. It is a real state, and recording it means the
        // audit trail shows the deadline passing as its own event rather than
        // implying a human declined at 3am.
        // Returns the trail as it now stands, INCLUDING the EXPIRED entry. The
        // escalate branch below must append to that and not to the trail read
        // at scan time, or it silently overwrites the expiry it just recorded.
        const expired = await this.markExpired(scope, row, now);
        approvalsExpiredTotal.inc({ tenant: row.tenantId, action });

        switch (action) {
          case 'decline':
            await this.deps.approvals.decline(
              scope,
              expired.id,
              SYSTEM_ACTOR('sla.worker'),
              'SLA deadline passed with no decision',
            );
            report.declined += 1;
            break;

          case 'approve':
            // EXPIRED -> AUTO_APPROVED, then released through the dispatcher —
            // so an auto-approval on expiry still faces the compliance gate.
            await this.autoApprove(scope, expired.id);
            report.approved += 1;
            break;

          case 'escalate':
          default:
            await this.escalate(scope, expired, row, sla, now);
            report.escalated += 1;
            break;
        }
      } catch (error) {
        report.failed += 1;
        this.deps.logger.error('SLA sweep failed for one approval', {
          approvalId: row.id,
          tenantId: row.tenantId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (report.scanned > 0) {
      this.deps.logger.info('approval SLA sweep', report);
    }
    return report;
  }

  private async markExpired(
    scope: TenantScope,
    row: typeof approvals.$inferSelect,
    now: Date,
  ): Promise<{ id: string; auditTrail: unknown }> {
    const outcome = transition({
      from: 'PENDING_APPROVAL',
      to: 'EXPIRED',
      actor: SYSTEM_ACTOR('sla.worker'),
      reason: `no decision by ${row.slaDeadline?.toISOString() ?? 'the deadline'}`,
      now,
    });

    const [updated] = await this.deps.db
      .update(approvals)
      .set({
        status: outcome.status,
        auditTrail: appendAudit(row.auditTrail, outcome.entry),
        updatedAt: now,
      })
      .where(
        and(
          eq(approvals.tenantId, scope.tenantId),
          eq(approvals.id, row.id),
          // Lost the race to a human who decided just now — leave their decision alone.
          eq(approvals.status, 'PENDING_APPROVAL'),
        ),
      )
      .returning({ id: approvals.id, auditTrail: approvals.auditTrail });

    if (!updated) {
      throw new Error('approval was decided while the sweep was running');
    }
    return updated;
  }

  /** EXPIRED -> PENDING_APPROVAL, reassigned to the fallback, and notified. */
  private async escalate(
    scope: TenantScope,
    expired: { id: string; auditTrail: unknown },
    row: typeof approvals.$inferSelect,
    sla: ApprovalSla,
    now: Date,
  ): Promise<void> {
    const fallback = sla.fallbackApproverRef;

    if (!fallback) {
      // Nowhere to escalate to. The approval stays EXPIRED and visible rather
      // than being quietly reopened for the same person who already ignored it.
      this.deps.logger.warn(
        'approval expired with no fallbackApproverRef — left EXPIRED for an operator',
        { approvalId: expired.id, tenantId: row.tenantId, approverRef: row.approverRef },
      );
      return;
    }

    const outcome = transition({
      from: 'EXPIRED',
      to: 'PENDING_APPROVAL',
      actor: SYSTEM_ACTOR('sla.worker'),
      reason: `escalated from ${row.approverRef ?? 'unassigned'} to ${fallback}`,
      now,
    });

    await this.deps.db
      .update(approvals)
      .set({
        status: outcome.status,
        approverRef: fallback,
        // The fallback is a person, not a rule — so the reassignment is 'user',
        // and the `agent` senderId check applies to them the same way.
        approverType: 'agent',
        // A second deadline would expire instantly against the old timestamp.
        slaDeadline: sla.deadlineMs ? new Date(now.getTime() + sla.deadlineMs) : null,
        // `expired.auditTrail`, not `row.auditTrail`: the row was read before
        // markExpired ran, so appending to it would drop the EXPIRED entry and
        // make the trail claim the approval went straight back to pending.
        auditTrail: appendAudit(expired.auditTrail, outcome.entry),
        updatedAt: now,
      })
      .where(and(eq(approvals.tenantId, scope.tenantId), eq(approvals.id, expired.id)));

    const notice: EscalationNotice = {
      scope,
      approvalId: expired.id,
      messageId: row.messageId,
      originalApproverRef: row.approverRef,
      fallbackApproverRef: fallback,
      waitedMs: now.getTime() - row.requestedAt.getTime(),
    };

    if (this.deps.notify) {
      await this.deps.notify(notice);
    } else {
      this.deps.logger.warn('approval escalated but no notifier is wired (P7)', notice);
    }
  }

  private async autoApprove(scope: TenantScope, id: string): Promise<void> {
    const current = await this.deps.approvals.getById(scope, id);
    if (!current) return;

    // Straight to AUTO_APPROVED — this was the policy's decision, not a
    // person's, and the audit trail should not claim otherwise.
    await this.deps.db
      .update(approvals)
      .set({
        status: 'AUTO_APPROVED',
        decidedAt: new Date(),
        decidedBy: 'sla.worker',
        auditTrail: appendAudit(
          current.auditTrail,
          transition({
            from: 'EXPIRED',
            to: 'AUTO_APPROVED',
            actor: SYSTEM_ACTOR('sla.worker'),
            reason: 'policy sla.onExpiry = approve',
          }).entry,
        ),
        updatedAt: new Date(),
      })
      .where(and(eq(approvals.tenantId, scope.tenantId), eq(approvals.id, id)));

    // Release through the same path a human approval takes, so the compliance
    // gate still runs. `approve()` is idempotent on an already-approved row and
    // returns it untouched, so this cannot double-send.
    await this.deps.approvals.approve(scope, id, SYSTEM_ACTOR('sla.worker'));
  }
}

export interface SlaWorkerDeps extends SlaSweeperDeps {
  connection: Redis | null;
  /** How often to sweep. Default 60s — the deadline granularity anyone needs. */
  intervalMs?: number;
}

/**
 * The sweeper on a BullMQ repeatable job.
 *
 * A repeatable job rather than a `setInterval` because there are N replicas: the
 * queue guarantees exactly one of them runs each tick. A naive interval would
 * have every replica sweeping the same rows at the same moment, and the
 * status-guarded UPDATE would turn that into a stream of "decided underneath
 * this request" errors.
 */
export class ApprovalSlaWorker {
  private readonly sweeper: SlaSweeper;
  private readonly queue?: Queue;
  private readonly worker?: Worker;

  constructor(private readonly deps: SlaWorkerDeps) {
    this.sweeper = new SlaSweeper(deps);

    if (!deps.connection) {
      deps.logger.warn('approval SLA worker disabled — no Redis connection');
      return;
    }

    const connection = deps.connection;
    this.queue = new Queue(SLA_QUEUE_NAME, { connection });
    this.worker = new Worker(
      SLA_QUEUE_NAME,
      (_job: Job) => this.sweeper.sweep(),
      { connection: connection.duplicate(), concurrency: 1 },
    );

    this.worker.on('error', (error) =>
      deps.logger.error('approval SLA worker error', { error: error.message }),
    );
  }

  async start(): Promise<void> {
    if (!this.queue) return;
    const every = this.deps.intervalMs ?? 60_000;
    await this.queue.add(
      'sweep',
      {},
      { repeat: { every }, removeOnComplete: { count: 20 }, removeOnFail: { count: 50 } },
    );
    this.deps.logger.info('approval SLA sweeper scheduled', { everyMs: every });
  }

  /** Run one sweep now, ignoring the schedule. Used by tests and by operators. */
  async runOnce(now?: Date): Promise<SlaSweepReport> {
    return this.sweeper.sweep(now);
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
