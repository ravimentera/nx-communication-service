/**
 * GDPR Article 17 (erasure) and Article 20 (portability), for one recipient.
 *
 * Both are gated on the tenant carrying the `gdpr` compliance profile — not
 * because the operations are dangerous to offer more widely, but because
 * erasure is irreversible and a tenant that has not adopted GDPR has no reason
 * to be one API call from destroying its own correspondence record.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ERASURE IS NOT `DELETE FROM messages`
 *
 * A message row is not only personal data. It is also the record that a message
 * was sent — which the tenant may be separately obliged to keep, and which
 * every count, rate-limit window and audit answer depends on. Deleting the row
 * makes the send disappear; deleting the *content* makes the person disappear
 * from it, which is what the right actually asks for.
 *
 * So:
 *
 *   - `messages.content` and the metadata that carries the recipient's address
 *     are overwritten. The row, its timestamps, its channel and its status stay.
 *   - `recipient_context`, `recipient_memories` and `recipient_preferences` are
 *     **deleted outright**: they exist only to describe the person.
 *   - `message_analytics.metadata` is scrubbed of everything but the counts.
 *   - `consent_records` are **kept**. They are the evidence that a send was
 *     lawful at the time, and erasing them would leave the tenant unable to
 *     answer for messages it had already sent. Article 17(3)(b) and (e).
 *   - `recipients` is tombstoned rather than deleted: status `deleted`, contact
 *     points cleared, `external_ref` replaced. The id survives so the foreign
 *     keys on `messages` still resolve, and the compliance gate's first check
 *     already blocks every send to a `deleted` recipient.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Logger } from 'winston';

import type { Db } from '../../db/index.js';
import {
  consentRecords,
  messageAnalytics,
  messages,
  recipientContext,
  recipientMemories,
  recipientPreferences,
  recipients,
  tenants,
} from '../../db/schema.js';
import { ForbiddenError, NotFoundError } from '../../platform/http/errors.js';
import type { TenantScope } from '../../platform/db/tenant-scope.js';
import { parseComplianceProfile } from './profiles.js';

/** What replaces erased content, so a reader knows why it is empty. */
const TOMBSTONE = '[erased at the recipient’s request]';

export interface ErasureReport {
  recipientId: string;
  erasedAt: string;
  counts: {
    messages: number;
    analytics: number;
    context: number;
    memories: number;
    preferences: number;
  };
  /** Kept on purpose, and why — so the answer to "why is this still here" ships. */
  retained: { consentRecords: number; reason: string };
}

export interface ExportBundle {
  recipientId: string;
  exportedAt: string;
  recipient: unknown;
  preferences: unknown;
  consent: unknown[];
  context: unknown[];
  memories: unknown[];
  messages: unknown[];
}

export interface ErasureServiceDeps {
  db: Db;
  logger: Logger;
}

export class ErasureService {
  constructor(private readonly deps: ErasureServiceDeps) {}

  /**
   * Both operations require the profile. A tenant that has not adopted GDPR
   * gets a 403 naming the profile rather than a 404, because the endpoint is
   * real and the tenant is simply not entitled to it — the same distinction the
   * context-provider registry makes for pack-gated kinds.
   */
  private async requireGdpr(scope: TenantScope): Promise<void> {
    const [row] = await this.deps.db
      .select({ complianceProfile: tenants.complianceProfile })
      .from(tenants)
      .where(eq(tenants.id, scope.tenantId))
      .limit(1);

    if (!parseComplianceProfile(row?.complianceProfile).gdpr) {
      throw new ForbiddenError(
        'This tenant does not carry the gdpr compliance profile. Erasure and export are irreversible, and are enabled by setting {"gdpr": true} on tenants.compliance_profile.',
      );
    }
  }

  private async requireRecipient(scope: TenantScope, recipientId: string) {
    const [row] = await this.deps.db
      .select()
      .from(recipients)
      .where(and(eq(recipients.tenantId, scope.tenantId), eq(recipients.id, recipientId)))
      .limit(1);
    if (!row) throw new NotFoundError(`Recipient '${recipientId}' not found`);
    return row;
  }

