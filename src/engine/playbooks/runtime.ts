/**
 * The playbook runtime — what replaces `enhanced-event-handler.ts`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE 725-LINE SWITCH ACTUALLY DID, AND WHAT IS DIFFERENT
 *
 * Every one of its 17 cases had the same five-step shape, written out by hand:
 * pull named fields off `event.data`, check `event.channels.includes(X)`, pick a
 * hardcoded `templateId`, build a per-channel variables object, push onto the
 * queue. The differences between cases were data — which fields, which template,
 * which channels — and the repetition was structure. This file is the structure;
 * the data is now rows.
 *
 * Four things it did that are NOT reproduced, each deliberately:
 *
 * 1. **A missing field threw.** `handleAppointmentRescheduling` reads
 *    `oldAppointment.date` with no guard (:246); an event without
 *    `oldAppointment` throws, the outer catch returns `false`, and the caller
 *    logs "Event handling failed". No row, no reason, no retry. Here a context
 *    that fails the playbook's `data_contract` produces a `FAILED` run row
 *    carrying the schema errors, and never reaches the LLM or the queue.
 *
 * 2. **`handleTreatmentInstructions` read `instructions.summary`** for SMS
 *    (:415) after using `instructions` as an object for email — so the same
 *    payload shape could work on one channel and throw on the other.
 *
 * 3. **Nothing was recorded.** The handler returns a bare `boolean`. When a
 *    message does not arrive there is no evidence of which case ran or why it
 *    stopped. Every run writes a `playbook_runs` row here.
 *
 * 4. **Redelivery double-sent.** The queue retries five times; a case that threw
 *    after queueing its first channel would re-queue that channel on every
 *    attempt. `(tenant_id, playbook_id, idempotency_key)` is unique now.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { and, eq } from 'drizzle-orm';
import type { Logger } from 'winston';

import type { Db } from '../../db/index.js';
import { outreachEvents, playbookRuns } from '../../db/schema.js';
import type { Priority } from '../../domain/index.js';
import { metricsRegistry, promClient } from '../../platform/observability/metrics.js';
import type { TenantScope } from '../../platform/db/tenant-scope.js';
import type { ChannelType, ContactPoint, RenderedMessage } from '../../ports/channel.js';
import { toChannelType } from '../../ports/channel.js';
import type { ContextRef } from '../../ports/context-provider.js';
import type { TemplateStore } from '../../ports/template-store.js';
import type { ApprovalService } from '../approvals/approval.service.js';
import type { PolicyService } from '../approvals/policy.service.js';
import type { ContentGenerator } from '../content/generator.js';
import { emptyContext, type RenderContext } from '../content/render-context.js';
import type { Renderer } from '../content/renderer.js';
import type { ContextRegistry } from '../context/registry.js';
import type { Dispatcher } from '../delivery/dispatcher.js';
import type { PreferenceService } from '../compliance/preference.service.js';
import type { RecipientService } from '../recipients/recipient.service.js';
import type { PackRegistry } from '../../packs/loader.js';
import { readPath, type MatchedPlaybook, type Playbook, type PlaybookMatcher } from './matcher.js';
import type { OutreachTrigger, PlaybookRunResult } from './trigger.js';
import { validateContract, type DataContract } from './contract.js';

export const playbookRunsTotal = new promClient.Counter({
  name: 'outreach_playbook_runs_total',
  help: 'Playbook executions by outcome',
  labelNames: ['playbook', 'result', 'tenant'] as const,
  registers: [metricsRegistry],
});

/** `playbooks.content_source`. */
export type ContentSource =
  | { kind: 'template'; templateKey: string; subjectTemplateKey?: string }
  | { kind: 'ai'; promptPackKey: string; goal?: string }
  | { kind: 'hybrid'; templateKey: string; promptPackKey: string; slot: string; goal?: string };

