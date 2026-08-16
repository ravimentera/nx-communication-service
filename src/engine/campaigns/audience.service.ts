/**
 * Audiences — who a campaign goes to.
 *
 * Three kinds, and the difference between them is *when* membership is decided:
 *
 *   static        decided by whoever added the members. The lead-generation
 *                 path: a CSV or an API call, creating `recipients` rows as it
 *                 goes. Membership changes only when someone changes it.
 *   query         decided at materialize time by a bounded predicate over
 *                 `recipients`. Re-materialising re-answers the question.
 *   accumulating  decided by events — a playbook trigger appends members as
 *                 they qualify ("everyone who fired LEAD_INITIAL_CONTACT this
 *                 week"). Materialising is a no-op; the members are already
 *                 there.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PREDICATE IS BOUNDED, DELIBERATELY — THE SAME DECISION AS D-SERIES `where`
 *
 * `definition` for a `query` audience uses the operator vocabulary
 * `playbook_triggers.match_rules` already uses (`eq`, `neq`, `in`, `nin`, `gt`,
 * `lt`, `exists`) over a fixed set of recipient fields. It is not a DSL and must
 * not become one: an audience predicate decides who gets messaged, so "what
 * exactly does this select?" has to be answerable by reading it. A harder
 * question is a named predicate registered in code, not a parser in a column.
 *
 * Unknown operators and unknown fields are rejected at create time rather than
 * silently matching nothing — an audience that quietly selects zero people is
 * indistinguishable from one whose campaign has not run yet.
 */
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Logger } from 'winston';

import type { Db } from '../../db/index.js';
import { audienceMembers, audiences, importErrors, recipients } from '../../db/schema.js';
import { NotFoundError, ValidationError } from '../../platform/http/errors.js';
import { tenantWhere, type TenantScope } from '../../platform/db/tenant-scope.js';
import type {
  ConsentService,
  GrantInput,
} from '../compliance/consent.service.js';
import type { RecipientService } from '../recipients/recipient.service.js';

export const AUDIENCE_KINDS = ['static', 'query', 'accumulating'] as const;
export type AudienceKind = (typeof AUDIENCE_KINDS)[number];

/** The operators a query audience may use. Same seven as a playbook trigger. */
const OPERATORS = ['eq', 'neq', 'in', 'nin', 'gt', 'lt', 'exists'] as const;
type Operator = (typeof OPERATORS)[number];

/**
 * The fields a query audience may filter on.
 *
 * A closed list, not a path expression into arbitrary JSON. `attributes.*` is
 * the one open door, and it is scoped to a single jsonb column whose contents
 * the tenant owns (§0.10 tier 2) — so a pack can segment on whatever it puts
 * there without the engine growing a column per vertical.
 */
const QUERYABLE = ['status', 'locale', 'timezone', 'subTenantId'] as const;

export interface AudienceDefinition {
  where?: Record<string, Partial<Record<Operator, unknown>>>;
}

export interface Audience {
  id: string;
  tenantId: string;
  subTenantId?: string | null;
  name: string;
  kind: AudienceKind;
  definition: AudienceDefinition;
  memberCount: number;
  lastMaterializedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ImportRow {
  externalId: string;
  email?: string;
  phone?: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  locale?: string;
  timezone?: string;
  attributes?: Record<string, unknown>;
}

/**
 * The lawful basis a caller asserts for an imported list, and the evidence for
 * it. Deliberately the same shape `ConsentService.grant()` takes.
 */
export type ImportConsent = GrantInput;

export interface ImportResult {
  importId: string;
  imported: number;
  skipped: number;
  /** Consent rows written. Zero unless the import declared a basis. */
  consented?: number;
  errors: number;
}

export interface AudienceServiceDeps {
  db: Db;
  logger: Logger;
  recipients: RecipientService;
  /**
   * P13. Absent means an import cannot record consent — the pre-P13 behaviour,
   * kept optional so the P11-era tests construct this without it.
   */
  consent?: ConsentService;
  /**
   * The `external_ref.system` imported rows are keyed under. A tenant importing
   * its own list owns its own ids, so this is per-import rather than global —
   * two CSVs from two CRMs must not collide on id `1`.
   */
  defaultImportSystem?: string;
}

/** Rows are inserted in batches of this size. See `importRows`. */
const IMPORT_BATCH = 1_000;

export class AudienceService {
  constructor(private readonly deps: AudienceServiceDeps) {}

