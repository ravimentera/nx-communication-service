/**
 * Consent: the record that says a recipient agreed to be contacted on a channel.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS DID NOT EXIST, AND WHY THAT WAS A SHIPPING BLOCKER
 *
 * P5 built the read side — `ComplianceGate.hasConsent()` — and left the write
 * side to "P9 backfills it", which is a comment in `gate.ts` and was never a
 * phase's deliverable. So `consent_records` had a SELECT and no INSERT anywhere
 * in the service.
 *
 * That is not a missing feature, it is a gate that cannot be switched on.
 * `tenant_channel_configs.require_opt_in` is `NOT NULL DEFAULT true`, so the
 * first operator to set `COMPLIANCE_SHADOW_MODE=false` would have blocked
 * essentially every send in the system with `CONSENT_REQUIRED` — and had no API
 * with which to unblock a single one of them. Shadow mode was hiding an empty
 * table, not a staged rollout.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE ROW PER (RECIPIENT, CHANNEL), AND WHY IT MUST BE UNIQUE
 *
 * The gate asks "is there a granted, un-revoked row for this channel?". With
 * repeated grants appending rows, a revocation could only revoke the row it
 * found, and an older granted row would answer the gate's question `true` for
 * ever after. Revocation has to win, and the only way it reliably wins is if
 * there is exactly one row to revoke.
 *
 * `0015` adds `UNIQUE (tenant_id, recipient_id, channel)` and every write here
 * is an upsert onto it. Re-granting an existing consent updates the proof and
 * clears `revoked_at`; that is a real event and the timestamps record it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PROOF IS NOT OPTIONAL DECORATION
 *
 * `source` and `grantedAt` are required on the way in. A consent record with no
 * account of where it came from is not evidence of anything, and the moment
 * anyone has to answer a regulator — or a recipient asking why they are being
 * texted — an unattributed row is worse than no row, because it looks like an
 * answer.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Logger } from 'winston';

import type { Db } from '../../db/index.js';
import { consentRecords, recipients } from '../../db/schema.js';
import type { TenantScope } from '../../platform/db/tenant-scope.js';
import { NotFoundError, ValidationError } from '../../platform/http/errors.js';
import { normalizeChannel, CHANNEL_TYPES, type ChannelType } from '../../ports/channel.js';

/**
 * Where a consent came from. Not a free string: "how do you know they agreed?"
 * has a small number of real answers, and a typo'd one is unauditable.
 */
export const CONSENT_SOURCES = [
  'signup_form',
  'double_optin',
  'import',
  'verbal',
  'paper',
  'api',
] as const;

export type ConsentSource = (typeof CONSENT_SOURCES)[number];

export interface ConsentRecord {
  id: string;
  recipientId: string;
  channel: string;
  granted: boolean;
  source: string | null;
  proof: unknown;
  grantedAt: Date | null;
  revokedAt: Date | null;
}

export interface GrantInput {
  channels: ChannelType[];
  source: ConsentSource;
  /** When they agreed — not when this call was made. An import carries a past date. */
  grantedAt?: Date;
  /** Whatever proves it: form payload, IP, user agent, recording ref, paper scan id. */
  proof?: Record<string, unknown>;
}

export interface ConsentServiceDeps {
  db: Db;
  logger: Logger;
}

export class ConsentService {
  constructor(private readonly deps: ConsentServiceDeps) {}

  /**
   * Record consent for one or more channels.
   *
   * Idempotent per channel: granting twice updates the proof rather than
   * stacking rows the gate would then have to reason about.
   */
  async grant(
    scope: TenantScope,
    recipientId: string,
    input: GrantInput,
  ): Promise<ConsentRecord[]> {
    const channels = this.normalizeChannels(input.channels);
    await this.requireRecipient(scope, recipientId);

    const grantedAt = input.grantedAt ?? new Date();
    if (grantedAt.getTime() > Date.now() + 60_000) {
      // A consent that has not happened yet is not consent. The minute of slack
      // is for clock skew between the caller and this service.
      throw new ValidationError('grantedAt cannot be in the future');
    }

    const rows = await this.deps.db
      .insert(consentRecords)
      .values(
        channels.map((channel) => ({
          tenantId: scope.tenantId,
          subTenantId: scope.subTenantId ?? null,
          recipientId,
          channel,
          granted: true,
          source: input.source,
          proof: input.proof ?? null,
          grantedAt,
          revokedAt: null,
        })),
      )
      .onConflictDoUpdate({
        target: [consentRecords.tenantId, consentRecords.recipientId, consentRecords.channel],
        set: {
          granted: true,
          source: sqlExcluded('source'),
          proof: sqlExcluded('proof'),
          grantedAt: sqlExcluded('granted_at'),
          // Re-granting clears a previous revocation. Somebody opting back in
          // is a thing that happens, and the audit answer lives in the source
          // and proof this call carried, not in a stale revoked_at.
          revokedAt: null,
          updatedAt: new Date(),
        },
      })
      .returning();

    this.deps.logger.info('consent granted', {
      tenantId: scope.tenantId,
      recipientId,
      channels,
      source: input.source,
    });

    return rows.map(toRecord);
  }

