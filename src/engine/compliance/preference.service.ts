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

import { and, eq } from 'drizzle-orm';
import type { Logger } from 'winston';

import type { Db } from '../../db/index.js';
import { recipientPreferences } from '../../db/schema.js';
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
  unsubscribeBaseUrl: string;
}

export class PreferenceService {
  constructor(private readonly deps: PreferenceServiceDeps) {}

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

  /** Global opt-out. Also flips the recipient's status — see `RecipientService`. */
  async unsubscribe(
    scope: TenantScope,
    recipientId: string,
    reason?: string,
  ): Promise<RecipientPreference> {
    const row = await this.upsert(scope, recipientId, { allowCommunications: false });
    this.deps.logger.info('recipient unsubscribed', {
      tenantId: scope.tenantId,
      recipientId,
      reason,
    });
    return row;
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
  quietHoursFor(
    prefs: RecipientPreference | null,
    fallbackTimezone?: string,
  ): QuietHoursVerdict & { configured: boolean } {
    if (!prefs?.quietHoursStart || !prefs.quietHoursEnd) {
      return { configured: false, inQuietHours: false };
    }
    const verdict = evaluateQuietHours({
      start: prefs.quietHoursStart,
      end: prefs.quietHoursEnd,
      timezone:
        prefs.quietHoursTimezone ?? fallbackTimezone ?? this.deps.defaultTimezone,
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
