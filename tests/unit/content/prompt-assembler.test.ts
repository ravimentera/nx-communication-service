/**
 * Golden-file assertion on the assembled prompt.
 *
 * This is the regression guard against silent prompt drift: a change to
 * assembly order, to the pack, or to how context is serialised shows up here as
 * a diff rather than as subtly different messages in production.
 */
import winston from 'winston';

import {
  PromptAssembler,
  type PromptPack,
} from '../../../src/engine/content/prompt-assembler.js';
import { emptyContext } from '../../../src/engine/content/render-context.js';
import { Renderer } from '../../../src/engine/content/renderer.js';

const logger = winston.createLogger({ silent: true });

const PACK: PromptPack = {
  key: 'medspa.followup',
  version: 1,
  persona:
    'You are writing on behalf of {{sender.displayName}}, a provider at {{tenant.name}}, a medical aesthetics clinic.',
  goal: 'Write a warm post-treatment follow-up checking on recovery.',
  constraints: [
    'HIPAA compliant: never restate clinical details the recipient did not already receive in writing.',
    'Do not give medical advice; direct clinical questions to the clinic.',
  ],
  channelRules: { sms: 'Max 320 characters, no subject line.' },
  modelHints: { temperature: 0.7, maxTokens: 800 },
};

function assembler(): PromptAssembler {
  return new PromptAssembler(new Renderer({ logger }));
}

function context() {
  const ctx = emptyContext('t1');
  ctx.recipient = { displayName: 'Ada Lovelace' };
  ctx.sender = { displayName: 'Dr. Rivera' };
  ctx.tenant = { id: 't1', name: 'Northside Clinic', timezone: 'America/New_York' };
  ctx.context = { treatmentName: 'Hydrafacial', treatmentDate: '2026-01-10' };
  return ctx;
}

describe('assembled prompt — golden', () => {
  it('matches the expected system prompt exactly', async () => {
    const result = await assembler().assemble({
      pack: PACK,
      channel: 'sms',
      context: context(),
      complianceConstraints: ['TCPA: include opt-out language on the first SMS of a campaign.'],
      tenantStyle: 'Plain, unfussy sentences. No exclamation marks.',
    });

    expect(result.system).toBe(
      [
        'You are writing on behalf of Dr. Rivera, a provider at Northside Clinic, a medical aesthetics clinic.',
        '',
        'Constraints:',
        '- HIPAA compliant: never restate clinical details the recipient did not already receive in writing.',
        '- Do not give medical advice; direct clinical questions to the clinic.',
        '- TCPA: include opt-out language on the first SMS of a campaign.',
        '',
        'Channel rules (sms):',
        'Max 320 characters, no subject line.',
        '',
        'House style:',
        'Plain, unfussy sentences. No exclamation marks.',
      ].join('\n'),
    );
  });

  it('matches the expected user prompt exactly', async () => {
    const result = await assembler().assemble({
      pack: PACK,
      channel: 'sms',
      context: context(),
    });

    expect(result.prompt).toBe(
      [
        'Task:',
        'Write a warm post-treatment follow-up checking on recovery.',
        '',
        'Context (all facts you may use — do not invent others):',
        JSON.stringify(
          {
            recipient: { displayName: 'Ada Lovelace' },
            sender: { displayName: 'Dr. Rivera' },
            tenant: { name: 'Northside Clinic', timezone: 'America/New_York' },
            treatmentName: 'Hydrafacial',
            treatmentDate: '2026-01-10',
          },
          null,
          2,
        ),
        '',
        'Return a single JSON object with these fields:',
        '  content  — the message body, plain text unless the channel rules say otherwise',
        '  subject  — a subject line, only when the channel supports one',
        '  tone     — a short description of the tone you used',
        '  reasoning — one sentence on why this message is appropriate',
      ].join('\n'),
    );
  });
});

describe('determinism and ordering', () => {
  it('produces byte-identical output for identical input', async () => {
    const a = await assembler().assemble({ pack: PACK, channel: 'sms', context: context() });
    const b = await assembler().assemble({ pack: PACK, channel: 'sms', context: context() });
    expect(a.system).toBe(b.system);
    expect(a.prompt).toBe(b.prompt);
  });

  it('puts pack constraints before compliance constraints', async () => {
    const result = await assembler().assemble({
      pack: PACK,
      channel: 'sms',
      context: context(),
      complianceConstraints: ['ZZZ compliance rule.'],
    });
    expect(result.system.indexOf('HIPAA compliant')).toBeLessThan(
      result.system.indexOf('ZZZ compliance rule.'),
    );
  });

  it('lets a playbook goal override the pack goal', async () => {
    const result = await assembler().assemble({
      pack: PACK,
      playbookGoal: 'Remind about tomorrow’s appointment.',
      channel: 'sms',
      context: context(),
    });
    expect(result.prompt).toContain('Remind about tomorrow’s appointment.');
    expect(result.prompt).not.toContain('post-treatment follow-up');
  });

  it('selects the channel rule case-insensitively', async () => {
    const result = await assembler().assemble({ pack: PACK, channel: 'SMS', context: context() });
    expect(result.system).toContain('Max 320 characters');
  });

  it('omits a channel rules section when the pack has none for that channel', async () => {
    const result = await assembler().assemble({ pack: PACK, channel: 'slack', context: context() });
    expect(result.system).not.toContain('Channel rules');
  });

  it('carries model hints through', async () => {
    const result = await assembler().assemble({ pack: PACK, channel: 'sms', context: context() });
    expect(result.temperature).toBe(0.7);
    expect(result.maxTokens).toBe(800);
    expect(result.packKey).toBe('medspa.followup');
    expect(result.packVersion).toBe(1);
  });
});
