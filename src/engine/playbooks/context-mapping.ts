/**
 * Reshaping a caller's payload into the field names a playbook's contract asks
 * for — declared in the pack, applied before validation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE ENGINE NEEDS THIS AT ALL
 *
 * `aliases.json` rewrites variable names inside a *template body*
 * (`{{patientName}}` → `{{recipient.displayName}}`). It cannot touch the keys of
 * the context itself, so it does nothing for a `dataContract` whose required
 * field is named differently from the field the caller actually sends. That was
 * a real gap and it was hiding a live defect.
 *
 * The four medspa appointment playbooks require `appointmentDate`, `oldDate` and
 * `newDate`. `scheduling-service` — the caller P10 repointed, and the only one
 * sending these events — posts `startTime`, `oldStartTime` and `newStartTime`
 * (`notification.service.ts:86,112,148,175`). Every one of those events fails
 * its contract on arrival: a `FAILED` run row, no message, no appointment
 * reminder. The pack's own descriptions name a *third* shape again
 * (`appointmentDetails.date`), which is what the deleted source read.
 *
 * Three spellings of the same fact, none of them agreeing, is what a mapping is
 * for. Renaming the contract would have picked one caller and broken the others.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FIRST PATH THAT RESOLVES WINS, AND THE CANONICAL NAME COMES FIRST
 *
 *   "appointmentDate": ["appointmentDate", "appointmentDetails.date", "startTime"]
 *
 * A payload that already speaks the contract's language is untouched, because
 * the contract's own name is the first candidate. Everything after it is a
 * legacy or third-party spelling, in the order they should be preferred.
 *
 * Only *absent* target keys are filled. A caller that sent `appointmentDate`
 * explicitly always wins over anything inferred, which is the same precedence
 * `resolveContext` applies between inline context and a fetched one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS NOT
 *
 * Not a transform language. There is no formatting, no arithmetic, no
 * concatenation, no conditionals — the same discipline `where` is held to. If a
 * value needs to be *computed* rather than *found*, that is a named function
 * behind a port, not an expression in a JSON file. Mapping a name to a name is
 * the whole feature.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readPath } from './matcher.js';

/** `playbooks.context_mapping`: target contract field → candidate source paths. */
export type ContextMapping = Record<string, string[]>;

/**
 * Fill missing contract fields from the paths the pack declares.
 *
 * Returns a new object; the caller's context is never mutated, because the raw
 * payload is also what gets written to `outreach_events.data` and an operator
 * asking "what did they actually send?" must get the answer they sent.
 */
export function applyContextMapping(
  mapping: ContextMapping | null | undefined,
  context: Record<string, unknown>,
): Record<string, unknown> {
  if (!mapping || Object.keys(mapping).length === 0) return context;

  const mapped: Record<string, unknown> = { ...context };

  for (const [target, candidates] of Object.entries(mapping)) {
    // An explicit value from the caller is never overwritten.
    if (mapped[target] !== undefined && mapped[target] !== null) continue;

    for (const path of candidates) {
      const value = readPath(context, path);
      if (value !== undefined && value !== null && value !== '') {
        mapped[target] = value;
        break;
      }
    }
  }

  return mapped;
}
