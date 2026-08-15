/**
 * Compliance profiles — `tenants.compliance_profile` promoted from a column to
 * an enforced ruleset.
 *
 * The column has existed since P2 and, before P12, exactly one thing read it:
 * `prompt-assembler.ts` passed it to the model as background text. So a tenant
 * marked `hipaa` got prose about HIPAA in a prompt, and no rule anywhere
 * behaved differently. That is worse than not having the column, because the
 * record says the obligation is configured.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO ARE DEFAULTS AND TWO ARE ADD-ONS
 *
 * **CAN-SPAM and TCPA apply to every tenant**, because they are not a property
 * of an industry — they are US law about commercial email and about text
 * messages, and this engine sends both. A tenant cannot opt out of them by
 * leaving a field unset, which is what would happen if they were opt-in flags.
 *
 * **HIPAA and GDPR are add-ons**, because they follow from what the tenant is
 * and where its recipients are, and neither can be inferred here.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHAT EACH ONE ACTUALLY DOES — no rule is listed that is not enforced.
 *
 * | Profile   | Enforced here                                                  |
 * |-----------|----------------------------------------------------------------|
 * | can-spam  | an unsubscribe affordance on non-transactional email, and no    |
 * |           | send to an unsubscribed recipient (both predate P12)            |
 * | tcpa      | no marketing SMS or voice outside 8am-9pm in the recipient's    |
 * |           | own local time — deferred, not dropped                          |
 * | hipaa     | content the linter flags as PHI does not go over a channel we   |
 * |           | do not control the transport of                                 |
 * | gdpr      | marketing needs a consent record, whatever `require_opt_in`     |
 * |           | says; plus erasure and export on the recipient API              |
 *
 * Anything a running service cannot check — whether a sender name is
 * misleading, whether a business associate agreement is signed — is not
 * modelled. A profile that claims coverage it does not have is the failure this
 * file exists to end.
 */
import { evaluateQuietHours, type QuietHoursVerdict } from './quiet-hours.js';
import type { ChannelType } from '../../ports/channel.js';

export interface ComplianceProfile {
  /** Always true. Present so a caller reads a profile rather than assuming. */
  canSpam: boolean;
  /** Always true. */
  tcpa: boolean;
  hipaa: boolean;
  gdpr: boolean;
  /** Days after which the retention job may delete. Undefined means unset. */
  retentionDays?: number;
}

/**
 * TCPA's telemarketing window: nothing before 8am or after 9pm in the
 * *recipient's* local time. 21:00 is the last minute a message may be sent, so
 * the quiet window opens at 21:01 and closes at 07:59.
 */
export const TCPA_QUIET_START = '21:01';
export const TCPA_QUIET_END = '07:59';

/** Channels whose transport we do not control end to end. */
const UNSECURED_FOR_PHI: ReadonlySet<ChannelType> = new Set([
  'sms',
  'slack',
  'webhook',
  'push',
] as ChannelType[]);

/**
 * Exported so the gate can decide whether to run the linter at all. Without it
 * the gate would lint every message under a `hipaa` profile, including the
 * email ones the rule never applies to.
 */
export function phiChannelIsUnsecured(channel: ChannelType): boolean {
  return UNSECURED_FOR_PHI.has(channel);
}

/**
 * Read the jsonb column. Anything unparseable yields the defaults rather than
 * throwing: a malformed profile must not stop a tenant sending, and it must not
 * silently turn CAN-SPAM and TCPA off either.
 */
export function parseComplianceProfile(raw: unknown): ComplianceProfile {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};

  const retention = Number(source.retentionDays);

  return {
    // Not read from the column at all. Making them configurable would mean a
    // tenant could switch off the unsubscribe link by writing `false`.
    canSpam: true,
    tcpa: true,
    hipaa: source.hipaa === true,
    gdpr: source.gdpr === true,
    retentionDays: Number.isFinite(retention) && retention > 0 ? retention : undefined,
  };
}

/**
 * Is this a marketing message under TCPA? Transactional messages —
 * appointment reminders, verification codes — are outside the telemarketing
 * rule, which is why `transactional` is a first-class flag on the gate input
 * rather than a guess from the playbook name.
 */
export function isMarketing(input: { transactional?: boolean }): boolean {
  return input.transactional !== true;
}

/**
 * The TCPA window, evaluated in the recipient's own zone.
 *
 * Deliberately separate from the recipient's quiet-hours *preference*: that is
 * a preference, unset for almost everyone, and its absence means "no stated
 * preference" — not "any hour is fine for marketing". Enforcing the statutory
 * window needs its own check, or a tenant with no preferences configured sends
 * marketing texts at 3am and is compliant with everything the engine models.
 */
export function tcpaWindow(
  channel: ChannelType,
  timezone: string,
  at: Date = new Date(),
): QuietHoursVerdict {
  if (channel !== 'sms' && channel !== 'voice') return { inQuietHours: false };
  return evaluateQuietHours(
    { start: TCPA_QUIET_START, end: TCPA_QUIET_END, timezone },
    at,
  );
}

/**
 * Under HIPAA, does this content-and-channel pair need blocking?
 *
 * Reuses the lint pass the content plane already runs — each pack's
 * `compliance.json` carries `phiPatterns`, and P5 shipped the ruleset — so this
 * is not a second, divergent PHI detector. What changes under `hipaa` is the *consequence*: a
 * pattern that is a warning for everyone else stops the send here.
 *
 * Email is not in the unsecured set. That is a judgement, not an oversight:
 * every tenant on this engine sends email through a provider under contract,
 * and treating all email as unsecured would block the appointment reminders
 * that are the point of the medspa pack. A tenant needing more than that needs
 * a secure-messaging channel, which is an adapter, not a flag.
 */
export function phiBlocked(
  profile: ComplianceProfile,
  channel: ChannelType,
  lintWarnings: string[] | undefined,
): boolean {
  if (!profile.hipaa) return false;
  if (!UNSECURED_FOR_PHI.has(channel)) return false;
  return (lintWarnings ?? []).some((warning) => /\bPHI\b/i.test(warning));
}

/** Under GDPR, marketing needs consent regardless of `require_opt_in`. */
export function gdprRequiresConsent(
  profile: ComplianceProfile,
  input: { transactional?: boolean },
): boolean {
  return profile.gdpr && isMarketing(input);
}
