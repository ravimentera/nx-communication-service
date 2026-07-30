/**
 * EHR event → outreach trigger, driven by pack data.
 *
 * Replaces `services/event-mapper.service.ts` (351L), which is three hardcoded
 * layers in TypeScript:
 *
 *  1. a `Record<string, MappedCommunicationEvent>` of nine direct mappings
 *     (`:61-140`) — DrChrono, Athena and Epic event names, each with a target
 *     `EventType`, priority, channel and a `reasonForDecision` string
 *  2. `getPatternBasedMapping` (`:147-200`), a chain of
 *     `ehrEventType.includes('appointment') && …includes('missed')` tests
 *  3. `getContextualMapping`, a fallback that guesses
 *
 * All three are **data about a vertical's EHR vendors**, in the engine's code.
 * Adding Cerner means editing a TypeScript file and shipping a release; the
 * mapping is exactly the kind of thing §0.10 tier 1 says belongs to a pack.
 *
 * Here the engine owns the *matching algorithm* — exact, then prefix/contains
 * rules in declared order — and `packs/<id>/ehr-mapping.json` owns every name.
 *
 * **The contextual fallback is not ported.** `getContextualMapping` returns a
 * mapping for an event it does not recognise, so an unknown EHR event still
 * produces a message — chosen by a heuristic nobody reviewed, sent to a
 * patient. An unmapped event is now `null`, which the caller reports as
 * `mapped: false`. Guessing what a clinic meant is not a safe default when the
 * output is a message to their patient.
 */
import type { Priority } from '../../domain/index.js';
import type { ChannelType } from '../../ports/channel.js';

/** One entry of `packs/<id>/ehr-mapping.json`. */
export interface EhrMappingRule {
  /** Exact EHR event name. Checked before any pattern. */
  event?: string;
  /**
   * Substrings that must ALL appear in the EHR event name. Reproduces the
   * source's nested `includes()` chains without the nesting.
   */
  contains?: string[];
  /** Optional source system filter, e.g. `drchrono`. */
  source?: string;
  /** The outreach event type to trigger. */
  eventType: string;
  priority?: Priority;
  channels?: ChannelType[];
  /** Merged into the trigger's context. */
  metadata?: Record<string, unknown>;
  /** Why this rule exists — surfaced by the preview endpoint. */
  reason?: string;
}

export interface EhrMapping {
  rules: EhrMappingRule[];
}

export interface MappedEhrEvent {
  eventType: string;
  priority?: Priority;
  channels?: ChannelType[];
  metadata: Record<string, unknown>;
  reason?: string;
  /** Which rule matched, so a preview can explain itself. */
  matchedBy: 'exact' | 'contains';
}

/**
 * Resolve one EHR event.
 *
 * Exact matches win over pattern matches, and within each tier the **first
 * declared rule wins** — order in the file is the tie-break, which is what
 * makes a pack author able to reason about overlap. The source's precedence is
 * the same in effect but emergent from the order of `if` statements.
 */
export function mapEhrEvent(
  mapping: EhrMapping,
  input: { ehrEventType: string; ehrSource?: string },
): MappedEhrEvent | null {
  const name = input.ehrEventType.toLowerCase();
  const source = input.ehrSource?.toLowerCase();

  const applies = (rule: EhrMappingRule): boolean =>
    !rule.source || rule.source.toLowerCase() === source;

  for (const rule of mapping.rules) {
    if (rule.event && rule.event.toLowerCase() === name && applies(rule)) {
      return toMapped(rule, 'exact');
    }
  }

  for (const rule of mapping.rules) {
    if (!rule.contains?.length || !applies(rule)) continue;
    if (rule.contains.every((needle) => name.includes(needle.toLowerCase()))) {
      return toMapped(rule, 'contains');
    }
  }

  // No guess. See the file header.
  return null;
}

function toMapped(rule: EhrMappingRule, matchedBy: 'exact' | 'contains'): MappedEhrEvent {
  return {
    eventType: rule.eventType,
    priority: rule.priority,
    channels: rule.channels,
    metadata: rule.metadata ?? {},
    reason: rule.reason,
    matchedBy,
  };
}
