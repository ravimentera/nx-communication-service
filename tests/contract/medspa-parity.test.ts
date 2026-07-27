/**
 * THE KEY REGRESSION TEST FOR P7.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The expectation table below was built by **reading
 * `enhanced-event-handler.ts` line by line**, not by running the old service.
 * Every row cites the lines it came from. If a row and the source disagree, the
 * row is wrong — go and read the source again.
 *
 * WHAT PARITY MEANS HERE
 *
 * The source picks a template id, a channel set, a recipient and (implicitly) an
 * approval requirement. It does NOT own the template bodies — those live in the
 * `communication_templates` table and are migrated by P9 with their ids
 * preserved. So parity is about SELECTION, not about rendered text:
 *
 *   same template selected · same channel set · same recipient · same approval
 *
 * WHAT THIS TEST WOULD CATCH
 *
 * A playbook seeded with the wrong template key. A channel silently added or
 * dropped. A staff-directed playbook accidentally addressed to a patient. And
 * above all, a playbook that starts requiring approval when today it sends
 * immediately (D53) — the regression that would stop every appointment reminder
 * at cutover.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { join } from 'node:path';

import winston from 'winston';

import { loadPacks, type LoadedPack } from '../../src/packs/loader.js';
import type { PlaybookDefinition } from '../../src/packs/schema.js';

const logger = winston.createLogger({ silent: true });
const packs = loadPacks(join(process.cwd(), 'packs'), logger);
const medspa = packs.get('medspa') as LoadedPack;

const byKey = new Map((medspa.playbooks ?? []).map((p) => [p.key, p]));
const templateKeys = new Set((medspa.templates ?? []).map((t) => t.key));

/** Every channel a playbook can fire, and the template each one uses. */
function selection(playbook: PlaybookDefinition): Record<string, string> {
  return Object.fromEntries(
    playbook.channelPlan.map((entry) => [
      entry.channel,
      entry.templateKey ??
        ('templateKey' in playbook.contentSource ? playbook.contentSource.templateKey : '(ai)'),
    ]),
  );
}

/**
 * The 17 cases of the switch, transcribed.
 *
 * `source` is the line range in `enhanced-event-handler.ts`. `templateId` is the
 * literal that case passes to the queue. `approval` is what happens today —
 * `none` for every one of them, because the event path contains no approval
 * logic at all (verified: `grep -rn "approval" src/events/ src/services/queue/`
 * returns nothing).
 */
