/**
 * Trigger → playbooks. This is the replacement for the 17-case switch.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE `where` PREDICATE IS BOUNDED ON PURPOSE
 *
 * `match_rules.where` is `{ "path.to.field": { op: value } }`, ANDed. Seven
 * operators, no OR, no nesting, no arithmetic, no interpolation. It is not an
 * expression language and **must not become one**.
 *
 * This is the documented failure mode for this design. The pressure to add "just
 * one more operator" is constant and each one is individually reasonable; the
 * end state is an interpreter nobody can debug, running attacker-adjacent input
 * from an event payload, with its own null semantics and no type checking. When
 * a playbook genuinely needs more than this, the answer is a **named predicate
 * behind a port** — code, in the repo, tested — not a richer grammar here.
 *
 * The predicate exists to answer questions like "only for VIP tier" or "only
 * when the appointment is more than 24h out". It has been enough for every one
 * of the 17 medspa cases, which use no `where` at all.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Logger } from 'winston';

import type { Db } from '../../db/index.js';
import { playbooks, playbookTriggers, tenantPacks } from '../../db/schema.js';
import type { TenantScope } from '../../platform/db/tenant-scope.js';
import type { OutreachTrigger } from './trigger.js';

export const PREDICATE_OPERATORS = [
  'eq',
  'neq',
  'in',
  'nin',
  'gt',
  'lt',
  'exists',
] as const;

export type PredicateOperator = (typeof PREDICATE_OPERATORS)[number];

export type Predicate = Record<string, Partial<Record<PredicateOperator, unknown>>>;

export interface MatchRules {
  /** Exact match after alias resolution. No regex, no globbing. */
  eventType?: string;
  /** Additional accepted spellings — see D56 for why these exist. */
  eventTypeAliases?: string[];
  where?: Predicate;
}

export type Playbook = typeof playbooks.$inferSelect;

export interface MatchedPlaybook {
  playbook: Playbook;
  triggerId: string;
  matchRules: MatchRules;
}

export interface MatcherDeps {
  db: Db;
  logger: Logger;
}

/**
 * Read a dotted path out of a payload. Returns `undefined` for any missing
 * link, which is what makes `exists: false` meaningful.
 *
 * This is plain property access and nothing more. A numeric segment therefore
 * reaches an array element (`affectedAreas.0`) because that is what property
 * access does in JavaScript — it is not a feature to build on, and there is
 * deliberately no wildcard, no filter, no slice and no predicate-within-a-path.
 * Those are the constructs that turn a lookup into a query language.
 */
export function readPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** One operator against one value. Unknown operators do not match, and say so. */
function testOperator(
  op: string,
  expected: unknown,
  actual: unknown,
  logger: Logger,
): boolean {
  switch (op) {
    case 'eq':
      return actual === expected;
    case 'neq':
      return actual !== expected;
    case 'in':
      return Array.isArray(expected) && expected.includes(actual);
    case 'nin':
      return Array.isArray(expected) && !expected.includes(actual);
    case 'gt':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'lt':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case 'exists':
      return (actual !== undefined && actual !== null) === Boolean(expected);
    default:
      // A typo in a pack must not silently widen the match to everything.
      logger.warn('unknown predicate operator in a playbook trigger — treated as no match', {
        operator: op,
      });
      return false;
  }
}

/** Every clause must hold. An empty predicate matches. */
export function evaluatePredicate(
  predicate: Predicate | undefined,
  payload: Record<string, unknown>,
  logger: Logger,
): boolean {
  if (!predicate) return true;

  for (const [path, clause] of Object.entries(predicate)) {
    const actual = readPath(payload, path);
    for (const [op, expected] of Object.entries(clause)) {
      if (!testOperator(op, expected, actual, logger)) return false;
    }
  }
  return true;
}

export class PlaybookMatcher {
  constructor(private readonly deps: MatcherDeps) {}

  /**
   * Candidate playbooks for a trigger, highest priority first.
   *
   * A tenant sees a playbook only if it installed the pack that ships it —
   * the same boundary as the P5 context registry (D37). A playbook with no
   * `pack_id` is tenant-authored and always visible to its owner.
   */
  async match(trigger: OutreachTrigger): Promise<MatchedPlaybook[]> {
    const scope: TenantScope = {
      tenantId: trigger.tenantId,
      ...(trigger.subTenantId ? { subTenantId: trigger.subTenantId } : {}),
    };

    const installed = await this.installedPacks(scope);

    const rows = await this.deps.db
      .select({ playbook: playbooks, trigger: playbookTriggers })
      .from(playbookTriggers)
      .innerJoin(playbooks, eq(playbooks.id, playbookTriggers.playbookId))
      .where(
        and(
          eq(playbookTriggers.tenantId, trigger.tenantId),
          eq(playbookTriggers.isActive, true),
          eq(playbookTriggers.triggerType, trigger.type),
          eq(playbooks.isActive, true),
          // Pack-provided playbooks require the pack; tenant-authored ones
          // (pack_id NULL) do not.
          installed.length > 0
            ? or(isNull(playbooks.packId), inArray(playbooks.packId, installed))
            : isNull(playbooks.packId),
        ),
      );

    const matched: MatchedPlaybook[] = [];

    for (const row of rows) {
      const rules = (row.trigger.matchRules ?? {}) as MatchRules;

      if (!this.eventTypeMatches(rules, trigger.eventType)) continue;
      if (!evaluatePredicate(rules.where, trigger.payload, this.deps.logger)) continue;

      matched.push({ playbook: row.playbook, triggerId: row.trigger.id, matchRules: rules });
    }

    // Lower `priority` runs first — the column's own documented meaning
    // ("Lower runs first when several playbooks match one event").
    matched.sort((a, b) => a.playbook.priority - b.playbook.priority);

    this.deps.logger.debug('playbooks matched', {
      eventType: trigger.eventType,
      candidates: rows.length,
      matched: matched.length,
      keys: matched.map((m) => m.playbook.key),
    });

    return matched;
  }

  /**
   * Exact match, plus the pack's declared aliases.
   *
   * Aliases are not a convenience — the source's enum and its switch **disagree**
   * (D56). `models/communication.model.ts` declares `APPOINTMENT_RESCHEDULED`
   * and `TREATMENT_COMPLETED`; the switch matches `APPOINTMENT_RESCHEDULING`
   * and `TREATMENT_COMPLETION`. Whichever spelling a caller uses today, it must
   * keep working.
   */
  private eventTypeMatches(rules: MatchRules, eventType: string | undefined): boolean {
    // A trigger declaring no eventType matches any event of its type — used by
    // schedule and manual triggers, which have no event to match on.
    if (!rules.eventType) return true;
    if (!eventType) return false;

    if (rules.eventType === eventType) return true;
    return (rules.eventTypeAliases ?? []).includes(eventType);
  }

  private async installedPacks(scope: TenantScope): Promise<string[]> {
    const rows = await this.deps.db
      .select({ packId: tenantPacks.packId })
      .from(tenantPacks)
      .where(and(eq(tenantPacks.tenantId, scope.tenantId), eq(tenantPacks.isActive, true)));
    return rows.map((r) => r.packId);
  }
}