  async create(
    scope: TenantScope,
    input: { name: string; kind?: AudienceKind; definition?: AudienceDefinition },
  ): Promise<Audience> {
    const kind = input.kind ?? 'static';
    if (!(AUDIENCE_KINDS as readonly string[]).includes(kind)) {
      throw new ValidationError(`Unknown audience kind '${kind}'`);
    }
    const definition = input.definition ?? {};
    if (kind === 'query') this.assertPredicate(definition);

    const [row] = await this.deps.db
      .insert(audiences)
      .values({
        tenantId: scope.tenantId,
        subTenantId: scope.subTenantId ?? null,
        name: input.name,
        kind,
        definition,
      })
      .returning();

    return this.toAudience(row!);
  }

  async getById(scope: TenantScope, id: string): Promise<Audience | null> {
    const [row] = await this.deps.db
      .select()
      .from(audiences)
      .where(and(tenantWhere(audiences, scope), eq(audiences.id, id)))
      .limit(1);
    return row ? this.toAudience(row) : null;
  }

  async require(scope: TenantScope, id: string): Promise<Audience> {
    const found = await this.getById(scope, id);
    if (!found) throw new NotFoundError(`Audience '${id}' not found for this tenant`);
    return found;
  }

  async list(scope: TenantScope): Promise<Audience[]> {
    const rows = await this.deps.db
      .select()
      .from(audiences)
      .where(tenantWhere(audiences, scope))
      .orderBy(audiences.name);
    return rows.map((r) => this.toAudience(r));
  }

  /**
   * Add recipients that already exist. Idempotent: the composite primary key
   * `(audience_id, recipient_id)` makes a repeated add a no-op rather than a
   * duplicate send.
   */
  async addMembers(
    scope: TenantScope,
    audienceId: string,
    recipientIds: string[],
    source = 'api',
  ): Promise<{ added: number }> {
    await this.require(scope, audienceId);
    if (recipientIds.length === 0) return { added: 0 };

    // Only recipients this tenant owns. Without this an audience could be
    // filled with another tenant's ids by anyone who could guess a uuid, and
    // every later send would read them back as its own.
    const owned = await this.deps.db
      .select({ id: recipients.id })
      .from(recipients)
      .where(and(tenantWhere(recipients, scope), inArray(recipients.id, recipientIds)));

    if (owned.length === 0) return { added: 0 };

    const inserted = await this.deps.db
      .insert(audienceMembers)
      .values(
        owned.map((r) => ({
          audienceId,
          recipientId: r.id,
          tenantId: scope.tenantId,
          source,
        })),
      )
      .onConflictDoNothing()
      .returning({ recipientId: audienceMembers.recipientId });

    await this.refreshCount(scope, audienceId);
    return { added: inserted.length };
  }

  async removeMembers(
    scope: TenantScope,
    audienceId: string,
    recipientIds: string[],
  ): Promise<{ removed: number }> {
    await this.require(scope, audienceId);
    if (recipientIds.length === 0) return { removed: 0 };

    const removed = await this.deps.db
      .delete(audienceMembers)
      .where(
        and(
          eq(audienceMembers.audienceId, audienceId),
          eq(audienceMembers.tenantId, scope.tenantId),
          inArray(audienceMembers.recipientId, recipientIds),
        ),
      )
      .returning({ recipientId: audienceMembers.recipientId });

    await this.refreshCount(scope, audienceId);
    return { removed: removed.length };
  }

