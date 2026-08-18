/**
 * What happens to an approval nobody looked at.
 *
 * Today: nothing. There is no deadline column to sweep and no sweeper, so a
 * provider on holiday silently stops every message routed to them. These tests
 * pin the three expiry policies and, just as importantly, the two cases where
 * the sweeper deliberately does NOT decide on a human's behalf.
 *
 * The database is faked — what is under test is which branch runs and what it
 * writes, not Postgres. `tests/integration/approvals.test.ts` covers the rest.
 */
import winston from 'winston';

import { approvals as approvalsTable, messages } from '../../../src/db/schema.js';
import type { Db } from '../../../src/db/index.js';
import type { ApprovalService } from '../../../src/engine/approvals/approval.service.js';
import {
  FALLBACK_POLICY,
  type ApprovalPolicy,
  type ApprovalSla,
  type PolicyService,
} from '../../../src/engine/approvals/policy.service.js';
import { SlaSweeper, type EscalationNotice } from '../../../src/engine/approvals/sla.worker.js';

const logger = winston.createLogger({ silent: true });
const NOW = new Date('2026-03-08T12:00:00.000Z');

type Row = typeof approvalsTable.$inferSelect;

function dueRow(over: Partial<Row> = {}): Row {
  return {
    id: 'a-1',
    tenantId: 't-1',
    subTenantId: null,
    playbookId: null,
    messageId: 'm-1',
    status: 'PENDING_APPROVAL',
    approverType: 'agent',
    approverRef: 'provider-A',
    requestedAt: new Date('2026-03-08T09:00:00.000Z'),
    decidedAt: null,
    decidedBy: null,
    slaDeadline: new Date('2026-03-08T11:00:00.000Z'),
    originalContent: 'hello',
    editedContent: null,
    declineReason: null,
    aiConfidence: null,
    policyId: 'pol-1',
    auditTrail: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as Row;
}

interface Writes {
  sets: Record<string, unknown>[];
  /** Set to false to simulate a human deciding between the SELECT and the UPDATE. */
  updateMatches: boolean;
}

function builder<T>(rows: () => T[]) {
  const self = {
    where: () => self,
    limit: () => self,
    orderBy: () => self,
    offset: () => self,
    returning: () => self,
    then: (ok: (v: T[]) => unknown, err?: (e: unknown) => unknown) =>
      Promise.resolve(rows()).then(ok, err),
  };
  return self;
}

function fakeDb(due: Row[], writes: Writes): Db {
  return {
    select: () => ({
      from: (table: unknown) => builder(() => (table === messages ? [{ id: 'm-1' }] : due)),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        writes.sets.push(values);
        // `.returning()` echoes what was just written — including the audit
        // trail, which the escalate branch has to append to rather than
        // reappending to the row as it looked before the sweep.
        return builder(() =>
          writes.updateMatches ? [{ id: 'a-1', auditTrail: values.auditTrail ?? [] }] : [],
        );
      },
    }),
  } as unknown as Db;
}

/** Hand-rolled spies: the `jest` global is not injected in ESM mode (D2). */
function spy<A extends unknown[], R>(impl?: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => {
    calls.push(args);
    return impl ? impl(...args) : (undefined as R);
  };
  return Object.assign(fn, { calls });
}

function harness(sla: ApprovalSla, due: Row[] = [dueRow()]) {
  const writes: Writes = { sets: [], updateMatches: true };
  const policy: ApprovalPolicy = { ...FALLBACK_POLICY, id: 'pol-1', sla };

  const decline = spy<[unknown, string, unknown, string?], Promise<unknown>>(async () => ({}));
  const autoApproveOnExpiry = spy<[unknown, string, unknown], Promise<unknown>>(async () => ({}));
  const notify = spy<[EscalationNotice], Promise<void>>(async () => {});

  const approvals = {
    decline,
    autoApproveOnExpiry,
    getById: async () => ({ id: 'a-1', auditTrail: [] }),
  } as unknown as ApprovalService;

  const policies = { load: async () => policy } as unknown as PolicyService;

  const sweeper = new SlaSweeper({
    db: fakeDb(due, writes),
    logger,
    approvals,
    policies,
    notify,
  });

  return { sweeper, writes, decline, autoApproveOnExpiry, notify };
}