/** One entry in `playbooks.channel_plan`. */
export interface ChannelPlanEntry {
  channel: ChannelType;
  /** Which contact-point type carries it. Defaults to the channel's own name. */
  contactPointType?: string;
  priority?: Priority;
  /** Reserved for P11's fallback chains; unused in P7. */
  fallbackAfterMs?: number;
  /** Overrides for this channel only, e.g. a shorter SMS template. */
  templateKey?: string;
  /** Slack channel, webhook URL — an address that is not a recipient's. */
  fixedTarget?: string;
}

export interface RuntimeDeps {
  db: Db;
  logger: Logger;
  matcher: PlaybookMatcher;
  recipients: RecipientService;
  context: ContextRegistry;
  templates: TemplateStore;
  renderer: Renderer;
  generator: ContentGenerator;
  approvals: ApprovalService;
  policies: PolicyService;
  dispatcher: Dispatcher;
  preferences: PreferenceService;
  packs: PackRegistry;
  /** Per-tenant pack config: emergency contacts, Slack channels, role members. */
  packConfig: (scope: TenantScope, packId: string) => Promise<Record<string, unknown>>;
}

export class PlaybookRuntime {
  constructor(private readonly deps: RuntimeDeps) {}

  /**
   * Run every playbook a trigger matches. One trigger may fire several, and one
   * failing must not stop the others — the source's `Promise.all` in
   * `queueNotifications` (:90) rejects the whole batch on the first failure.
   */
  async run(trigger: OutreachTrigger): Promise<PlaybookRunResult[]> {
    const scope: TenantScope = {
      tenantId: trigger.tenantId,
      ...(trigger.subTenantId ? { subTenantId: trigger.subTenantId } : {}),
    };

    const matched = await this.deps.matcher.match(trigger);

    if (matched.length === 0) {
      // The source logs `Unknown event type` and returns false. 27 of its 44
      // enum values reach exactly this branch. Recording it makes "why did
      // nothing happen?" answerable without log archaeology.
      this.deps.logger.info('no playbook matched this trigger', {
        eventType: trigger.eventType,
        type: trigger.type,
        tenantId: trigger.tenantId,
        correlationId: trigger.correlationId,
      });
      await this.recordEvent(scope, trigger, 'UNMATCHED');
      return [];
    }

    const eventId = await this.recordEvent(scope, trigger, 'PROCESSING');
    const results: PlaybookRunResult[] = [];

    for (const candidate of matched) {
      results.push(await this.runOne(scope, trigger, candidate, eventId));
    }

    await this.deps.db
      .update(outreachEvents)
      .set({ status: 'PROCESSED', processedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(outreachEvents.tenantId, scope.tenantId), eq(outreachEvents.id, eventId)));

    return results;
  }