  /**
   * Withdraw consent. Never deletes: the record that somebody once agreed, and
   * then withdrew, is the whole audit trail. `revoked_at` is what the gate reads.
   *
   * Naming no channels revokes every one — which is what an unsubscribe means.
   */
  async revoke(
    scope: TenantScope,
    recipientId: string,
    channels?: ChannelType[],
    reason?: string,
  ): Promise<ConsentRecord[]> {
    const clauses = [
      eq(consentRecords.tenantId, scope.tenantId),
      eq(consentRecords.recipientId, recipientId),
      isNull(consentRecords.revokedAt),
    ];
    if (channels?.length) {
      clauses.push(inArray(consentRecords.channel, this.normalizeChannels(channels)));
    }

    const rows = await this.deps.db
      .update(consentRecords)
      .set({ granted: false, revokedAt: new Date(), updatedAt: new Date() })
      .where(and(...clauses))
      .returning();

    if (rows.length > 0) {
      this.deps.logger.info('consent revoked', {
        tenantId: scope.tenantId,
        recipientId,
        channels: rows.map((r) => r.channel),
        reason,
      });
    }

    return rows.map(toRecord);
  }

  async list(scope: TenantScope, recipientId: string): Promise<ConsentRecord[]> {
    const rows = await this.deps.db
      .select()
      .from(consentRecords)
      .where(
        and(
          eq(consentRecords.tenantId, scope.tenantId),
          eq(consentRecords.recipientId, recipientId),
        ),
      )
      .orderBy(desc(consentRecords.updatedAt));
    return rows.map(toRecord);
  }

  /**
   * Capture consent for a batch of imported recipients, in one statement.
   *
   * An import is the one path where consent arrives for thousands of people at
   * once, and it is also the one where a caller is most likely to assert it
   * without evidence. The importer has to pass `source` and `grantedAt`
   * explicitly; there is no default, because "they were in the spreadsheet" is
   * not a lawful basis and a default would make it look like one.
   */
  async captureImported(
    scope: TenantScope,
    recipientIds: string[],
    input: GrantInput,
  ): Promise<number> {
    if (recipientIds.length === 0) return 0;
    const channels = this.normalizeChannels(input.channels);
    const grantedAt = input.grantedAt ?? new Date();

    let written = 0;
    // Chunked for the same reason the audience expander is: one statement per
    // 500 rows keeps a 100k import off the far end of a parameter limit.
    for (let i = 0; i < recipientIds.length; i += 500) {
      const chunk = recipientIds.slice(i, i + 500);
      const rows = await this.deps.db
        .insert(consentRecords)
        .values(
          chunk.flatMap((recipientId) =>
            channels.map((channel) => ({
              tenantId: scope.tenantId,
              subTenantId: scope.subTenantId ?? null,
              recipientId,
              channel,
              granted: true,
              source: input.source,
              proof: input.proof ?? null,
              grantedAt,
              revokedAt: null,
            })),
          ),
        )
        // An import must never resurrect a consent somebody withdrew. Unlike
        // `grant()` — which is an explicit, attributable act about one person —
        // a bulk file is not evidence that a past revocation was reconsidered.
        .onConflictDoNothing({
          target: [consentRecords.tenantId, consentRecords.recipientId, consentRecords.channel],
        })
        .returning({ id: consentRecords.id });
      written += rows.length;
    }

    this.deps.logger.info('consent captured from an import', {
      tenantId: scope.tenantId,
      recipients: recipientIds.length,
      written,
      source: input.source,
    });
    return written;
  }

  private normalizeChannels(channels: ChannelType[]): string[] {
    if (!channels?.length) throw new ValidationError('At least one channel is required');
    const normalized = channels.map((c) => normalizeChannel(c));
    const unknown = normalized.filter((c) => !CHANNEL_TYPES.includes(c as ChannelType));
    if (unknown.length > 0) {
      throw new ValidationError(`Unknown channel(s): ${unknown.join(', ')}`, {
        allowed: CHANNEL_TYPES,
      });
    }
    return [...new Set(normalized)];
  }

  private async requireRecipient(scope: TenantScope, recipientId: string): Promise<void> {
    const [row] = await this.deps.db
      .select({ id: recipients.id })
      .from(recipients)
      .where(and(eq(recipients.tenantId, scope.tenantId), eq(recipients.id, recipientId)))
      .limit(1);
    if (!row) throw new NotFoundError(`Recipient '${recipientId}' not found for this tenant`);
  }
}

/**
 * `excluded.<column>` — the row the INSERT tried to write, seen from inside
 * DO UPDATE. Drizzle has no helper for it, and the raw reference reads better
 * than aliasing the table a second time.
 */
function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`);
}

function toRecord(row: typeof consentRecords.$inferSelect): ConsentRecord {
  return {
    id: row.id,
    recipientId: row.recipientId,
    channel: row.channel,
    granted: row.granted,
    source: row.source,
    proof: row.proof,
    grantedAt: row.grantedAt,
    revokedAt: row.revokedAt,
  };
}