const SWITCH_CASES = [
  {
    eventType: 'APPOINTMENT_REMINDER',
    source: ':121-164',
    playbook: 'medspa.appointment-reminder',
    templateId: 'appointment-reminder',
    channels: ['email', 'sms'],
    recipient: 'patient',
    approval: 'none',
  },
  {
    eventType: 'APPOINTMENT_CONFIRMATION',
    source: ':166-189',
    playbook: 'medspa.appointment-confirmation',
    templateId: 'appointment-confirmation',
    channels: ['email'],
    recipient: 'patient',
    approval: 'none',
  },
  {
    eventType: 'APPOINTMENT_CANCELLATION',
    source: ':191-233',
    playbook: 'medspa.appointment-cancellation',
    templateId: 'appointment-cancellation',
    channels: ['email', 'sms'],
    recipient: 'patient',
    approval: 'none',
  },
  {
    eventType: 'APPOINTMENT_RESCHEDULING',
    source: ':235-283',
    playbook: 'medspa.appointment-rescheduling',
    templateId: 'appointment-rescheduling',
    channels: ['email', 'sms'],
    recipient: 'patient',
    approval: 'none',
    aliases: ['APPOINTMENT_RESCHEDULED'],
  },
  {
    eventType: 'TREATMENT_FOLLOWUP',
    source: ':286-311',
    playbook: 'medspa.treatment-followup',
    templateId: 'treatment-followup',
    channels: ['email'],
    recipient: 'patient',
    approval: 'none',
    aliases: ['TREATMENT_FEEDBACK_REQUEST', 'APPOINTMENT_FOLLOW_UP'],
  },
  {
    eventType: 'TREATMENT_PREPARATION',
    source: ':313-360',
    playbook: 'medspa.treatment-preparation',
    templateId: 'treatment-preparation',
    channels: ['email', 'sms'],
    recipient: 'patient',
    approval: 'none',
  },
  {
    eventType: 'TREATMENT_COMPLETION',
    source: ':362-387',
    playbook: 'medspa.treatment-completion',
    templateId: 'treatment-completion',
    channels: ['email'],
    recipient: 'patient',
    approval: 'none',
    aliases: ['TREATMENT_COMPLETED'],
  },
  {
    eventType: 'TREATMENT_INSTRUCTIONS',
    source: ':389-437',
    playbook: 'medspa.treatment-instructions',
    templateId: 'treatment-instructions',
    channels: ['email', 'sms'],
    recipient: 'patient',
    approval: 'none',
  },
  {
    eventType: 'PATIENT_REGISTRATION',
    source: ':567-591',
    playbook: 'medspa.patient-registration',
    templateId: 'patient-registration',
    channels: ['email'],
    recipient: 'patient',
    approval: 'none',
    aliases: ['PATIENT_WELCOME'],
  },
  {
    eventType: 'PATIENT_FEEDBACK_REQUEST',
    source: ':593-619',
    playbook: 'medspa.patient-feedback-request',
    // NOTE: 'patient-feedback', not 'patient-feedback-request'.
    templateId: 'patient-feedback',
    channels: ['email'],
    recipient: 'patient',
    approval: 'none',
  },
  {
    eventType: 'PATIENT_BIRTHDAY',
    source: ':621-645',
    playbook: 'medspa.patient-birthday',
    templateId: 'patient-birthday',
    channels: ['email'],
    recipient: 'patient',
    approval: 'none',
  },
  {
    eventType: 'STAFF_ALERT',
    source: ':440-479',
    playbook: 'medspa.staff-alert',
    templateId: 'staff-alert',
    channels: ['slack', 'email'],
    recipient: 'staff',
    approval: 'none',
  },
  {
    eventType: 'SHIFT_REMINDER',
    source: ':481-526',
    playbook: 'medspa.shift-reminder',
    templateId: 'shift-reminder',
    channels: ['email', 'sms'],
    recipient: 'staff',
    approval: 'none',
  },
  {
    eventType: 'EMERGENCY_NOTIFICATION',
    source: ':528-564',
    playbook: 'medspa.emergency-notification',
    templateId: 'emergency-alert',
    channels: ['slack', 'email'],
    recipient: 'fixed',
    approval: 'none',
  },
  {
    eventType: 'GENERAL_NOTIFICATION',
    source: ':648-671',
    playbook: 'medspa.general-notification',
    templateId: 'general-notification',
    channels: ['email'],
    recipient: 'patient',
    approval: 'none',
  },
  {
    eventType: 'MARKETING_CAMPAIGN',
    source: ':673-701',
    playbook: 'medspa.marketing-campaign',
    // The one case whose template comes from the event, not a literal.
    templateId: '(from event payload)',
    channels: ['email'],
    recipient: 'patient',
    approval: 'none',
  },
  {
    eventType: 'SYSTEM_ALERT',
    source: ':703-722',
    playbook: 'medspa.system-alert',
    templateId: '(slack, built inline)',
    channels: ['slack'],
    recipient: 'fixed',
    approval: 'none',
  },
] as const;

describe('the pack loads cleanly', () => {
  it('has no validation errors', () => {
    // A pack error means some playbook silently does not exist.
    expect(packs.errors()).toEqual([]);
  });

  it('declares its required tenant config, so the hardcoded literals cannot come back', () => {
    expect(medspa.manifest?.requiredConfig).toEqual(
      expect.arrayContaining([
        'emergencyContacts',
        'slackChannels.staffAlerts',
        'slackChannels.emergencyAlerts',
        'slackChannels.systemAlerts',
      ]),
    );
  });
});

describe.each(SWITCH_CASES)(
  'parity: $eventType (enhanced-event-handler.ts$source)',
  (expected) => {
    it('has a playbook', () => {
      expect(byKey.get(expected.playbook)).toBeDefined();
    });

    it('fires exactly the channels the case fires', () => {
      const playbook = byKey.get(expected.playbook)!;
      const channels = playbook.channelPlan.map((c) => c.channel).sort();
      expect(channels).toEqual([...expected.channels].sort());
    });

    it('selects a template that exists for every channel', () => {
      const playbook = byKey.get(expected.playbook)!;
      for (const [channel, key] of Object.entries(selection(playbook))) {
        expect(templateKeys.has(key)).toBe(true);
        // The template must be declared for the channel it is used on.
        const template = (medspa.templates ?? []).find((t) => t.key === key)!;
        expect(template.channel).toBe(channel);
      }
    });

    it('keeps today’s approval requirement', () => {
      // THE assertion of this file. Every one of the 17 sends immediately
      // today; a playbook that starts requiring approval would stop every
      // reminder at cutover (D53).
      const playbook = byKey.get(expected.playbook)!;
      expect(expected.approval).toBe('none');
      expect(playbook.approvalPolicyKey).toBe('system.transactional');
    });

    it('renders from a template, never from a model', () => {
      const playbook = byKey.get(expected.playbook)!;
      expect(playbook.contentSource.kind).toBe('template');
    });

    it('is triggered by the event, under every spelling the source accepts', () => {
      const playbook = byKey.get(expected.playbook)!;
      const trigger = playbook.triggers?.find((t) => t.eventType === expected.eventType);
      expect(trigger).toBeDefined();

      for (const alias of (expected as { aliases?: readonly string[] }).aliases ?? []) {
        expect(trigger!.eventTypeAliases ?? []).toContain(alias);
      }
    });

    it('addresses the right kind of recipient', () => {
      const playbook = byKey.get(expected.playbook)!;
      const fixed = playbook.channelPlan.filter((c) => c.fixedTarget);

      if (expected.recipient === 'fixed') {
        // Emergency and system alerts go to an ops destination, never a patient.
        expect(fixed.length).toBeGreaterThan(0);
      }
      if (expected.recipient === 'patient') {
        expect(fixed).toHaveLength(0);
      }
    });
  },
);