  async erase(scope: TenantScope, recipientId: string): Promise<ErasureReport> {
    await this.requireGdpr(scope);
    await this.requireRecipient(scope, recipientId);

    const tenantPredicate = eq(messages.tenantId, scope.tenantId);

    // One transaction. A half-erased recipient — content gone, contact points
    // still there — is the worst of both outcomes.
    const counts = await this.deps.db.transaction(async (tx) => {
      const erasedMessages = await tx
        .update(messages)
        .set({
          content: TOMBSTONE,
          // The metadata carries `to`, which is the address itself. Keep the
          // correlation id and the playbook key: neither identifies anyone, and
          // both are how a send is traced afterwards.
          metadata: sql`jsonb_strip_nulls(jsonb_build_object(
            'correlationId', ${messages.metadata} -> 'correlationId',
            'playbookKey', ${messages.metadata} -> 'playbookKey',
            'erased', to_jsonb(true)
          ))`,
          updatedAt: new Date(),
        })
        .where(and(tenantPredicate, eq(messages.recipientId, recipientId)))
        .returning({ id: messages.id });

      const erasedAnalytics = await tx
        .update(messageAnalytics)
        .set({ metadata: null })
        .where(
          and(
            eq(messageAnalytics.tenantId, scope.tenantId),
            eq(messageAnalytics.recipientId, recipientId),
          ),
        )
        .returning({ id: messageAnalytics.id });

      const deletedContext = await tx
        .delete(recipientContext)
        .where(
          and(
            eq(recipientContext.tenantId, scope.tenantId),
            eq(recipientContext.recipientId, recipientId),
          ),
        )
        .returning({ id: recipientContext.id });

      const deletedMemories = await tx
        .delete(recipientMemories)
        .where(
          and(
            eq(recipientMemories.tenantId, scope.tenantId),
            eq(recipientMemories.recipientId, recipientId),
          ),
        )
        .returning({ id: recipientMemories.id });

      const deletedPreferences = await tx
        .delete(recipientPreferences)
        .where(
          and(
            eq(recipientPreferences.tenantId, scope.tenantId),
            eq(recipientPreferences.recipientId, recipientId),
          ),
        )
        .returning({ id: recipientPreferences.id });

      // Tombstone, not delete: `messages.recipient_id` is a foreign key, and the
      // gate's first check already refuses every send to a `deleted` recipient.
      await tx
        .update(recipients)
        .set({
          status: 'deleted',
          displayName: TOMBSTONE,
          firstName: null,
          lastName: null,
          timezone: null,
          locale: null,
          contactPoints: [],
          attributes: {},
          // Replaced rather than cleared: the column is NOT NULL, and a
          // recognisable marker beats an empty object for anyone reading the row
          // later. The original external id is the thing being erased.
          externalRef: { system: 'erased', id: recipientId },
          updatedAt: new Date(),
        })
        .where(and(eq(recipients.tenantId, scope.tenantId), eq(recipients.id, recipientId)));

      return {
        messages: erasedMessages.length,
        analytics: erasedAnalytics.length,
        context: deletedContext.length,
        memories: deletedMemories.length,
        preferences: deletedPreferences.length,
      };
    });

    const [consent] = await this.deps.db
      .select({ n: sql<number>`count(*)::int` })
      .from(consentRecords)
      .where(
        and(
          eq(consentRecords.tenantId, scope.tenantId),
          eq(consentRecords.recipientId, recipientId),
        ),
      );

    this.deps.logger.warn('recipient erased under GDPR article 17', {
      tenantId: scope.tenantId,
      recipientId,
      ...counts,
    });

    return {
      recipientId,
      erasedAt: new Date().toISOString(),
      counts,
      retained: {
        consentRecords: consent?.n ?? 0,
        reason:
          'Consent records are the evidence that each send was lawful when it happened. Erasing them would leave the tenant unable to answer for messages already sent (article 17(3)(b), (e)).',
      },
    };
  }

  /**
   * Article 20: everything held about this recipient, in a structured form.
   *
   * Deliberately not paginated. A portability export is one answer to one
   * request, and an export that silently stopped at the first hundred messages
   * would be a compliance failure rather than a performance feature. The route
   * bounds it instead, and says so when it truncates.
   */
  async export(
    scope: TenantScope,
    recipientId: string,
    limit = 10_000,
  ): Promise<ExportBundle & { truncated: boolean }> {
    await this.requireGdpr(scope);
    const recipient = await this.requireRecipient(scope, recipientId);

    const [preferences, consent, context, memories, sentMessages] = await Promise.all([
      this.deps.db
        .select()
        .from(recipientPreferences)
        .where(
          and(
            eq(recipientPreferences.tenantId, scope.tenantId),
            eq(recipientPreferences.recipientId, recipientId),
          ),
        ),
      this.deps.db
        .select()
        .from(consentRecords)
        .where(
          and(
            eq(consentRecords.tenantId, scope.tenantId),
            eq(consentRecords.recipientId, recipientId),
          ),
        ),
      this.deps.db
        .select()
        .from(recipientContext)
        .where(
          and(
            eq(recipientContext.tenantId, scope.tenantId),
            eq(recipientContext.recipientId, recipientId),
          ),
        ),
      this.deps.db
        .select()
        .from(recipientMemories)
        .where(
          and(
            eq(recipientMemories.tenantId, scope.tenantId),
            eq(recipientMemories.recipientId, recipientId),
          ),
        ),
      this.deps.db
        .select()
        .from(messages)
        .where(and(eq(messages.tenantId, scope.tenantId), eq(messages.recipientId, recipientId)))
        .limit(limit + 1),
    ]);

    const truncated = sentMessages.length > limit;

    this.deps.logger.info('recipient data exported under GDPR article 20', {
      tenantId: scope.tenantId,
      recipientId,
      messages: Math.min(sentMessages.length, limit),
      truncated,
    });

    return {
      recipientId,
      exportedAt: new Date().toISOString(),
      recipient,
      preferences: preferences[0] ?? null,
      consent,
      context,
      memories,
      messages: truncated ? sentMessages.slice(0, limit) : sentMessages,
      truncated,
    };
  }
}
