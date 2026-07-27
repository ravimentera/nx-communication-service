/**
 * Trigger → playbooks.
 *
 * The predicate tests are as much a specification as a check: `where` is
 * deliberately a bounded object and **must not become an expression language**.
 * If a future change makes one of the "not supported" cases below pass, that is
 * the design failing, not the test.
 */
import winston from 'winston';

import type { Db } from '../../../src/db/index.js';
import {
  PlaybookMatcher,
  evaluatePredicate,
  readPath,
  type MatchRules,
  type Predicate,
} from '../../../src/engine/playbooks/matcher.js';
import { playbooks, playbookTriggers } from '../../../src/db/schema.js';
import type { OutreachTrigger } from '../../../src/engine/playbooks/trigger.js';

const logger = winston.createLogger({ silent: true });

// ── readPath ────────────────────────────────────────────────────────────────

describe('readPath', () => {
  const payload = { a: { b: { c: 42 } }, top: 'x', nil: null, list: [1, 2] };

  it('walks dotted paths', () => {
    expect(readPath(payload, 'top')).toBe('x');
    expect(readPath(payload, 'a.b.c')).toBe(42);
  });

  it('returns undefined for any missing link rather than throwing', () => {
    // This is what makes `exists: false` meaningful, and it is the direct fix
    // for `handleAppointmentRescheduling` reading `oldAppointment.date` on an
    // event with no `oldAppointment` (a TypeError, swallowed as "failed").
    expect(readPath(payload, 'a.nope.c')).toBeUndefined();
    expect(readPath(payload, 'nil.anything')).toBeUndefined();
    expect(readPath(undefined, 'a')).toBeUndefined();
  });

  it('reaches an array element by index, because that is plain property access', () => {
    // Not a feature to build on — just what `obj[k]` does. What is deliberately
    // absent is everything that would make this a query language.
    expect(readPath(payload, 'list.0')).toBe(1);
  });

  it('has no wildcards, filters or slices', () => {
    for (const path of ['list.*', 'list[0]', 'list.*.x', 'a.b[c=1]']) {
      expect(readPath(payload, path)).toBeUndefined();
    }
  });
});

// ── predicates ──────────────────────────────────────────────────────────────

describe('predicate operators', () => {
  const payload = { tier: 'vip', count: 5, active: true, missing: null };
  const test = (where: Predicate) => evaluatePredicate(where, payload, logger);

  it('eq / neq', () => {
    expect(test({ tier: { eq: 'vip' } })).toBe(true);
    expect(test({ tier: { eq: 'basic' } })).toBe(false);
    expect(test({ tier: { neq: 'basic' } })).toBe(true);
  });

  it('in / nin', () => {
    expect(test({ tier: { in: ['vip', 'gold'] } })).toBe(true);
    expect(test({ tier: { in: ['gold'] } })).toBe(false);
    expect(test({ tier: { nin: ['gold'] } })).toBe(true);
  });

  it('gt / lt, numbers only', () => {
    expect(test({ count: { gt: 3 } })).toBe(true);
    expect(test({ count: { lt: 3 } })).toBe(false);
    // No string comparison, no date coercion — both are ways an implicit type
    // system creeps in.
    expect(test({ tier: { gt: 'a' } })).toBe(false);
  });

  it('exists', () => {
    expect(test({ tier: { exists: true } })).toBe(true);
    expect(test({ nope: { exists: false } })).toBe(true);
    expect(test({ nope: { exists: true } })).toBe(false);
    // null counts as absent, matching the contract validator.
    expect(test({ missing: { exists: false } })).toBe(true);
  });

  it('ANDs every clause and every operator', () => {
    expect(test({ tier: { eq: 'vip' }, count: { gt: 3 } })).toBe(true);
    expect(test({ tier: { eq: 'vip' }, count: { gt: 99 } })).toBe(false);
    expect(test({ count: { gt: 1, lt: 9 } })).toBe(true);
    expect(test({ count: { gt: 1, lt: 3 } })).toBe(false);
  });

  it('matches when there is no predicate at all', () => {
    // All 17 medspa playbooks are in this case.
    expect(evaluatePredicate(undefined, payload, logger)).toBe(true);
    expect(evaluatePredicate({}, payload, logger)).toBe(true);
  });

  it('treats an unknown operator as NO match, never as a wildcard', () => {
    // A typo in a pack must narrow to nothing rather than silently widening the
    // match to every event.
    const spy = { warned: 0 };
    const noisy = {
      warn: () => {
        spy.warned += 1;
      },
    } as unknown as typeof logger;

    expect(evaluatePredicate({ tier: { regex: 'vip' } } as Predicate, payload, noisy)).toBe(false);
    expect(spy.warned).toBe(1);
  });
});

describe('the predicate is deliberately bounded', () => {
  const payload = { a: 1, b: 2 };

  it('has no OR', () => {
    // Two playbooks, or two triggers on one playbook. Not a grammar.
    expect(evaluatePredicate({ $or: { eq: 1 } } as Predicate, payload, logger)).toBe(false);
  });

  it('has no arithmetic and no interpolation', () => {
    expect(evaluatePredicate({ a: { eq: '{{b}}' } } as Predicate, payload, logger)).toBe(false);
  });
});

// ── matching ────────────────────────────────────────────────────────────────

type PlaybookRow = typeof playbooks.$inferSelect;
type TriggerRow = typeof playbookTriggers.$inferSelect;

