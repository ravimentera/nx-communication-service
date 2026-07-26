/**
 * The mandatory pre-delivery compliance gate. Fills the `// COMPLIANCE GATE (P5)`
 * hook left in `dispatcher.ts`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BLOCK vs DEFER
 *
 * A **block** means this message must never be sent. A **defer** means not yet —
 * the caller re-enqueues with a delay. Quiet hours and rate limits defer;
 * everything else blocks. Getting that distinction wrong in either direction is
 * expensive: blocking a deferrable message loses it silently, and deferring a
 * blockable one keeps retrying something the recipient asked us to stop.
 *
 * SHADOW MODE
 *
 * `COMPLIANCE_SHADOW_MODE=true` (the default) runs every check, records what it
 * *would* have done, and still allows the send. This is not timidity: the
 * source's preference engine is an in-memory Map that is empty after every
 * restart, so today's effective gate passes everything. Switching on a durable
 * gate is the single change most likely to silently stop messages that currently
 * ship. Watch `outreach_would_suppress_total` for a week per tenant before
 * enforcing.
 *
 * NOTHING IS EVER DROPPED SILENTLY. Every block and defer is returned with a
 * reason, counted, and written by the dispatcher as a `SUPPRESSED` message row.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import type { Logger } from 'winston';

import type { Db } from '../../db/index.js';
import {
  consentRecords,
  messages,
  recipients,
  tenantChannelConfigs,
  tenants,
} from '../../db/schema.js';
import type { Priority } from '../../domain/index.js';
import { metricsRegistry, promClient } from '../../platform/observability/metrics.js';
import type { TenantScope } from '../../platform/db/tenant-scope.js';
import type { ChannelType, RenderedMessage } from '../../ports/channel.js';
import type { PreferenceService } from './preference.service.js';

export const SUPPRESSION_REASONS = [
  'RECIPIENT_UNSUBSCRIBED',
  'RECIPIENT_BOUNCED',
  'RECIPIENT_DELETED',
  'COMMUNICATIONS_DISABLED',
  'CHANNEL_OPTED_OUT',
  'CONSENT_REQUIRED',
  'PLAYBOOK_OPTED_OUT',
  'QUIET_HOURS',
  'RATE_LIMITED',
  'THROTTLED',
] as const;

export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/** Reasons that mean "later", not "never". */
const DEFERRABLE: ReadonlySet<SuppressionReason> = new Set([
  'QUIET_HOURS',
  'RATE_LIMITED',
]);

export const suppressedTotal = new promClient.Counter({
  name: 'outreach_suppressed_total',
  help: 'Messages blocked or deferred by the compliance gate',
  labelNames: ['reason', 'channel', 'tenant', 'disposition'] as const,
  registers: [metricsRegistry],
});

export const wouldSuppressTotal = new promClient.Counter({
  name: 'outreach_would_suppress_total',
  help: 'Messages the gate would have suppressed, while running in shadow mode',
  labelNames: ['reason', 'channel', 'tenant'] as const,
  registers: [metricsRegistry],
});

export interface GateInput {
  scope: TenantScope;
  channel: ChannelType;
  priority: Priority;
  recipientId?: string;
  playbookKey?: string;
  /** A transactional message may bypass a global opt-out; marketing may not. */
  transactional?: boolean;
  throttle?: { maxPerRecipientPerDay?: number; cooldownHours?: number };
  rendered: RenderedMessage;
}

export type GateVerdict =
  | { allow: true; mutations?: Partial<RenderedMessage>; shadowed?: SuppressionReason }
  | { allow: false; reason: SuppressionReason; deferrable: boolean; retryAt?: Date };

export interface ComplianceGateDeps {
  db: Db;
  logger: Logger;
  preferences: PreferenceService;
  /** Evaluate everything, report, but still allow. Default true. */
  shadowMode: boolean;
  unsubscribeUrl: (scope: TenantScope, recipientId: string) => Promise<string>;
}

export class ComplianceGate {
  constructor(private readonly deps: ComplianceGateDeps) {}

  async check(input: GateInput): Promise<GateVerdict> {
    const blocked = await this.evaluate(input);

    if (!blocked) {
      return { allow: true, mutations: await this.mutations(input) };
    }

    const labels = {
      reason: blocked.reason,
      channel: input.channel,
      tenant: input.scope.tenantId,
    };

    if (this.deps.shadowMode) {
      wouldSuppressTotal.inc(labels);
      this.deps.logger.info('compliance gate (shadow) would have suppressed', {
        ...labels,
        recipientId: input.recipientId,
        playbookKey: input.playbookKey,
        deferrable: blocked.deferrable,
      });
      // Still send — and say so in the verdict, so the caller can record it.
      return { allow: true, mutations: await this.mutations(input), shadowed: blocked.reason };
    }

    suppressedTotal.inc({
      ...labels,
      disposition: blocked.deferrable ? 'deferred' : 'blocked',
    });
    this.deps.logger.info('compliance gate suppressed a message', {
      ...labels,
      recipientId: input.recipientId,
      deferrable: blocked.deferrable,
      retryAt: blocked.retryAt?.toISOString(),
    });
    return blocked;
  }