describe('expiry is recorded before anything is decided', () => {
  it('writes EXPIRED first, so the trail shows the deadline passing as its own event', async () => {
    const { sweeper, writes } = harness({ onExpiry: 'decline' });
    await sweeper.sweep(NOW);

    expect(writes.sets[0]).toMatchObject({ status: 'EXPIRED' });
    const trail = writes.sets[0]!.auditTrail as { from: string; to: string; actorRef: string }[];
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      from: 'PENDING_APPROVAL',
      to: 'EXPIRED',
      actorRef: 'sla.worker',
    });
  });
});

describe('onExpiry: decline', () => {
  it('declines through the service, as the system actor', async () => {
    const { sweeper, decline } = harness({ onExpiry: 'decline' });
    const report = await sweeper.sweep(NOW);

    expect(report).toMatchObject({ scanned: 1, declined: 1, escalated: 0, approved: 0 });
    expect(decline.calls).toHaveLength(1);
    expect(decline.calls[0]![2]).toMatchObject({ type: 'system', ref: 'sla.worker' });
    expect(decline.calls[0]![3]).toMatch(/SLA deadline passed/);
  });
});

describe('onExpiry: approve', () => {
  it('hands the whole move to the service, which is what makes it release', async () => {
    const { sweeper, autoApproveOnExpiry, writes } = harness({ onExpiry: 'approve' });
    const report = await sweeper.sweep(NOW);

    expect(report).toMatchObject({ scanned: 1, approved: 1 });

    // EXPIRED is written here, and it is the LAST status this file writes. The
    // AUTO_APPROVED move belongs to the service, together with the release —
    // this used to write the status itself and then call `approve()`, whose
    // idempotency guard sees AUTO_APPROVED as already-approved and returns
    // without dispatching. The message was never sent and the trail said it was.
    expect(writes.sets.some((s) => s.status === 'EXPIRED')).toBe(true);
    expect(writes.sets.some((s) => s.status === 'AUTO_APPROVED')).toBe(false);

    expect(autoApproveOnExpiry.calls).toHaveLength(1);
    expect(autoApproveOnExpiry.calls[0]![1]).toBe('a-1');
    expect(autoApproveOnExpiry.calls[0]![2]).toMatchObject({ type: 'system', ref: 'sla.worker' });
  });
});

describe('rows stranded EXPIRED', () => {
  it('are rescanned, so a crash between the expiry and its action is recoverable', async () => {
    // The row expired on a previous sweep and the action that should have
    // followed never ran. The old scan filtered on PENDING_APPROVAL alone, so
    // this row was invisible from then on: never sent, never declined, never
    // looked at again.
    const { sweeper, autoApproveOnExpiry, writes } = harness({ onExpiry: 'approve' }, [
      dueRow({ status: 'EXPIRED' }),
    ]);
    const report = await sweeper.sweep(NOW);

    expect(report).toMatchObject({ scanned: 1, approved: 1 });
    // Not expired a second time — it already carries the state and the trail.
    expect(writes.sets.some((s) => s.status === 'EXPIRED')).toBe(false);
    expect(autoApproveOnExpiry.calls).toHaveLength(1);
  });

  it('are left alone when they are parked waiting for an operator', async () => {
    // `escalate` with no fallback is a deliberate parking state, logged once
    // when it happens. Re-reporting it every sixty seconds would bury the rows
    // the rescan exists to recover.
    const { sweeper, notify, writes } = harness({ onExpiry: 'escalate' }, [
      dueRow({ status: 'EXPIRED' }),
    ]);
    const report = await sweeper.sweep(NOW);

    expect(report).toMatchObject({ scanned: 1, escalated: 0, failed: 0 });
    expect(notify.calls).toHaveLength(0);
    expect(writes.sets).toHaveLength(0);
  });
});

