/**
 * The EHR mapper's matching rules.
 *
 * Precedence is the whole design: exact before pattern, declaration order
 * within each tier. It is emergent in the source — the order of `if` statements
 * across three methods — and explicit here, so a pack author can reason about
 * two overlapping rules without reading the engine.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { mapEhrEvent, type EhrMapping } from '../../../src/engine/playbooks/ehr-mapper.js';

const mapping: EhrMapping = {
  rules: [
    { event: 'appointment_no_show', eventType: 'EXACT_WINS', priority: 'HIGH' },
    { contains: ['appointment'], eventType: 'BROAD_PATTERN' },
    { contains: ['appointment', 'reminder'], eventType: 'NARROW_PATTERN' },
    { event: 'visit_done', source: 'epic', eventType: 'EPIC_ONLY' },
    { event: 'visit_done', eventType: 'ANY_SOURCE' },
  ],
};

describe('precedence', () => {
  it('prefers an exact name over any pattern', () => {
    // `appointment_no_show` also matches the broad `contains: ['appointment']`.
    expect(mapEhrEvent(mapping, { ehrEventType: 'appointment_no_show' })).toMatchObject({
      eventType: 'EXACT_WINS',
      matchedBy: 'exact',
    });
  });

  it('takes the first declared pattern, not the most specific', () => {
    // Declaration order is the tie-break, deliberately: "most specific wins"
    // sounds better and is unpredictable once three rules overlap. A pack author
    // orders the file; the engine does not second-guess it.
    expect(mapEhrEvent(mapping, { ehrEventType: 'appointment_reminder_due' })).toMatchObject({
      eventType: 'BROAD_PATTERN',
      matchedBy: 'contains',
    });
  });

  it('requires every `contains` term, not any of them', () => {
    const narrow: EhrMapping = {
      rules: [{ contains: ['treatment', 'completed'], eventType: 'BOTH' }],
    };
    expect(mapEhrEvent(narrow, { ehrEventType: 'treatment_started' })).toBeNull();
    expect(mapEhrEvent(narrow, { ehrEventType: 'treatment_completed' })).not.toBeNull();
  });

  it('is case-insensitive on both sides', () => {
    expect(mapEhrEvent(mapping, { ehrEventType: 'APPOINTMENT_NO_SHOW' })?.eventType).toBe(
      'EXACT_WINS',
    );
  });
});

describe('source filtering', () => {
  it('applies a source-scoped rule only to that source', () => {
    expect(mapEhrEvent(mapping, { ehrEventType: 'visit_done', ehrSource: 'epic' })?.eventType).toBe(
      'EPIC_ONLY',
    );
    expect(
      mapEhrEvent(mapping, { ehrEventType: 'visit_done', ehrSource: 'athena' })?.eventType,
    ).toBe('ANY_SOURCE');
    expect(mapEhrEvent(mapping, { ehrEventType: 'visit_done' })?.eventType).toBe('ANY_SOURCE');
  });
});

describe('unmapped events', () => {
  it('returns null rather than guessing', () => {
    // `getContextualMapping` in the source returns a mapping for anything, so
    // an unrecognised vendor event still sends a patient a message chosen by
    // heuristic. There is no safe default here.
    expect(mapEhrEvent(mapping, { ehrEventType: 'billing_statement_generated' })).toBeNull();
  });

  it('returns null for an empty mapping rather than throwing', () => {
    expect(mapEhrEvent({ rules: [] }, { ehrEventType: 'anything' })).toBeNull();
  });
});

describe('the shipped medspa mapping', () => {
  const shipped = JSON.parse(
    readFileSync(join(process.cwd(), 'packs/medspa/ehr-mapping.json'), 'utf8'),
  ) as EhrMapping;

  it('covers every direct mapping the source hardcoded', () => {
    // event-mapper.service.ts:61-140. If one is dropped, a vendor event that
    // works today silently stops mapping.
    const source = [
      'appointment_missed',
      'appointment_no_show',
      'treatment_completed',
      'appointment_scheduled',
      'patient_created',
      'consultation_completed',
      'athena_appointment_cancelled',
      'athena_treatment_note_added',
      'epic_visit_completed',
    ];
    for (const name of source) {
      expect(mapEhrEvent(shipped, { ehrEventType: name })).not.toBeNull();
    }
  });

  it('reproduces the source’s pattern fallbacks', () => {
    expect(mapEhrEvent(shipped, { ehrEventType: 'drchrono_appointment_missed_today' })).toMatchObject(
      { eventType: 'APPOINTMENT_MISSED' },
    );
    expect(mapEhrEvent(shipped, { ehrEventType: 'some_patient_registered_event' })).toMatchObject({
      eventType: 'PATIENT_REGISTRATION',
    });
    expect(mapEhrEvent(shipped, { ehrEventType: 'procedure_completed_v2' })).toMatchObject({
      eventType: 'TREATMENT_COMPLETION',
    });
  });

  it('every rule names an event type the medspa pack knows', () => {
    const known = new Set<string>();
    const catalogue = JSON.parse(
      readFileSync(join(process.cwd(), 'packs/medspa/event-types.json'), 'utf8'),
    ) as { known?: string[]; aliases?: Record<string, string[]> };
    for (const name of catalogue.known ?? []) known.add(name);
    for (const [canonical, aliases] of Object.entries(catalogue.aliases ?? {})) {
      // `$comment` keys are documentation, not event names.
      if (canonical.startsWith('$')) continue;
      known.add(canonical);
      for (const alias of aliases) known.add(alias);
    }

    // A mapping that targets an event the pack has not declared is a rule that
    // can never fire, and nothing else would notice. This test caught exactly
    // that: `APPOINTMENT_MISSED` is in the source's enum and its EHR mapper,
    // and its 17-case switch has no case for it — so the EHR path for a missed
    // appointment has always been a silent drop. Declared now, so the drop is a
    // SKIPPED run rather than silence.
    for (const rule of shipped.rules) {
      expect(known.has(rule.eventType)).toBe(true);
    }
  });
});
