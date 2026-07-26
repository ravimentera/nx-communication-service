import {
  evaluateQuietHours,
  minutesInZone,
  nextOccurrenceOf,
  parseTimeToMinutes,
} from '../../../src/engine/compliance/quiet-hours.js';

/** A UTC instant that is a given local time in a given zone, for readability. */
const at = (iso: string) => new Date(iso);

describe('parseTimeToMinutes', () => {
  it.each([
    ['00:00', 0],
    ['06:30', 390],
    ['22:00', 1320],
    ['23:59', 1439],
    ['9:05', 545],
  ])('parses %s', (input, expected) => {
    expect(parseTimeToMinutes(input)).toBe(expected);
  });

  it.each(['24:00', '25:00', '12:60', 'nope', '', '12'])('rejects %s', (input) => {
    expect(parseTimeToMinutes(input)).toBeNull();
  });
});

describe('minutesInZone', () => {
  it('reports wall-clock minutes in the target zone', () => {
    // 2026-01-15T17:30Z is 12:30 in New York (UTC-5 in January).
    expect(minutesInZone(at('2026-01-15T17:30:00Z'), 'America/New_York')).toBe(12 * 60 + 30);
    expect(minutesInZone(at('2026-01-15T17:30:00Z'), 'UTC')).toBe(17 * 60 + 30);
  });

  it('reports midnight as 0, never 1440', () => {
    // The `hour12: false` bug this guards against formats midnight as "24:00"
    // on some ICU builds, which then compares as after every quiet window.
    expect(minutesInZone(at('2026-01-15T05:00:00Z'), 'America/New_York')).toBe(0);
    expect(minutesInZone(at('2026-01-15T00:00:00Z'), 'UTC')).toBe(0);
  });
});

describe('cross-midnight windows', () => {
  const window = { start: '22:00', end: '06:00', timezone: 'America/New_York' };

  it.each([
    ['23:00 local — inside', '2026-01-16T04:00:00Z', true],
    ['00:00 local — inside', '2026-01-16T05:00:00Z', true],
    ['02:00 local — inside', '2026-01-16T07:00:00Z', true],
    ['06:00 local — inside (boundary is inclusive)', '2026-01-16T11:00:00Z', true],
    ['07:00 local — outside', '2026-01-16T12:00:00Z', false],
    ['12:00 local — outside', '2026-01-16T17:00:00Z', false],
    ['21:59 local — outside', '2026-01-16T02:59:00Z', false],
    ['22:00 local — inside (boundary is inclusive)', '2026-01-16T03:00:00Z', true],
  ])('%s', (_name, iso, expected) => {
    expect(evaluateQuietHours(window, at(iso)).inQuietHours).toBe(expected);
  });
});

describe('same-day windows', () => {
  const window = { start: '00:00', end: '06:00', timezone: 'UTC' };

  it.each([
    ['03:00 — inside', '2026-01-15T03:00:00Z', true],
    ['06:00 — inside', '2026-01-15T06:00:00Z', true],
    ['06:01 — outside', '2026-01-15T06:01:00Z', false],
    ['23:00 — outside', '2026-01-15T23:00:00Z', false],
  ])('%s', (_name, iso, expected) => {
    expect(evaluateQuietHours(window, at(iso)).inQuietHours).toBe(expected);
  });
});

describe('timezone matters', () => {
  it('the same instant is quiet in one zone and not another', () => {
    const instant = at('2026-01-16T04:00:00Z'); // 23:00 New York, 04:00 UTC
    expect(
      evaluateQuietHours({ start: '22:00', end: '06:00', timezone: 'America/New_York' }, instant)
        .inQuietHours,
    ).toBe(true);
    expect(
      evaluateQuietHours({ start: '22:00', end: '23:00', timezone: 'UTC' }, instant).inQuietHours,
    ).toBe(false);
  });
});

describe('DST', () => {
  it('is correct on the spring-forward night in New York', () => {
    // 2026-03-08: clocks jump 02:00 -> 03:00 local. 06:30Z is 01:30 EST.
    const window = { start: '22:00', end: '06:00', timezone: 'America/New_York' };
    expect(evaluateQuietHours(window, at('2026-03-08T06:30:00Z')).inQuietHours).toBe(true);
    // 12:00Z is 08:00 EDT — after the window, on the shortened day.
    expect(evaluateQuietHours(window, at('2026-03-08T12:00:00Z')).inQuietHours).toBe(false);
  });

  it('computes an end time that lands on the right local hour across a DST change', () => {
    const from = at('2026-03-08T06:30:00Z'); // 01:30 EST, inside 22:00-06:00
    const endsAt = nextOccurrenceOf(6 * 60, 'America/New_York', from);
    expect(minutesInZone(endsAt, 'America/New_York')).toBe(6 * 60);
    // Offset arithmetic would have produced 11:00Z (=06:00 EST); the real
    // answer is 10:00Z, because the clocks moved forward inside the window.
    expect(endsAt.toISOString()).toBe('2026-03-08T10:00:00.000Z');
  });
});

describe('defer, not block — the window has an end', () => {
  it('reports when the window ends', () => {
    const verdict = evaluateQuietHours(
      { start: '22:00', end: '06:00', timezone: 'UTC' },
      at('2026-01-15T23:00:00Z'),
    );
    expect(verdict.inQuietHours).toBe(true);
    expect(verdict.endsAt?.toISOString()).toBe('2026-01-16T06:00:00.000Z');
  });

  it('gives no end time when outside the window', () => {
    const verdict = evaluateQuietHours(
      { start: '22:00', end: '06:00', timezone: 'UTC' },
      at('2026-01-15T12:00:00Z'),
    );
    expect(verdict.endsAt).toBeUndefined();
  });
});

describe('degenerate windows', () => {
  it('treats start == end as no quiet hours, not a 24-hour block', () => {
    expect(
      evaluateQuietHours({ start: '09:00', end: '09:00', timezone: 'UTC' }, at('2026-01-15T09:00:00Z'))
        .inQuietHours,
    ).toBe(false);
  });

  it('ignores an unparseable window rather than blocking everything', () => {
    expect(
      evaluateQuietHours({ start: 'nope', end: '06:00', timezone: 'UTC' }, at('2026-01-15T01:00:00Z'))
        .inQuietHours,
    ).toBe(false);
  });
});