  /** The eight checks, in order, short-circuiting on the first that fires. */
  private async evaluate(
    input: GateInput,
  ): Promise<{ allow: false; reason: SuppressionReason; deferrable: boolean; retryAt?: Date } | null> {
    const { scope, recipientId } = input;

    const [recipient, tenantRow, tenantConfig] = await Promise.all([
      recipientId ? this.loadRecipient(scope, recipientId) : Promise.resolve(null),
      this.loadTenant(scope.tenantId),
      this.loadTenantConfig(scope.tenantId),
    ]);

    // 1 — recipient status
    if (recipient) {
      const byStatus: Partial<Record<string, SuppressionReason>> = {
        unsubscribed: 'RECIPIENT_UNSUBSCRIBED',
        bounced: 'RECIPIENT_BOUNCED',
        deleted: 'RECIPIENT_DELETED',
      };
      const reason = byStatus[recipient.status];
      if (reason) return this.block(reason);
    }

    const prefs = recipientId
      ? await this.deps.preferences.get(scope, recipientId)
      : null;

    // 2 — global opt-out. Urgent transactional messages may pass; an urgent
    //     marketing blast may not, which is why both conditions are required.
    if (prefs && !prefs.allowCommunications) {
      const exempt = input.priority === 'URGENT' && input.transactional === true;
      if (!exempt) return this.block('COMMUNICATIONS_DISABLED');
    }

    // 3 — per-channel preference, then consent when the tenant requires opt-in
    if (!this.deps.preferences.channelAllowed(prefs, input.channel)) {
      return this.block('CHANNEL_OPTED_OUT');
    }
    if (tenantConfig?.requireOptIn && recipientId) {
      const consented = await this.hasConsent(scope, recipientId, input.channel);
      if (!consented) return this.block('CONSENT_REQUIRED');
    }

    // 4 — per-playbook opt-out
    if (this.deps.preferences.hasOptedOutOf(prefs, input.playbookKey)) {
      return this.block('PLAYBOOK_OPTED_OUT');
    }

    // 5 — quiet hours: DEFER, never block. Urgent overrides, as in the source.
    if (input.priority !== 'URGENT') {
      const quiet = this.deps.preferences.quietHoursFor(
        prefs,
        recipient?.timezone ?? tenantRow?.timezone ?? undefined,
      );
      if (quiet.configured && quiet.inQuietHours) {
        return { allow: false, reason: 'QUIET_HOURS', deferrable: true, retryAt: quiet.endsAt };
      }
    }

    // 6 — tenant rate limits: DEFER
    const limit = this.rateLimitFor(tenantConfig, input.channel);
    if (limit && input.priority !== 'URGENT') {
      const exceeded = await this.rateLimitExceeded(scope, input.channel, limit);
      if (exceeded) {
        return {
          allow: false,
          reason: 'RATE_LIMITED',
          deferrable: true,
          retryAt: exceeded.retryAt,
        };
      }
    }

    // 7 — per-playbook throttle: BLOCK. A cooldown is a statement about how
    //     often this playbook may reach one person, not about capacity.
    if (recipientId && input.throttle) {
      const throttled = await this.throttleExceeded(scope, recipientId, input);
      if (throttled) return this.block('THROTTLED');
    }

    return null;
  }

  private block(reason: SuppressionReason) {
    return { allow: false as const, reason, deferrable: DEFERRABLE.has(reason) };
  }

  /** 8 — mutations applied to an allowed message. */
  private async mutations(input: GateInput): Promise<Partial<RenderedMessage> | undefined> {
    const changes: Partial<RenderedMessage> = {};

    // CAN-SPAM: bulk email must carry a working unsubscribe link.
    if (input.channel === 'email' && !input.transactional && input.recipientId) {
      const url = await this.deps.unsubscribeUrl(input.scope, input.recipientId);
      changes.metadata = { ...(input.rendered.metadata ?? {}), unsubscribeUrl: url };
      if (!input.rendered.body.includes(url)) {
        changes.body = `${input.rendered.body}\n\n—\nTo stop receiving these emails: ${url}`;
        if (input.rendered.html) {
          changes.html = `${input.rendered.html}<p style="font-size:12px;color:#888">To stop receiving these emails, <a href="${url}">unsubscribe</a>.</p>`;
        }
      }
    }

    return Object.keys(changes).length > 0 ? changes : undefined;
  }