  private async runOne(
    scope: TenantScope,
    trigger: OutreachTrigger,
    matched: MatchedPlaybook,
    eventId: string,
  ): Promise<PlaybookRunResult> {
    const { playbook } = matched;
    const started = new Date();

    const finish = async (
      result: Omit<PlaybookRunResult, 'playbookId' | 'playbookKey'>,
    ): Promise<PlaybookRunResult> => {
      const full: PlaybookRunResult = {
        playbookId: playbook.id,
        playbookKey: playbook.key,
        ...result,
      };
      playbookRunsTotal.inc({
        playbook: playbook.key,
        result: full.status,
        tenant: scope.tenantId,
      });
      await this.recordRun(scope, trigger, playbook, full, started);
      return full;
    };

    try {
      // ── idempotency ───────────────────────────────────────────────────────
      const existing = await this.priorRun(scope, playbook.id, trigger.idempotencyKey);
      if (existing) {
        this.deps.logger.info('playbook already ran for this idempotency key — skipping', {
          playbookKey: playbook.key,
          idempotencyKey: trigger.idempotencyKey,
          priorRunId: existing.id,
          priorStatus: existing.status,
        });
        return {
          playbookId: playbook.id,
          playbookKey: playbook.key,
          status: 'SKIPPED',
          reason: `already ran (${existing.status})`,
          runId: existing.id,
          messageIds: existing.messageIds ?? [],
          approvalIds: [],
        };
      }

      // ── 1. recipient ──────────────────────────────────────────────────────
      const recipient = await this.resolveRecipient(scope, trigger);

      // ── 2. context ────────────────────────────────────────────────────────
      const context = await this.resolveContext(scope, trigger);

      // ── 3. data contract ──────────────────────────────────────────────────
      // Before anything expensive: no LLM call, no template lookup, no send.
      const contract = playbook.dataContract as DataContract | null;
      const validation = validateContract(contract, context);
      if (!validation.ok) {
        return finish({
          status: 'FAILED',
          reason: 'context does not satisfy the playbook data contract',
          contractErrors: validation.errors,
          messageIds: [],
          approvalIds: [],
        });
      }

      // ── 4. channels ───────────────────────────────────────────────────────
      const plan = (playbook.channelPlan ?? []) as ChannelPlanEntry[];
      const targets = await this.resolveChannels(scope, plan, trigger, recipient, playbook);

      if (targets.length === 0) {
        return finish({
          status: 'SKIPPED',
          reason: 'no channel in the plan has a reachable contact point for this recipient',
          messageIds: [],
          approvalIds: [],
        });
      }

      // ── 5–7. content, approval, dispatch — per channel ────────────────────
      const messageIds: string[] = [];
      const approvalIds: string[] = [];
      const statuses: PlaybookRunResult['status'][] = [];

      for (const target of targets) {
        const outcome = await this.deliverOne(scope, trigger, playbook, target, {
          recipient,
          context: validation.context,
          eventId,
        });
        if (outcome.messageId) messageIds.push(outcome.messageId);
        if (outcome.approvalId) approvalIds.push(outcome.approvalId);
        statuses.push(outcome.status);
      }

      return finish({
        status: rollUp(statuses),
        messageIds,
        approvalIds,
        reason: statuses.every((s) => s === 'SUPPRESSED') ? 'suppressed by compliance' : undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logger.error('playbook run failed', {
        playbookKey: playbook.key,
        tenantId: scope.tenantId,
        correlationId: trigger.correlationId,
        error: message,
      });
      return finish({ status: 'FAILED', reason: message, messageIds: [], approvalIds: [] });
    }
  }

  // ── steps ─────────────────────────────────────────────────────────────────

  /**
   * `payload.recipientId` / `trigger.recipientId` for a recipient we already
   * own, or `payload.recipient` as a `ContextRef` resolved through the P5
   * registry — which is pack-gated, so a tenant without the medspa pack cannot
   * reach patient-service by crafting a ref (D37).
   *
   * A staff-directed playbook has no recipient at all. That is legitimate, and
   * it is the case that proves `messages.recipient_id` had to become nullable:
   * `handleStaffAlert` and `handleEmergencyNotification` address staff, never a
   * patient.
   */
  private async resolveRecipient(scope: TenantScope, trigger: OutreachTrigger) {
    const id = trigger.recipientId ?? (trigger.payload.recipientId as string | undefined);
    if (id) return this.deps.recipients.getById(scope, id);

    const ref = trigger.payload.recipient as ContextRef | undefined;
    if (ref?.kind) return this.deps.recipients.getOrResolve(scope, ref);

    return null;
  }

  /**
   * Inline `payload.context` is the default path; `payload.contextRef` fetches
   * through the registry. Inline wins when both are present — an explicit value
   * from the caller should never be silently overwritten by a lookup.
   */
  private async resolveContext(
    scope: TenantScope,
    trigger: OutreachTrigger,
  ): Promise<Record<string, unknown>> {
    const inline = (trigger.payload.context ?? {}) as Record<string, unknown>;
    const ref = trigger.payload.contextRef as ContextRef | undefined;

    if (!ref?.kind) return inline;

    const fetched = await this.deps.context.fetch(ref, scope);
    return { ...fetched, ...inline };
  }

  /**
   * Which channels actually fire.
   *
   * `channel_plan` is the playbook's *supported* set; `trigger.channels` is what
   * the caller asked for. The source intersects these on every case
   * (`if (event.channels.includes(EMAIL))`), so the caller has always had the
   * final say — D54. A trigger naming no channels takes the whole plan.
   *
   * A channel is then dropped if the recipient has no contact point for it.
   * Silently skipping a channel the recipient cannot receive is what the source
   * did by passing `undefined` as `to` and letting the adapter fail later.
   */
  private async resolveChannels(
    scope: TenantScope,
    plan: ChannelPlanEntry[],
    trigger: OutreachTrigger,
    recipient: Awaited<ReturnType<RecipientService['getById']>>,
    playbook: Playbook,
  ): Promise<{ entry: ChannelPlanEntry; to: ContactPoint }[]> {
    const requested = trigger.channels?.length
      ? new Set(trigger.channels.map((c) => toChannelType(c) ?? c))
      : null;

    // Channels the playbook sends regardless of what the caller asked for.
    // `handleEmergencyNotification` posts its Slack alert outside any
    // `event.channels` check (:533) — an emergency a caller could silence by
    // omitting a channel would be a bad design, and preserving that is not the
    // same as preserving a hardcoded channel name.
    const metadata = (playbook.metadata ?? {}) as { alwaysSendChannels?: string[] };
    const always = new Set(metadata.alwaysSendChannels ?? []);

    const contactPoints = (recipient?.contactPoints ?? []) as ContactPoint[];
    const targets: { entry: ChannelPlanEntry; to: ContactPoint }[] = [];

    // Only read the tenant's config when the plan actually references it.
    const needsConfig = plan.some((e) => e.fixedTarget?.startsWith('$config.'));
    const config =
      needsConfig && playbook.packId
        ? await this.deps.packConfig(scope, playbook.packId)
        : {};

    for (const entry of plan) {
      const channel = toChannelType(entry.channel);
      if (!channel) {
        this.deps.logger.warn('playbook channel plan names an unknown channel', {
          channel: entry.channel,
        });
        continue;
      }
      if (requested && !requested.has(channel) && !always.has(channel)) continue;

      // A fixed target is an address that is not a recipient's — a Slack
      // channel, an ops mailbox. This is where `to: 'emergency-team@medspa.com'`
      // (:549) and the three hardcoded Slack channel names now come from: the
      // tenant's own config, never a literal in code (D55).
      if (entry.fixedTarget) {
        const values = this.resolveFixedTarget(entry.fixedTarget, config, playbook.key);
        if (values.length === 0) {
          this.deps.logger.error(
            'playbook needs a fixed target the tenant has not configured — channel skipped',
            { playbookKey: playbook.key, channel, target: entry.fixedTarget, tenantId: scope.tenantId },
          );
          continue;
        }
        // A config key may hold several addresses; each is its own message.
        for (const value of values) {
          targets.push({ entry, to: { type: entry.contactPointType ?? channel, value } });
        }
        continue;
      }

      const wanted = entry.contactPointType ?? channel;
      const point =
        contactPoints.find((p) => p.type === wanted && p.primary) ??
        contactPoints.find((p) => p.type === wanted);

      if (!point?.value) {
        this.deps.logger.debug('skipping a planned channel — no contact point', {
          channel,
          recipientId: recipient?.id,
        });
        continue;
      }
      targets.push({ entry, to: point });
    }

    // Opt-outs are the compliance gate's job, downstream of here — this filter
    // is only about reachability. Checking preferences twice would risk the two
    // answers diverging, and the gate is the one that writes the audit row.
    return targets;
  }

  /**
   * `$config.slackChannels.staffAlerts` → the tenant's own value. A literal
   * that does not start with `$config.` is used as-is, which keeps a
   * single-tenant pack readable without forcing indirection on everything.
   */
  private resolveFixedTarget(
    target: string,
    config: Record<string, unknown>,
    playbookKey: string,
  ): string[] {
    if (!target.startsWith('$config.')) return [target];

    const value = readPath(config, target.slice('$config.'.length));

    if (Array.isArray(value)) return value.map(String).filter(Boolean);
    if (typeof value === 'string' && value.trim()) return [value];

    void playbookKey;
    return [];
  }

  /** Content → approval → dispatch, for one channel. */
  private async deliverOne(
    scope: TenantScope,
    trigger: OutreachTrigger,
    playbook: Playbook,
    target: { entry: ChannelPlanEntry; to: ContactPoint },
    input: {
      recipient: Awaited<ReturnType<RecipientService['getById']>>;
      context: Record<string, unknown>;
      eventId: string;
    },
  ): Promise<{ status: PlaybookRunResult['status']; messageId?: string; approvalId?: string }> {
    const channel = toChannelType(target.entry.channel) as ChannelType;
    const priority = trigger.priority ?? target.entry.priority ?? 'MEDIUM';

    const renderContext = this.buildContext(scope, playbook, channel, input);
    const source = (playbook.contentSource ?? {}) as ContentSource;

    const { rendered, aiConfidence, lintErrors } = await this.produceContent(
      scope,
      playbook,
      source,
      target.entry,
      channel,
      renderContext,
    );

    const throttle = (playbook.throttle ?? {}) as {
      maxPerRecipientPerDay?: number;
      cooldownHours?: number;
    };

    // A template-rendered message is transactional and goes straight out; an
    // AI-written one waits for a human. That split is carried by the playbook's
    // `approval_policy_id`, seeded by content source (D53) — the runtime does
    // not decide it, it just honours whatever policy the playbook names.
    //
    // `mode: 'none'` is the exception, and it is skipped entirely rather than
    // submitted-and-auto-approved. Going through `submit()` would write an
    // `approvals` row per transactional message — an appointment-reminder-heavy
    // tenant would grow the approvals table at the same rate as `messages`,
    // every row AUTO_APPROVED, none of them actionable by anybody. `sample` and
    // `threshold` still go through submit: there the auto-approval is a real
    // decision about a specific message, and recording it is the point.
    const policy = playbook.approvalPolicyId
      ? await this.deps.policies.load(scope, { policyId: playbook.approvalPolicyId })
      : null;

    if (policy && policy.mode !== 'none') {
      const submitted = await this.deps.approvals.submit(
        scope,
        {
          channel,
          to: target.to,
          rendered,
          priority,
          recipientId: input.recipient?.id,
          senderId: trigger.senderId ?? (trigger.payload.senderId as string | undefined),
          playbookId: playbook.id,
          playbookKey: playbook.key,
          aiGenerated: source.kind !== 'template',
          aiConfidence,
          lintErrors,
          correlationId: trigger.correlationId,
          throttle,
        },
        { policyId: policy.id },
      );

      // `submit` dispatches by itself when the policy auto-approves, so there is
      // nothing more to do on either branch.
      return {
        status:
          submitted.decision.kind === 'auto'
            ? dispatchStatus(submitted.dispatch)
            : 'PENDING_APPROVAL',
        messageId: submitted.approval.messageId,
        approvalId: submitted.approval.id,
      };
    }

    const dispatched = await this.deps.dispatcher.dispatch({
      tenantId: scope.tenantId,
      subTenantId: scope.subTenantId,
      channel,
      to: target.to,
      rendered,
      priority,
      recipientId: input.recipient?.id,
      senderId: trigger.senderId ?? (trigger.payload.senderId as string | undefined),
      playbookId: playbook.id,
      playbookKey: playbook.key,
      aiGenerated: source.kind !== 'template',
      correlationId: trigger.correlationId,
      throttle,
    });

    return { status: dispatchStatus(dispatched), messageId: dispatched.messageId };
  }

  /** template · ai · hybrid. */
  private async produceContent(
    scope: TenantScope,
    playbook: Playbook,
    source: ContentSource,
    entry: ChannelPlanEntry,
    channel: ChannelType,
    context: RenderContext,
  ): Promise<{ rendered: RenderedMessage; aiConfidence?: number; lintErrors?: number }> {
    const aliases = this.deps.renderer.aliasesFor(playbook.packId ?? undefined);

    if (source.kind === 'template' || source.kind === 'hybrid') {
      // `templates_tenant_key_unique` makes a key unique per TENANT, not per
      // (tenant, channel) — so an email body and a 160-character SMS are two
      // templates with two keys, and the channel plan entry names which. The
      // source achieved the same split by hand, building a different
      // `variables` object per channel inside every case.
      const key = entry.templateKey ?? source.templateKey;
      const template = await this.deps.templates.get(scope.tenantId, key);

      if (!template) {
        throw new Error(
          `Playbook '${playbook.key}' names template '${key}' for ${channel}, which does not exist for this tenant`,
        );
      }

      if (source.kind === 'template') {
        const body = await this.deps.renderer.render(template.content, context, {
          format: template.format as 'TEXT' | 'HTML' | 'MARKDOWN' | 'MJML',
          aliases,
        });
        const subject = template.subject
          ? await this.deps.renderer.render(template.subject, context, { format: 'TEXT', aliases })
          : undefined;

        return {
          rendered: {
            body: body.output,
            ...(subject ? { subject: subject.output } : {}),
            ...(template.format === 'MJML' || template.format === 'HTML'
              ? { html: body.output }
              : {}),
          },
        };
      }

      // hybrid: the model writes one slot, the template frames it.
      const draft = await this.generate(scope, playbook, source.promptPackKey, source.goal, channel, context);
      const framed = await this.deps.renderer.render(
        template.content,
        { ...context, context: { ...context.context, [source.slot]: draft.content } },
        { format: template.format as 'TEXT' | 'HTML' | 'MARKDOWN' | 'MJML', aliases },
      );

      return {
        rendered: {
          body: framed.output,
          ...(draft.subject ? { subject: draft.subject } : {}),
        },
        aiConfidence: draft.aiConfidence,
        lintErrors: draft.lintWarnings.length,
      };
    }

    const draft = await this.generate(scope, playbook, source.promptPackKey, source.goal, channel, context);
    return {
      rendered: { body: draft.content, ...(draft.subject ? { subject: draft.subject } : {}) },
      aiConfidence: draft.aiConfidence,
      lintErrors: draft.lintWarnings.length,
    };
  }

  private async generate(
    scope: TenantScope,
    playbook: Playbook,
    promptPackKey: string,
    goal: string | undefined,
    channel: ChannelType,
    context: RenderContext,
  ) {
    const pack = this.deps.packs.prompt(promptPackKey);
    if (!pack) {
      throw new Error(
        `Playbook '${playbook.key}' names prompt pack '${promptPackKey}', which is not installed`,
      );
    }

    return this.deps.generator.generate({
      tenantId: scope.tenantId,
      subTenantId: scope.subTenantId,
      pack,
      channel,
      playbookKey: playbook.key,
      playbookId: playbook.id,
      playbookGoal: goal,
      dataContract: (playbook.dataContract ?? undefined) as object | undefined,
      context,
    });
  }

  private buildContext(
    scope: TenantScope,
    playbook: Playbook,
    channel: ChannelType,
    input: {
      recipient: Awaited<ReturnType<RecipientService['getById']>>;
      context: Record<string, unknown>;
    },
  ): RenderContext {
    const base = emptyContext(scope.tenantId);
    const recipient = input.recipient;

    return {
      ...base,
      recipient: {
        ...base.recipient,
        ...(recipient
          ? {
              id: recipient.id,
              displayName: recipient.displayName ?? undefined,
              firstName: recipient.firstName ?? undefined,
              lastName: recipient.lastName ?? undefined,
              timezone: recipient.timezone ?? undefined,
              locale: recipient.locale ?? undefined,
              ...((recipient.attributes ?? {}) as Record<string, unknown>),
            }
          : {}),
      },
      context: input.context,
      message: { ...base.message, channel, playbookKey: playbook.key },
    };
  }

  // ── bookkeeping ───────────────────────────────────────────────────────────

  private async priorRun(
    scope: TenantScope,
    playbookId: string,
    idempotencyKey: string | undefined,
  ): Promise<{ id: string; status: string; messageIds: string[] } | null> {
    if (!idempotencyKey) return null;

    const [row] = await this.deps.db
      .select({
        id: playbookRuns.id,
        status: playbookRuns.status,
        messageIds: playbookRuns.messageIds,
      })
      .from(playbookRuns)
      .where(
        and(
          eq(playbookRuns.tenantId, scope.tenantId),
          eq(playbookRuns.playbookId, playbookId),
          eq(playbookRuns.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);

    return row ?? null;
  }

  private async recordRun(
    scope: TenantScope,
    trigger: OutreachTrigger,
    playbook: Playbook,
    result: PlaybookRunResult,
    startedAt: Date,
  ): Promise<void> {
    try {
      await this.deps.db
        .insert(playbookRuns)
        .values({
          tenantId: scope.tenantId,
          subTenantId: scope.subTenantId,
          playbookId: playbook.id,
          trigger: trigger as unknown as Record<string, unknown>,
          status: result.status,
          error: result.contractErrors?.join('; ') ?? result.reason,
          messageIds: result.messageIds,
          correlationId: trigger.correlationId,
          idempotencyKey: trigger.idempotencyKey,
          startedAt,
          finishedAt: new Date(),
        })
        // The partial unique index decides a concurrent redelivery race; the
        // loser writes nothing rather than failing a run that already sent.
        .onConflictDoNothing();
    } catch (error) {
      // A bookkeeping failure must not turn a successful send into a reported
      // failure — the message has already gone.
      this.deps.logger.error('failed to record a playbook run', {
        playbookKey: playbook.key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async recordEvent(
    scope: TenantScope,
    trigger: OutreachTrigger,
    status: string,
  ): Promise<string> {
    const [row] = await this.deps.db
      .insert(outreachEvents)
      .values({
        tenantId: scope.tenantId,
        subTenantId: scope.subTenantId,
        type: trigger.eventType ?? trigger.type,
        priority: trigger.priority ?? 'MEDIUM',
        status,
        data: trigger.payload,
        channels: (trigger.channels ?? []) as string[],
        recipientId: trigger.recipientId,
        senderId: trigger.senderId,
        triggerType: trigger.type,
        correlationId: trigger.correlationId,
        ...(status === 'UNMATCHED' ? { processedAt: new Date() } : {}),
      })
      .returning({ id: outreachEvents.id });

    if (!row) throw new Error('failed to record the outreach event');
    return row.id;
  }
}

/**
 * One status for a playbook that fanned out across channels.
 *
 * Worst-wins, so a run reporting SENT means every channel sent. A partial
 * failure that reported success is how a missing SMS goes unnoticed for a month.
 */
function rollUp(statuses: PlaybookRunResult['status'][]): PlaybookRunResult['status'] {
  const order: PlaybookRunResult['status'][] = [
    'FAILED',
    'SUPPRESSED',
    'SKIPPED',
    'PENDING_APPROVAL',
    'QUEUED',
    'SENT',
  ];
  for (const status of order) {
    if (statuses.includes(status)) return status;
  }
  return 'SKIPPED';
}

function dispatchStatus(
  result: { queued: boolean; skipped?: string } | undefined,
): PlaybookRunResult['status'] {
  if (!result) return 'SKIPPED';
  if (result.queued) return 'QUEUED';
  return result.skipped ? 'SUPPRESSED' : 'SKIPPED';
}

export type { Playbook };