  /**
   * Re-answer a `query` audience's question and replace its membership.
   *
   * `static` and `accumulating` audiences are not re-derived — their membership
   * IS the authored answer, and recomputing it would silently drop everyone a
   * human added. They return their current count instead of an error, because
   * "materialize everything before launch" is a reasonable thing for a caller
   * to do without checking each kind first.
   */
  async materialize(scope: TenantScope, audienceId: string): Promise<{ count: number }> {
    const audience = await this.require(scope, audienceId);

    if (audience.kind !== 'query') {
      return { count: audience.memberCount };
    }

    const matched = await this.deps.db
      .select({ id: recipients.id })
      .from(recipients)
      .where(and(tenantWhere(recipients, scope), ...this.predicateOf(audience.definition)));

    await this.deps.db
      .delete(audienceMembers)
      .where(
        and(
          eq(audienceMembers.audienceId, audienceId),
          eq(audienceMembers.tenantId, scope.tenantId),
        ),
      );

    for (let i = 0; i < matched.length; i += IMPORT_BATCH) {
      const slice = matched.slice(i, i + IMPORT_BATCH);
      await this.deps.db
        .insert(audienceMembers)
        .values(
          slice.map((r) => ({
            audienceId,
            recipientId: r.id,
            tenantId: scope.tenantId,
            source: 'query',
          })),
        )
        .onConflictDoNothing();
    }

    await this.deps.db
      .update(audiences)
      .set({ memberCount: matched.length, lastMaterializedAt: new Date(), updatedAt: new Date() })
      .where(and(tenantWhere(audiences, scope), eq(audiences.id, audienceId)));

    this.deps.logger.info('audience materialized', {
      tenantId: scope.tenantId,
      audienceId,
      count: matched.length,
    });
    return { count: matched.length };
  }

  /**
   * Import rows into a static audience, creating recipients as it goes.
   *
   * Takes an **async iterable** rather than an array or a buffer. A lead list is
   * the one input to this engine that is routinely larger than memory, and the
   * caller streams it: `importRows` never holds more than `IMPORT_BATCH` rows.
   * The HTTP layer parses CSV into this shape; nothing here knows what a CSV is,
   * which is also what makes it testable without a file.
   *
   * Per-row validation, not per-file: one malformed line costs that line. The
   * rejects land in `import_errors` with their row number so the caller can fix
   * the source and re-import — and re-importing is safe, because recipients are
   * upserted by external ref (D42).
   */
  async importRows(
    scope: TenantScope,
    audienceId: string,
    rows: AsyncIterable<ImportRow>,
    options: { system?: string; importId?: string; consent?: ImportConsent } = {},
  ): Promise<ImportResult> {
    await this.require(scope, audienceId);

    const importId = options.importId ?? crypto.randomUUID();
    const system = options.system ?? this.deps.defaultImportSystem ?? 'import';

    let valid = 0;
    let inserted = 0;
    let errors = 0;
    let consented = 0;
    let rowNumber = 1; // 1 is the header, so the first data row is 2.
    let batch: { recipientId: string }[] = [];
    const failures: (typeof importErrors.$inferInsert)[] = [];

    const flush = async () => {
      if (batch.length > 0) {
        // `returning()` is what makes `skipped` a real number rather than a
        // decorative zero: the rows that come back are the memberships that did
        // not already exist.
        const added = await this.deps.db
          .insert(audienceMembers)
          .values(
            batch.map((b) => ({
              audienceId,
              recipientId: b.recipientId,
              tenantId: scope.tenantId,
              source: `import:${importId}`,
            })),
          )
          .onConflictDoNothing()
          .returning({ recipientId: audienceMembers.recipientId });
        inserted += added.length;

        // Consent, captured in the same flush as the membership.
        //
        // An import is where a lead list arrives with a lawful basis attached —
        // "these people ticked the box on our stand at the trade show" — and it
        // is the only bulk path where that can be recorded. Without it, an
        // imported audience is unreachable the moment enforcement is on, and
        // the operator's only recourse is a consent call per recipient.
        //
        // It is opt-in, and the caller must name a source and a date. There is
        // no default: "they were in the spreadsheet" is not a lawful basis, and
        // defaulting would make it look like one.
        if (options.consent && this.deps.consent) {
          consented += await this.deps.consent.captureImported(
            scope,
            batch.map((b) => b.recipientId),
            options.consent,
          );
        }

        batch = [];
      }
      if (failures.length > 0) {
        await this.deps.db.insert(importErrors).values(failures.splice(0));
      }
    };

    for await (const row of rows) {
      rowNumber += 1;
      const problem = this.validateRow(row);
      if (problem) {
        errors += 1;
        failures.push({
          tenantId: scope.tenantId,
          audienceId,
          importId,
          rowNumber,
          raw: { ...row } as Record<string, unknown>,
          reason: problem,
        });
        if (failures.length >= IMPORT_BATCH) await flush();
        continue;
      }

      try {
        const recipient = await this.deps.recipients.upsertByExternalRef(
          scope,
          { system, id: row.externalId },
          {
            displayName: row.displayName,
            firstName: row.firstName,
            lastName: row.lastName,
            locale: row.locale,
            timezone: row.timezone,
            contactPoints: contactPointsOf(row),
            attributes: row.attributes,
          },
        );
        batch.push({ recipientId: recipient.id });
        valid += 1;
        if (batch.length >= IMPORT_BATCH) await flush();
      } catch (error) {
        errors += 1;
        failures.push({
          tenantId: scope.tenantId,
          audienceId,
          importId,
          rowNumber,
          raw: { ...row } as Record<string, unknown>,
          reason: error instanceof Error ? error.message : 'could not create the recipient',
        });
        if (failures.length >= IMPORT_BATCH) await flush();
      }
    }

    await flush();
    await this.refreshCount(scope, audienceId);

    // A valid row whose membership already existed is skipped, not imported —
    // which is what makes re-importing a list report honestly instead of
    // claiming to have added everyone a second time.
    const skipped = valid - inserted;

    this.deps.logger.info('audience import finished', {
      tenantId: scope.tenantId,
      audienceId,
      importId,
      imported: inserted,
      skipped,
      errors,
      consented,
    });
    return { importId, imported: inserted, skipped, errors, consented };
  }

