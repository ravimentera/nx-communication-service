/**
 * Compliance profiles.
 *
 * `tenants.compliance_profile` existed from P2 and, until P12, was read by
 * exactly one thing: the prompt assembler, which passed it to the model as
 * background prose. A tenant marked `hipaa` therefore got a sentence in a
 * prompt and no rule behaved differently anywhere.
 */
import {
  gdprRequiresConsent,
  isMarketing,
  parseComplianceProfile,
  phiBlocked,
  phiChannelIsUnsecured,
  tcpaWindow,
  TCPA_QUIET_END,
  TCPA_QUIET_START,
} from '../../../src/engine/compliance/profiles.js';

describe('parseComplianceProfile', () => {
  it('turns can-spam and tcpa on for everyone', () => {
    // They are US law about commercial email and text messages, not a property
    // of an industry. An opt-in flag would mean an unset field opts out.
    expect(parseComplianceProfile({})).toMatchObject({ canSpam: true, tcpa: true });
  });

  it('ignores an attempt to switch them off', () => {
    const profile = parseComplianceProfile({ canSpam: false, tcpa: false });
    expect(profile.canSpam).toBe(true);
    expect(profile.tcpa).toBe(true);
  });

  it('treats hipaa and gdpr as opt-in add-ons', () => {
    expect(parseComplianceProfile({})).toMatchObject({ hipaa: false, gdpr: false });
    expect(parseComplianceProfile({ hipaa: true, gdpr: true })).toMatchObject({
      hipaa: true,
      gdpr: true,
    });
  });

  it('only accepts a literal true, not anything truthy', () => {
    // The column is jsonb written by hand as often as by code; `"false"` and
    // `1` should not silently enable an obligation.
    expect(parseComplianceProfile({ hipaa: 'true' }).hipaa).toBe(false);
    expect(parseComplianceProfile({ hipaa: 1 }).hipaa).toBe(false);
  });

  it.each([
    ['null', null],
    ['a string', 'hipaa'],
    ['an array', ['hipaa']],
    ['undefined', undefined],
  ])('falls back to the defaults for %s rather than throwing', (_label, raw) => {
    // A malformed profile must not stop a tenant sending — and must not turn
    // CAN-SPAM and TCPA off either.
    expect(parseComplianceProfile(raw)).toMatchObject({
      canSpam: true,
      tcpa: true,
      hipaa: false,
      gdpr: false,
    });
  });

  it('reads a positive retention period and ignores anything else', () => {
    expect(parseComplianceProfile({ retentionDays: 90 }).retentionDays).toBe(90);
    expect(parseComplianceProfile({ retentionDays: 0 }).retentionDays).toBeUndefined();
    expect(parseComplianceProfile({ retentionDays: -1 }).retentionDays).toBeUndefined();
    expect(parseComplianceProfile({ retentionDays: 'lots' }).retentionDays).toBeUndefined();
  });
});

describe('isMarketing', () => {
  it('is everything not explicitly transactional', () => {
    expect(isMarketing({})).toBe(true);
    expect(isMarketing({ transactional: false })).toBe(true);
    expect(isMarketing({ transactional: true })).toBe(false);
  });
});

describe('tcpaWindow', () => {
  const NY = 'America/New_York';
  /** 03:00 in New York. */
  const threeAmNy = new Date('2026-06-15T07:00:00Z');
  /** 14:00 in New York. */
  const twoPmNy = new Date('2026-06-15T18:00:00Z');

  it('is 8am to 9pm, so 21:01 to 07:59 is the closed window', () => {
    expect(TCPA_QUIET_START).toBe('21:01');
    expect(TCPA_QUIET_END).toBe('07:59');
  });

  it('closes a marketing text at 3am local', () => {
    expect(tcpaWindow('sms', NY, threeAmNy).inQuietHours).toBe(true);
  });

  it('opens it in the afternoon', () => {
    expect(tcpaWindow('sms', NY, twoPmNy).inQuietHours).toBe(false);
  });

  it('reports when the window ends, because a defer needs a time', () => {
    const verdict = tcpaWindow('sms', NY, threeAmNy);
    expect(verdict.endsAt).toBeInstanceOf(Date);
    expect(verdict.endsAt!.getTime()).toBeGreaterThan(threeAmNy.getTime());
  });

  it('uses the recipient’s zone, not the server’s', () => {
    // The same instant is 3am in New York and 8am in London. This is the class
    // of defect D34 exists for.
    expect(tcpaWindow('sms', NY, threeAmNy).inQuietHours).toBe(true);
    expect(tcpaWindow('sms', 'Europe/London', threeAmNy).inQuietHours).toBe(false);
  });

  it.each(['email', 'slack', 'push', 'webhook', 'in_app'] as const)(
    'does not apply to %s — TCPA is about calls and texts',
    (channel) => {
      expect(tcpaWindow(channel, NY, threeAmNy).inQuietHours).toBe(false);
    },
  );

  it('applies to voice as well as sms', () => {
    expect(tcpaWindow('voice', NY, threeAmNy).inQuietHours).toBe(true);
  });
});

describe('phiBlocked', () => {
  const hipaa = parseComplianceProfile({ hipaa: true });
  const plain = parseComplianceProfile({});
  const phiWarning = ['PHI pattern matched: MRN-12345'];

  it('blocks a PHI warning on an unsecured channel under hipaa', () => {
    expect(phiBlocked(hipaa, 'sms', phiWarning)).toBe(true);
    expect(phiBlocked(hipaa, 'slack', phiWarning)).toBe(true);
  });

  it('does nothing for a tenant without the profile', () => {
    // For everyone else a PHI pattern stays what P5 made it: a warning on the
    // draft that lowers aiConfidence.
    expect(phiBlocked(plain, 'sms', phiWarning)).toBe(false);
  });

  it('does not block email', () => {
    // A judgement, not an oversight: every tenant sends email through a
    // provider under contract, and blocking it would stop the appointment
    // reminders the medspa pack exists for.
    expect(phiBlocked(hipaa, 'email', phiWarning)).toBe(false);
    expect(phiChannelIsUnsecured('email')).toBe(false);
  });

  it('ignores warnings that are not about PHI', () => {
    expect(phiBlocked(hipaa, 'sms', ['message exceeds 320 characters'])).toBe(false);
    expect(phiBlocked(hipaa, 'sms', ['contains a prohibited phrase: cure'])).toBe(false);
  });

  it('handles no warnings at all', () => {
    expect(phiBlocked(hipaa, 'sms', undefined)).toBe(false);
    expect(phiBlocked(hipaa, 'sms', [])).toBe(false);
  });
});

describe('gdprRequiresConsent', () => {
  const gdpr = parseComplianceProfile({ gdpr: true });

  it('requires consent for marketing whatever require_opt_in says', () => {
    expect(gdprRequiresConsent(gdpr, {})).toBe(true);
  });

  it('leaves transactional messages alone', () => {
    // An appointment reminder is performance of a contract, not marketing.
    expect(gdprRequiresConsent(gdpr, { transactional: true })).toBe(false);
  });

  it('does nothing without the profile', () => {
    expect(gdprRequiresConsent(parseComplianceProfile({}), {})).toBe(false);
  });
});
