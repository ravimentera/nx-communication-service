/**
 * Quiet hours. Ported from `preference.service.ts:331-366`.
 *
 * The arithmetic is preserved exactly, including the cross-midnight branch
 * (`start > end` ⇒ `now >= start || now <= end`), because it is correct and a
 * rewrite risks breaking a rule that decides whether someone gets woken up.
 *
 * FOUR CHANGES:
 *
 *  1. **`hourCycle: 'h23'` instead of `hour12: false`.** With `en-US` and
 *     `hour12: false`, some ICU versions format midnight as `24:00` rather than
 *     `00:00` — the source's `:341-346` is exposed to that. `24 * 60 = 1440`
 *     minutes then compares as *after* every quiet-hours window, so a message at
 *     midnight would escape a 22:00–06:00 window on those builds. `h23` pins it.
 *
 *  2. **The timezone comes from the stored preference**, not from a config
 *     lookup at check time. `recipient_preferences.quiet_hours_timezone` was
 *     added in P2 precisely so this function stops guessing.
 *
 *  3. **It returns *when* the window ends**, not just whether we are in it. P5
 *     defers into quiet hours rather than dropping, and a defer needs a time.
 *
 *  4. **Explicit `now`** so DST and midnight cases are testable without
 *     mocking the clock.
 */

export interface QuietHoursWindow {
  /** 'HH:MM', 24-hour. */
  start: string;
  end: string;
  /** IANA zone. Falls back to the tenant default when absent. */
  timezone: string;
}

export interface QuietHoursVerdict {
  inQuietHours: boolean;
  /** When the window ends, in UTC. Only set when `inQuietHours`. */
  endsAt?: Date;
}

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function parseTimeToMinutes(value: string): number | null {
  const match = TIME_RE.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Wall-clock minutes-since-midnight for `at` in `timezone`. */
export function minutesInZone(at: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: timezone,
  }).formatToParts(at);

  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  // h23 gives 00-23, but guard anyway — this is the bug being defended against.
  return (hour % 24) * 60 + minute;
}

export function evaluateQuietHours(
  window: QuietHoursWindow,
  at: Date = new Date(),
): QuietHoursVerdict {
  const start = parseTimeToMinutes(window.start);
  const end = parseTimeToMinutes(window.end);
  if (start === null || end === null) return { inQuietHours: false };

  // A window whose start equals its end is a no-op, not a 24-hour block.
  if (start === end) return { inQuietHours: false };

  const now = minutesInZone(at, window.timezone);

  const inWindow =
    start > end
      ? now >= start || now <= end // crosses midnight, e.g. 22:00 → 06:00
      : now >= start && now <= end; // same day, e.g. 00:00 → 06:00

  if (!inWindow) return { inQuietHours: false };

  return { inQuietHours: true, endsAt: nextOccurrenceOf(end, window.timezone, at) };
}

/**
 * The next UTC instant at which local wall-clock time in `timezone` is
 * `minutes` past midnight.
 *
 * Computed by probing rather than by offset arithmetic: on a DST boundary the
 * offset changes *inside* the window, so adding a fixed delta lands in the wrong
 * hour. Probing at minute granularity is exact and costs nothing at this rate.
 */
export function nextOccurrenceOf(minutes: number, timezone: string, from: Date): Date {
  const startMs = from.getTime();
  // Walk forward a minute at a time, up to 25 hours to cover a DST-lengthened day.
  for (let step = 1; step <= 25 * 60; step += 1) {
    const candidate = new Date(startMs + step * 60_000);
    if (minutesInZone(candidate, timezone) === minutes) return candidate;
  }
  // Unreachable for a valid zone; fall back to 24h so a caller always gets a date.
  return new Date(startMs + 24 * 60 * 60_000);
}
