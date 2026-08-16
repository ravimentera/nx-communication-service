/**
 * IANA timezone validation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A BAD ZONE IS A PERMANENT SEND FAILURE, NOT A BAD REQUEST
 *
 * `quietHoursTimezone` and an import's `timezone` were `z.string()`, so
 * `"EST5EDT"`, `"GMT+2"` or a typo was stored happily. It surfaces much later
 * and much worse: `Intl.DateTimeFormat` throws `RangeError` on an unknown zone,
 * and the place that constructs one is the quiet-hours evaluator — inside the
 * compliance gate, on the send path. Every message to that recipient then fails,
 * for a reason that names a formatting API rather than the field somebody typed.
 *
 * Rejecting at the edge turns a permanent, mystifying failure into a 400 that
 * names the field.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * `Intl.supportedValuesOf` is Node 18+, but guard it anyway: it is the kind of
 * API a runtime can lack, and falling back to a constructor probe is both
 * correct and cheap at the rate this is called.
 */
const SUPPORTED: ReadonlySet<string> | null = (() => {
  try {
    const values = (
      Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
    ).supportedValuesOf?.('timeZone');
    return values ? new Set(values) : null;
  } catch {
    return null;
  }
})();

export function isValidTimezone(value: string): boolean {
  if (!value) return false;
  if (SUPPORTED) return SUPPORTED.has(value);

  try {
    // The same call the quiet-hours evaluator makes, so what passes here is
    // exactly what will not throw there.
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The Zod refinement, so every schema states the rule the same way. */
export const TIMEZONE_ERROR = 'must be a valid IANA timezone, e.g. America/New_York';
