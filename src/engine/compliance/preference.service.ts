/**
 * Recipient preferences, backed by `recipient_preferences`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SINGLE MOST IMPORTANT CHANGE IN P5:
 *
 *   preference.service.ts:30
 *     private userPreferences: Map<string, UserPreferences> = new Map();
 *
 * The preference engine is **in memory**. The `communication_preferences` table
 * exists and the engine never reads it. Every opt-out, every quiet-hours
 * setting, every unsubscribe is lost on restart — so in practice the service
 * boots believing nobody has ever opted out of anything.
 *
 * That Map is deleted. Everything reads and writes the table.
 *
 * It is also why the compliance gate ships in shadow mode: turning on a real,
 * durable, DB-backed gate is the change most likely to stop messages that ship
 * today, because today's gate is empty after every deploy.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { randomBytes } from 'node:crypto';

import { and, eq, isNull } from 'drizzle-orm';
import type { Logger } from 'winston';

import type { Db } from '../../db/index.js';
import { consentRecords, recipientPreferences } from '../../db/schema.js';
import type { TenantScope } from '../../platform/db/tenant-scope.js';
import { tenantWhere } from '../../platform/db/tenant-scope.js';
import { NotFoundError } from '../../platform/http/errors.js';
import { evaluateQuietHours, type QuietHoursVerdict } from './quiet-hours.js';

export type RecipientPreference = typeof recipientPreferences.$inferSelect;

export interface PreferencePatch {
  allowCommunications?: boolean;
  preferredChannels?: string[];
  preferredLanguage?: string;
  preferredFrequency?: string;
  preferredTimeOfDay?: string;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
  quietHoursTimezone?: string | null;
  eventOptOuts?: string[];
  updatedBy?: string;
}

export interface PreferenceServiceDeps {
  db: Db;
  logger: Logger;
  /** Used when a recipient has no timezone of their own. */
  defaultTimezone: string;
  /**
   * `ENFORCE_QUIET_HOURS`. Read by nothing until P13, when the flag had been in
   * the config schema for six phases with no consumer — so a deployment that
   * set it to `false` got quiet hours anyway, and one that assumed it was doing
   * something was wrong in the other direction.
   *
   * Defaults true, which is the behaviour every deployment already had.
   */
  enforceQuietHours?: boolean;
  unsubscribeBaseUrl: string;
}

export class PreferenceService {
  private readonly deps: PreferenceServiceDeps & { enforceQuietHours: boolean };

  constructor(deps: PreferenceServiceDeps) {
    // Default true: it is what every deployment had while the flag was unread.
    this.deps = { enforceQuietHours: true, ...deps };
  }