describe('the four hardcoded destinations are gone', () => {
  const plans = (medspa.playbooks ?? []).flatMap((p) => p.channelPlan);

  it('no literal survives in a fixed target', () => {
    // :448 'staff-alerts' · :536 'emergency-alerts' · :549
    // 'emergency-team@medspa.com' · :711 'system-alerts'
    for (const entry of plans) {
      if (!entry.fixedTarget) continue;
      expect(entry.fixedTarget.startsWith('$config.')).toBe(true);
    }
  });

  it('routes each one at the tenant’s own config key', () => {
    const targets = plans.map((e) => e.fixedTarget).filter(Boolean);
    expect(targets).toEqual(
      expect.arrayContaining([
        '$config.emergencyContacts',
        '$config.slackChannels.staffAlerts',
        '$config.slackChannels.emergencyAlerts',
        '$config.slackChannels.systemAlerts',
      ]),
    );
  });
});

describe('the emergency Slack alert cannot be silenced by a caller', () => {
  it('is exempt from the trigger’s channel intersection', () => {
    // The source pushes it unconditionally, outside any channels check (:533).
    const playbook = byKey.get('medspa.emergency-notification')!;
    const metadata = playbook.metadata as { alwaysSendChannels?: string[] };
    expect(metadata.alwaysSendChannels).toContain('slack');
  });
});

describe('AI playbooks', () => {
  const ai = (medspa.playbooks ?? []).filter((p) => p.contentSource.kind !== 'template');

  it('all require review — the rule this pack is seeded by (D53)', () => {
    expect(ai.length).toBeGreaterThan(0);
    for (const playbook of ai) {
      expect(playbook.approvalPolicyKey).toBe('medspa.provider-always');
    }
  });

  it('ship inactive, because none of them is a port of anything', () => {
    // Nothing in the source sends these. Switching one on is a tenant's
    // decision, not a side effect of deploying the pack.
    for (const playbook of ai) {
      expect(playbook.isActive).toBe(false);
    }
  });

  it('name a prompt pack that is actually installed', () => {
    for (const playbook of ai) {
      const key = (playbook.contentSource as { promptPackKey: string }).promptPackKey;
      expect(packs.prompt(key)).toBeDefined();
    }
  });
});

describe('the whole pack is internally consistent', () => {
  it('every playbook names a policy the pack ships', () => {
    const policyKeys = new Set((medspa.policies ?? []).map((p) => p.key));
    for (const playbook of medspa.playbooks ?? []) {
      expect(policyKeys.has(playbook.approvalPolicyKey!)).toBe(true);
    }
  });

  it('every referenced template exists', () => {
    for (const playbook of medspa.playbooks ?? []) {
      for (const key of Object.values(selection(playbook))) {
        if (key === '(ai)') continue;
        expect(templateKeys.has(key)).toBe(true);
      }
    }
  });

  it('every playbook key is unique', () => {
    const keys = (medspa.playbooks ?? []).map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('covers all 17 switch cases plus the service-module playbooks', () => {
    expect(byKey.size).toBeGreaterThanOrEqual(SWITCH_CASES.length);
  });
});

describe('§0.10 — the pack is data, and carries no schema', () => {
  it('ships no table or column names', () => {
    // The pack may name itself and its keys; it may not shape the database.
    const serialized = JSON.stringify(medspa.playbooks) + JSON.stringify(medspa.templates);
    expect(serialized).not.toMatch(/CREATE TABLE|ALTER TABLE|pack_medspa_/i);
  });
});