  /**
   * A granted, un-revoked consent record for this channel.
   *
   * `tenant_channel_configs.require_opt_in` defaults to **true** and nothing in
   * the source reads it — so the column has claimed since day one that opt-in is
   * required while nothing enforced it. Enforcing it now is exactly why shadow
   * mode exists: the `consent_records` table is empty until P9 backfills it, so
   * enforcing on day one would block every message for every tenant.
   */
  private async hasConsent(
    scope: TenantScope,
    recipientId: string,
    channel: ChannelType,
  ): Promise<boolean> {
    const [row] = await this.deps.db
      .select({ granted: consentRecords.granted })
      .from(consentRecords)
      .where(
        and(
          eq(consentRecords.tenantId, scope.tenantId),
          eq(consentRecords.recipientId, recipientId),
          eq(consentRecords.channel, channel),
          eq(consentRecords.granted, true),
          isNull(consentRecords.revokedAt),
        ),
      )
      .limit(1);
    return Boolean(row?.granted);
  }

  private async loadRecipient(scope: TenantScope, id: string) {
    const [row] = await this.deps.db
      .select({ status: recipients.status, timezone: recipients.timezone })
      .from(recipients)
      .where(and(eq(recipients.tenantId, scope.tenantId), eq(recipients.id, id)))
      .limit(1);
    return row ?? null;
  }

  private async loadTenant(tenantId: string) {
    const [row] = await this.deps.db
      .select({ timezone: tenants.timezone, complianceProfile: tenants.complianceProfile })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    return row ?? null;
  }

  private async loadTenantConfig(tenantId: string) {
    const [row] = await this.deps.db
      .select({
        requireOptIn: tenantChannelConfigs.requireOptIn,
        smsRateLimit: tenantChannelConfigs.smsRateLimit,
        emailRateLimit: tenantChannelConfigs.emailRateLimit,
      })
      .from(tenantChannelConfigs)
      .where(eq(tenantChannelConfigs.tenantId, tenantId))
      .limit(1);
    return row ?? null;
  }

  private rateLimitFor(
    config: { smsRateLimit?: unknown; emailRateLimit?: unknown } | null,
    channel: ChannelType,
  ): { maxPerHour?: number; maxPerDay?: number } | null {
    if (!config) return null;
    const raw = channel === 'sms' ? config.smsRateLimit : channel === 'email' ? config.emailRateLimit : null;
    if (!raw || typeof raw !== 'object') return null;
    return raw as { maxPerHour?: number; maxPerDay?: number };
  }

  private async rateLimitExceeded(
    scope: TenantScope,
    channel: ChannelType,
    limit: { maxPerHour?: number; maxPerDay?: number },
  ): Promise<{ retryAt: Date } | null> {
    const now = Date.now();

    if (limit.maxPerHour) {
      const since = new Date(now - 60 * 60_000);
      const count = await this.countSent(scope, channel, since);
      if (count >= limit.maxPerHour) return { retryAt: new Date(now + 60 * 60_000) };
    }
    if (limit.maxPerDay) {
      const since = new Date(now - 24 * 60 * 60_000);
      const count = await this.countSent(scope, channel, since);
      if (count >= limit.maxPerDay) return { retryAt: new Date(now + 60 * 60_000) };
    }
    return null;
  }

  private async countSent(scope: TenantScope, channel: ChannelType, since: Date): Promise<number> {
    const [row] = await this.deps.db
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(
        and(
          eq(messages.tenantId, scope.tenantId),
          eq(messages.channel, channel),
          eq(messages.direction, 'outbound'),
          gte(messages.createdAt, since),
        ),
      );
    return row?.count ?? 0;
  }

  private async throttleExceeded(
    scope: TenantScope,
    recipientId: string,
    input: GateInput,
  ): Promise<boolean> {
    const { maxPerRecipientPerDay, cooldownHours } = input.throttle ?? {};

    if (maxPerRecipientPerDay) {
      const since = new Date(Date.now() - 24 * 60 * 60_000);
      const [row] = await this.deps.db
        .select({ count: sql<number>`count(*)::int` })
        .from(messages)
        .where(
          and(
            eq(messages.tenantId, scope.tenantId),
            eq(messages.recipientId, recipientId),
            eq(messages.direction, 'outbound'),
            gte(messages.createdAt, since),
          ),
        );
      if ((row?.count ?? 0) >= maxPerRecipientPerDay) return true;
    }

    if (cooldownHours && input.playbookKey) {
      const since = new Date(Date.now() - cooldownHours * 60 * 60_000);
      const [row] = await this.deps.db
        .select({ count: sql<number>`count(*)::int` })
        .from(messages)
        .where(
          and(
            eq(messages.tenantId, scope.tenantId),
            eq(messages.recipientId, recipientId),
            eq(messages.direction, 'outbound'),
            gte(messages.createdAt, since),
            sql`${messages.metadata}->>'playbookKey' = ${input.playbookKey}`,
          ),
        );
      if ((row?.count ?? 0) > 0) return true;
    }

    return false;
  }
}