function playbook(over: Partial<PlaybookRow> = {}): PlaybookRow {
  return {
    id: 'pb-1',
    tenantId: 't-1',
    subTenantId: null,
    packId: 'medspa',
    key: 'medspa.appointment-reminder',
    name: 'Appointment reminder',
    description: null,
    isActive: true,
    priority: 100,
    dataContract: {},
    contentSource: { kind: 'template', templateKey: 'x' },
    channelPlan: [],
    approvalPolicyId: null,
    throttle: {},
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as PlaybookRow;
}

function triggerRow(matchRules: MatchRules, over: Partial<TriggerRow> = {}): TriggerRow {
  return {
    id: 'tr-1',
    tenantId: 't-1',
    playbookId: 'pb-1',
    triggerType: 'event',
    matchRules,
    scheduleCron: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as TriggerRow;
}

function builder<T>(rows: T[]) {
  const self = {
    where: () => self,
    innerJoin: () => self,
    limit: () => self,
    then: (ok: (v: T[]) => unknown, err?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(ok, err),
  };
  return self;
}

function matcher(
  joined: { playbook: PlaybookRow; trigger: TriggerRow }[],
  installedPacks: string[] = ['medspa'],
): PlaybookMatcher {
  let call = 0;
  const db = {
    select: () => ({
      from: () => {
        // First select is installedPacks, second is the join.
        call += 1;
        return call === 1
          ? builder(installedPacks.map((packId) => ({ packId })))
          : builder(joined);
      },
    }),
  } as unknown as Db;

  return new PlaybookMatcher({ db, logger });
}

const trigger = (over: Partial<OutreachTrigger> = {}): OutreachTrigger => ({
  type: 'event',
  tenantId: 't-1',
  eventType: 'APPOINTMENT_REMINDER',
  payload: {},
  correlationId: 'corr-1',
  ...over,
});

describe('eventType matching', () => {
  it('matches exactly', async () => {
    const m = matcher([
      { playbook: playbook(), trigger: triggerRow({ eventType: 'APPOINTMENT_REMINDER' }) },
    ]);
    expect(await m.match(trigger())).toHaveLength(1);
  });

  it('does not match a different event', async () => {
    const m = matcher([
      { playbook: playbook(), trigger: triggerRow({ eventType: 'PATIENT_BIRTHDAY' }) },
    ]);
    expect(await m.match(trigger())).toHaveLength(0);
  });

  it('is not a prefix or substring match', async () => {
    const m = matcher([
      { playbook: playbook(), trigger: triggerRow({ eventType: 'APPOINTMENT' }) },
    ]);
    expect(await m.match(trigger())).toHaveLength(0);
  });

  it('accepts declared aliases — the enum and the switch disagree in the source', async () => {
    // models/communication.model.ts declares APPOINTMENT_RESCHEDULED; the switch
    // matches APPOINTMENT_RESCHEDULING. Both are in production callers.
    const m = matcher([
      {
        playbook: playbook({ key: 'medspa.appointment-rescheduling' }),
        trigger: triggerRow({
          eventType: 'APPOINTMENT_RESCHEDULING',
          eventTypeAliases: ['APPOINTMENT_RESCHEDULED'],
        }),
      },
    ]);
    expect(await m.match(trigger({ eventType: 'APPOINTMENT_RESCHEDULED' }))).toHaveLength(1);
  });

  it('a trigger declaring no eventType matches any event of its type', async () => {
    // Schedule and manual triggers have no event to match on.
    const m = matcher([{ playbook: playbook(), trigger: triggerRow({}) }]);
    expect(await m.match(trigger({ eventType: 'ANYTHING_AT_ALL' }))).toHaveLength(1);
  });
});

describe('where predicates gate the match', () => {
  it('excludes a playbook whose predicate fails', async () => {
    const m = matcher([
      {
        playbook: playbook(),
        trigger: triggerRow({
          eventType: 'APPOINTMENT_REMINDER',
          where: { 'patient.tier': { eq: 'vip' } },
        }),
      },
    ]);

    expect(await m.match(trigger({ payload: { patient: { tier: 'basic' } } }))).toHaveLength(0);
    expect(await m.match(trigger({ payload: { patient: { tier: 'vip' } } }))).toHaveLength(1);
  });
});

describe('ordering', () => {
  it('runs lower priority numbers first, as the column documents', async () => {
    const m = matcher([
      {
        playbook: playbook({ id: 'b', key: 'second', priority: 200 }),
        trigger: triggerRow({ eventType: 'APPOINTMENT_REMINDER' }, { id: 'tb' }),
      },
      {
        playbook: playbook({ id: 'a', key: 'first', priority: 10 }),
        trigger: triggerRow({ eventType: 'APPOINTMENT_REMINDER' }, { id: 'ta' }),
      },
    ]);

    const matched = await m.match(trigger());
    expect(matched.map((x) => x.playbook.key)).toEqual(['first', 'second']);
  });

  it('lets one trigger fire several playbooks', async () => {
    const m = matcher([
      {
        playbook: playbook({ id: 'a', key: 'one' }),
        trigger: triggerRow({ eventType: 'APPOINTMENT_REMINDER' }, { id: 't1' }),
      },
      {
        playbook: playbook({ id: 'b', key: 'two' }),
        trigger: triggerRow({ eventType: 'APPOINTMENT_REMINDER' }, { id: 't2' }),
      },
    ]);
    expect(await m.match(trigger())).toHaveLength(2);
  });
});