describe('onExpiry: escalate', () => {
  it('is the default when the policy names no onExpiry', async () => {
    // Escalation is the default because it is the only outcome that does not
    // decide on a human's behalf.
    const { sweeper, notify } = harness({ fallbackApproverRef: 'clinic-manager' });
    const report = await sweeper.sweep(NOW);
    expect(report).toMatchObject({ escalated: 1, declined: 0, approved: 0 });
    expect(notify.calls).toHaveLength(1);
  });

  it('reopens for the fallback approver with a fresh deadline', async () => {
    const { sweeper, writes } = harness({
      onExpiry: 'escalate',
      deadlineMs: 3_600_000,
      fallbackApproverRef: 'clinic-manager',
    });
    await sweeper.sweep(NOW);

    const reopened = writes.sets.find((s) => s.status === 'PENDING_APPROVAL');
    expect(reopened).toMatchObject({
      approverRef: 'clinic-manager',
      approverType: 'agent',
    });
    // A second deadline computed from the old timestamp would expire instantly
    // and escalate again on the very next sweep.
    expect((reopened!.slaDeadline as Date).toISOString()).toBe('2026-03-08T13:00:00.000Z');
  });

  it('appends to the trail rather than overwriting the EXPIRED entry it just wrote', async () => {
    // The row was read before markExpired ran. Appending the escalation to
    // *that* trail drops the expiry, and the history then claims the approval
    // went straight from pending back to pending with no reason.
    const { sweeper, writes } = harness({
      onExpiry: 'escalate',
      fallbackApproverRef: 'clinic-manager',
    });
    await sweeper.sweep(NOW);

    const reopened = writes.sets.find((s) => s.status === 'PENDING_APPROVAL');
    const trail = reopened!.auditTrail as { from: string; to: string }[];
    expect(trail.map((e) => e.to)).toEqual(['EXPIRED', 'PENDING_APPROVAL']);
  });

  it('notifies the fallback with how long the message waited', async () => {
    const { sweeper, notify } = harness({
      onExpiry: 'escalate',
      fallbackApproverRef: 'clinic-manager',
    });
    await sweeper.sweep(NOW);

    expect(notify.calls[0]![0]).toMatchObject({
      approvalId: 'a-1',
      messageId: 'm-1',
      originalApproverRef: 'provider-A',
      fallbackApproverRef: 'clinic-manager',
      waitedMs: 3 * 60 * 60 * 1000,
    });
  });

  it('leaves the approval EXPIRED when there is nowhere to escalate to', async () => {
    // Reopening for the same person who already ignored it would just restart
    // the clock and hide the problem. EXPIRED is visible; a silent reassignment
    // to the same inbox is not.
    const { sweeper, writes, notify } = harness({ onExpiry: 'escalate' });
    const report = await sweeper.sweep(NOW);

    expect(report).toMatchObject({ escalated: 1, failed: 0 });
    expect(writes.sets).toHaveLength(1);
    expect(writes.sets[0]).toMatchObject({ status: 'EXPIRED' });
    expect(notify.calls).toHaveLength(0);
  });
});

describe('races with a human', () => {
  it('does not overwrite a decision made between the scan and the update', async () => {
    const { sweeper, writes, decline } = harness({ onExpiry: 'decline' });
    writes.updateMatches = false; // the status guard matched nothing

    const report = await sweeper.sweep(NOW);

    expect(report).toMatchObject({ scanned: 1, failed: 1, declined: 0 });
    expect(decline.calls).toHaveLength(0);
  });

  it('keeps sweeping the rest of the batch after one row fails', async () => {
    const { sweeper } = harness({ onExpiry: 'decline' }, [
      dueRow({ id: 'a-1' }),
      dueRow({ id: 'a-2' }),
    ]);
    const report = await sweeper.sweep(NOW);
    expect(report.scanned).toBe(2);
    expect(report.declined).toBe(2);
  });
});

describe('an empty sweep', () => {
  it('reports zeroes and writes nothing', async () => {
    const { sweeper, writes } = harness({ onExpiry: 'decline' }, []);
    expect(await sweeper.sweep(NOW)).toEqual({
      scanned: 0,
      escalated: 0,
      declined: 0,
      approved: 0,
      failed: 0,
    });
    expect(writes.sets).toHaveLength(0);
  });
});