  async get(scope: TenantScope, recipientId: string): Promise<RecipientPreference | null> {
    const [row] = await this.deps.db
      .select()
      .from(recipientPreferences)
      .where(
        and(
          tenantWhere(recipientPreferences, scope),
          eq(recipientPreferences.recipientId, recipientId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** Creates the row on first write — callers should not have to check. */
  async upsert(
    scope: TenantScope,
    recipientId: string,
    patch: PreferencePatch,
  ): Promise<RecipientPreference> {
    const [row] = await this.deps.db
      .insert(recipientPreferences)
      .values({
        tenantId: scope.tenantId,
        subTenantId: scope.subTenantId ?? null,
        recipientId,
        allowCommunications: patch.allowCommunications ?? true,
        preferredChannels: patch.preferredChannels,
        preferredLanguage: patch.preferredLanguage,
        preferredFrequency: patch.preferredFrequency ?? 'MODERATE',
        preferredTimeOfDay: patch.preferredTimeOfDay,
        quietHoursStart: patch.quietHoursStart ?? null,
        quietHoursEnd: patch.quietHoursEnd ?? null,
        quietHoursTimezone: patch.quietHoursTimezone ?? null,
        ...(patch.eventOptOuts ? { eventOptOuts: patch.eventOptOuts } : {}),
        unsubscribeToken: randomBytes(24).toString('base64url'),
        updatedBy: patch.updatedBy,
      })
      .onConflictDoUpdate({
        target: [recipientPreferences.tenantId, recipientPreferences.recipientId],
        set: {
          ...(patch.allowCommunications !== undefined
            ? { allowCommunications: patch.allowCommunications }
            : {}),
          ...(patch.preferredChannels !== undefined
            ? { preferredChannels: patch.preferredChannels }
            : {}),
          ...(patch.preferredLanguage !== undefined
            ? { preferredLanguage: patch.preferredLanguage }
            : {}),
          ...(patch.preferredFrequency !== undefined
            ? { preferredFrequency: patch.preferredFrequency }
            : {}),
          ...(patch.preferredTimeOfDay !== undefined
            ? { preferredTimeOfDay: patch.preferredTimeOfDay }
            : {}),
          ...(patch.quietHoursStart !== undefined
            ? { quietHoursStart: patch.quietHoursStart }
            : {}),
          ...(patch.quietHoursEnd !== undefined ? { quietHoursEnd: patch.quietHoursEnd } : {}),
          ...(patch.quietHoursTimezone !== undefined
            ? { quietHoursTimezone: patch.quietHoursTimezone }
            : {}),
          ...(patch.eventOptOuts !== undefined ? { eventOptOuts: patch.eventOptOuts } : {}),
          updatedBy: patch.updatedBy,
          updatedAt: new Date(),
        },
      })
      .returning();

    if (!row) throw new Error('preference upsert returned no row');
    return row;
  }

  /**
   * Global opt-out. Also flips the recipient's status — see `RecipientService`.
   *
   * And revokes their consent records, which is not belt-and-braces: the two
   * are read by different checks in the gate. `allowCommunications: false`
   * fails check 2; `hasConsent()` in check 3 reads `consent_records` and knows
   * nothing about preferences. A tenant with `require_opt_in` set would have
   * had an unsubscribed recipient still holding a granted consent row —
   * harmless while check 2 fires first, and a live opt-out bypass the moment
   * anything grants an exemption to it. An unsubscribe means withdrawn, in
   * every place the answer is recorded.
   */
  async unsubscribe(
    scope: TenantScope,
    recipientId: string,
    reason?: string,
  ): Promise<RecipientPreference> {
    const row = await this.upsert(scope, recipientId, { allowCommunications: false });
    await this.revokeConsent(scope, recipientId, reason ?? 'unsubscribed');
    this.deps.logger.info('recipient unsubscribed', {
      tenantId: scope.tenantId,
      recipientId,
      reason,
    });
    return row;
  }

  /**
   * Withdraw every consent this recipient holds.
   *
   * Written here rather than delegating to `ConsentService` because the
   * preference service is constructed long before it in the composition root
   * and injecting it would make a cycle. It is one guarded UPDATE, and the
   * service's own `revoke()` is the same statement.
   */
  private async revokeConsent(
    scope: TenantScope,
    recipientId: string,
    reason: string,
  ): Promise<void> {
    try {
      const rows = await this.deps.db
        .update(consentRecords)
        .set({ granted: false, revokedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(consentRecords.tenantId, scope.tenantId),
            eq(consentRecords.recipientId, recipientId),
            isNull(consentRecords.revokedAt),
          ),
        )
        .returning({ channel: consentRecords.channel });

      if (rows.length > 0) {
        this.deps.logger.info('consent revoked by unsubscribe', {
          tenantId: scope.tenantId,
          recipientId,
          channels: rows.map((r) => r.channel),
          reason,
        });
      }
    } catch (error) {
      // The opt-out itself has already been written and is what the gate reads
      // first. Failing the whole unsubscribe because the consent side errored
      // would leave the caller believing nothing happened, and retrying an
      // unsubscribe is not something a recipient can be asked to do.
      this.deps.logger.error('could not revoke consent during unsubscribe', {
        tenantId: scope.tenantId,
        recipientId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Token-based unsubscribe. The token is the only credential — the endpoint is
   * reached from a link in an email and cannot carry gateway headers, which is
   * why it is unauthenticated and rate-limited at the route.
   *
   * Deliberately NOT tenant-scoped: the token is globally unique and the caller
   * has no tenant context. That is why it is 24 random bytes rather than
   * anything guessable.
   */
  async unsubscribeByToken(token: string): Promise<{ tenantId: string; recipientId: string }> {
    const [row] = await this.deps.db
      .update(recipientPreferences)
      .set({ allowCommunications: false, updatedAt: new Date(), updatedBy: 'unsubscribe-link' })
      .where(eq(recipientPreferences.unsubscribeToken, token))
      .returning({
        tenantId: recipientPreferences.tenantId,
        recipientId: recipientPreferences.recipientId,
      });

    if (!row) throw new NotFoundError('Unknown or expired unsubscribe token');

    // The link in the footer has to mean the same thing as the API call. It
    // did not: this path wrote the preference and left every consent record
    // granted.
    await this.revokeConsent(
      { tenantId: row.tenantId },
      row.recipientId,
      'unsubscribe-link',
    );

    this.deps.logger.info('recipient unsubscribed by token', {
      tenantId: row.tenantId,
      recipientId: row.recipientId,
    });
    return row;
  }

  /**
   * The unsubscribe URL. The source builds this from `SERVICE_DOMAIN`
   * (`preference.service.ts:458`); it now comes from
   * `config.compliance.unsubscribeBaseUrl`.
   */
  async unsubscribeUrl(scope: TenantScope, recipientId: string): Promise<string> {
    let prefs = await this.get(scope, recipientId);
    // Minting the row on demand means a recipient who has never set a
    // preference still gets a working unsubscribe link — a CAN-SPAM
    // requirement that an absent row would otherwise silently break.
    if (!prefs?.unsubscribeToken) {
      prefs = await this.upsert(scope, recipientId, {});
    }
    return `${this.deps.unsubscribeBaseUrl.replace(/\/$/, '')}/${prefs.unsubscribeToken}`;
  }

  /** Resolve the effective quiet-hours window, or null when none applies. */
  /**
   * The recipient's own quiet hours, falling back to the tenant's.
   *
   * ───────────────────────────────────────────────────────────────────────────
   * THE TENANT-LEVEL WINDOW IS THE POINT
   *
   * This used to apply only when the RECIPIENT had personally configured a
   * window, and almost nobody has: a freshly imported lead list has no
   * preference rows at all. So the check that exists to stop a message arriving
   * at 3am was, in practice, off for exactly the audiences most likely to
   * receive a bulk send.
   *
   * `tenants.settings.quietHours` is the tenant's default and the engine
   * applies it when the recipient has expressed nothing. A recipient who HAS
   * set a window still wins — a personal preference is more specific than an
   * organisational default, and overriding it would be the opposite of what a
   * preference is for.
   *
   * This is not TCPA. Check 5b in the gate is the statutory window and is not
   * opt-in; this is a courtesy window a tenant chooses, and `ENFORCE_QUIET_HOURS`
   * turns it off for a deployment that does not want it.
   */
  quietHoursFor(
    prefs: RecipientPreference | null,
    fallbackTimezone?: string,
    tenantDefault?: { start?: string; end?: string; timezone?: string } | null,
  ): QuietHoursVerdict & { configured: boolean } {
    if (!this.deps.enforceQuietHours) {
      return { configured: false, inQuietHours: false };
    }

    const start = prefs?.quietHoursStart ?? tenantDefault?.start;
    const end = prefs?.quietHoursEnd ?? tenantDefault?.end;
    if (!start || !end) {
      return { configured: false, inQuietHours: false };
    }

    const verdict = evaluateQuietHours({
      start,
      end,
      timezone:
        prefs?.quietHoursTimezone ??
        tenantDefault?.timezone ??
        fallbackTimezone ??
        this.deps.defaultTimezone,
    });
    return { configured: true, ...verdict };
  }

  /** Per-playbook opt-out — the capability the source could not express at all. */
  hasOptedOutOf(prefs: RecipientPreference | null, playbookKey: string | undefined): boolean {
    if (!prefs || !playbookKey) return false;
    return (prefs.eventOptOuts ?? []).includes(playbookKey);
  }

  channelAllowed(prefs: RecipientPreference | null, channel: string): boolean {
    const preferred = prefs?.preferredChannels;
    // An empty or absent list means "no restriction", not "nothing allowed".
    if (!preferred || preferred.length === 0) return true;
    return preferred.some((c) => c.toLowerCase() === channel.toLowerCase());
  }
}