  /** The downloadable report. Paginated, because a bad header rejects every row. */
  async listImportErrors(
    scope: TenantScope,
    audienceId: string,
    options: { importId?: string; limit?: number; offset?: number } = {},
  ): Promise<{ rowNumber: number; reason: string; raw: unknown }[]> {
    await this.require(scope, audienceId);
    const clauses: SQL[] = [
      tenantWhere(importErrors, scope),
      eq(importErrors.audienceId, audienceId),
    ];
    if (options.importId) clauses.push(eq(importErrors.importId, options.importId));

    return this.deps.db
      .select({
        rowNumber: importErrors.rowNumber,
        reason: importErrors.reason,
        raw: importErrors.raw,
      })
      .from(importErrors)
      .where(and(...clauses))
      .orderBy(importErrors.rowNumber)
      .limit(Math.min(options.limit ?? 200, 1_000))
      .offset(options.offset ?? 0);
  }

  /** Members, as recipient ids. The orchestrator's expand step reads this. */
  async memberIds(
    scope: TenantScope,
    audienceId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<string[]> {
    const rows = await this.deps.db
      .select({ recipientId: audienceMembers.recipientId })
      .from(audienceMembers)
      .where(
        and(
          eq(audienceMembers.audienceId, audienceId),
          eq(audienceMembers.tenantId, scope.tenantId),
        ),
      )
      .orderBy(audienceMembers.recipientId)
      .limit(options.limit ?? 100_000)
      .offset(options.offset ?? 0);
    return rows.map((r) => r.recipientId);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private validateRow(row: ImportRow): string | null {
    if (!row.externalId || row.externalId.trim() === '') {
      return 'externalId is required — it is what makes a re-import idempotent';
    }
    if (!row.email && !row.phone) {
      return 'a row needs at least one of email or phone, or nothing can be sent to it';
    }
    if (row.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(row.email)) {
      return `'${row.email}' is not a usable email address`;
    }
    return null;
  }

  private assertPredicate(definition: AudienceDefinition): void {
    const where = definition.where ?? {};
    for (const [field, predicate] of Object.entries(where)) {
      const known =
        (QUERYABLE as readonly string[]).includes(field) || field.startsWith('attributes.');
      if (!known) {
        throw new ValidationError(
          `'${field}' is not a queryable field. Use one of ${QUERYABLE.join(', ')} or attributes.<key>`,
        );
      }
      for (const op of Object.keys(predicate ?? {})) {
        if (!(OPERATORS as readonly string[]).includes(op)) {
          throw new ValidationError(
            `'${op}' is not a supported operator. Use one of ${OPERATORS.join(', ')}`,
          );
        }
      }
    }
  }

  private predicateOf(definition: AudienceDefinition): SQL[] {
    const clauses: SQL[] = [];
    for (const [field, predicate] of Object.entries(definition.where ?? {})) {
      const column = this.columnFor(field);
      for (const [op, value] of Object.entries(predicate ?? {})) {
        clauses.push(this.clauseFor(column, op as Operator, value));
      }
    }
    return clauses;
  }

  private columnFor(field: string): SQL {
    if (field.startsWith('attributes.')) {
      const key = field.slice('attributes.'.length);
      return sql`${recipients.attributes}->>${key}`;
    }
    switch (field) {
      case 'status':
        return sql`${recipients.status}`;
      case 'locale':
        return sql`${recipients.locale}`;
      case 'timezone':
        return sql`${recipients.timezone}`;
      case 'subTenantId':
        return sql`${recipients.subTenantId}`;
      default:
        // assertPredicate ran at create time; this is the belt to that braces.
        throw new ValidationError(`'${field}' is not a queryable field`);
    }
  }

  private clauseFor(column: SQL, op: Operator, value: unknown): SQL {
    switch (op) {
      case 'eq':
        return sql`${column} = ${String(value)}`;
      case 'neq':
        return sql`${column} IS DISTINCT FROM ${String(value)}`;
      case 'in':
        return sql`${column} = ANY(${(value as unknown[]).map(String)})`;
      case 'nin':
        return sql`NOT (${column} = ANY(${(value as unknown[]).map(String)}))`;
      case 'gt':
        return sql`${column} > ${String(value)}`;
      case 'lt':
        return sql`${column} < ${String(value)}`;
      case 'exists':
        return value === false ? sql`${column} IS NULL` : sql`${column} IS NOT NULL`;
    }
  }

  private async refreshCount(scope: TenantScope, audienceId: string): Promise<void> {
    const [row] = await this.deps.db
      .select({ count: sql<number>`count(*)::int` })
      .from(audienceMembers)
      .where(
        and(
          eq(audienceMembers.audienceId, audienceId),
          eq(audienceMembers.tenantId, scope.tenantId),
        ),
      );
    await this.deps.db
      .update(audiences)
      .set({ memberCount: row?.count ?? 0, updatedAt: new Date() })
      .where(and(tenantWhere(audiences, scope), eq(audiences.id, audienceId)));
  }

  private toAudience(row: typeof audiences.$inferSelect): Audience {
    return {
      id: row.id,
      tenantId: row.tenantId,
      subTenantId: row.subTenantId,
      name: row.name,
      kind: row.kind as AudienceKind,
      definition: (row.definition ?? {}) as AudienceDefinition,
      memberCount: row.memberCount,
      lastMaterializedAt: row.lastMaterializedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

function contactPointsOf(row: ImportRow): { type: string; value: string; primary?: boolean }[] {
  const points: { type: string; value: string; primary?: boolean }[] = [];
  if (row.email) points.push({ type: 'email', value: row.email, primary: true });
  if (row.phone) points.push({ type: 'phone', value: row.phone, primary: !row.email });
  return points;
}
