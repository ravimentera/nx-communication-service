/**
 * The pack loader, and the one path through it that was silently dead until P6:
 * `packs/<id>/compliance.json` → merged rules → a lint warning.
 *
 * The rules file has shipped since P5 and nothing read it, so `lintWarnings`
 * was always empty. That made `aiConfidence` (D35) pure context-completeness,
 * and P6's `threshold` mode's "lint must be clean" condition vacuously true.
 */
import { join } from 'node:path';

import winston from 'winston';

import { DEFAULT_RULES, lintContent, mergeRules } from '../../../src/engine/compliance/lint.js';
import { loadPacks } from '../../../src/packs/loader.js';

const logger = winston.createLogger({ silent: true });
const packs = loadPacks(join(process.cwd(), 'packs'), logger);

describe('loading', () => {
  it('finds the medspa pack and its three content kinds', () => {
    expect(packs.list()).toContain('medspa');
    const pack = packs.get('medspa')!;
    expect(Object.keys(pack.aliases).length).toBeGreaterThan(0);
    expect(pack.prompts.size).toBeGreaterThan(0);
    expect(pack.compliance).toBeDefined();
  });

  it('loads the lead-generation pack with no validation errors', () => {
    // Every file is parsed through Zod with .strict() (D57), so a misspelled
    // key in a pack file is a load error naming the file rather than a
    // silently-ignored field that renders the wrong thing forever.
    expect(packs.errors()).toEqual([]);
    expect(packs.list()).toContain('lead-generation');

    const pack = packs.get('lead-generation')!;
    expect(pack.playbooks!).toHaveLength(5);
    expect(pack.policies!).toHaveLength(1);
    expect(pack.templates!).toHaveLength(5);
    expect(pack.prompts.size).toBe(1);
  });

  it('declares no context provider, which is the pack’s entire point', () => {
    // A context provider reaches an external service using the ENGINE's
    // credentials, so it is a security boundary and not a lookup table. The
    // medspa pack has one because it was extracted from a system that has one;
    // a generic pack must work with caller-supplied data alone.
    expect(packs.get('lead-generation')!.manifest!.contextProviders).toEqual([]);
    expect(packs.get('medspa')!.manifest!.contextProviders).toContain('mentera-patient');
  });

  it('keeps the two packs’ compliance rules apart', () => {
    const lead = packs.get('lead-generation')!.compliance!;
    const medspa = packs.get('medspa')!.compliance!;

    // A sales message must be able to quote a price and say 'results'; a
    // clinical one must not leak an MRN. Neither ruleset belongs to the other.
    expect(lead.phiPatterns ?? []).toEqual([]);
    expect((medspa.phiPatterns ?? []).length).toBeGreaterThan(0);
    expect(lead.prohibitedPhrases).toContain('guaranteed results');
  });

  it('ships the AI playbook inactive and the template ones live', () => {
    // D59: installing a pack must never be the moment a tenant starts sending
    // model-written messages to strangers.
    const byKey = new Map(packs.get('lead-generation')!.playbooks!.map((p) => [p.key, p]));
    expect(byKey.get('lead.followup')!.isActive).toBe(false);
    expect(byKey.get('lead.initial-contact')!.isActive).not.toBe(false);
  });

  it('strips $comment keys from the rules, as it does from aliases', () => {
    const rules = packs.get('medspa')!.compliance!;
    expect(Object.keys(rules).every((key) => !key.startsWith('$'))).toBe(true);
  });

  it('returns every pack’s rules when no id is given', () => {
    // The composition root does not know which pack a draft belongs to, so it
    // merges them all. A warning from the wrong pack costs a human glance.
    //
    // This asserted `=== medspa's length` while medspa was the only pack with a
    // compliance.json. Two packs now ship one, so the number is 2 — the
    // behaviour did not change, the arithmetic did.
    expect(packs.compliance()).toHaveLength(2);
    expect(packs.compliance('medspa')).toHaveLength(1);
    expect(packs.compliance('lead-generation')).toHaveLength(1);
    expect(packs.compliance('no-such-pack')).toEqual([]);
  });
});

describe('the rules reach the linter', () => {
  const rules = mergeRules(...packs.compliance());

  it('flags a phrase the pack prohibits', () => {
    const warnings = lintContent(
      { content: 'Guaranteed results or your money back!', channel: 'sms', tenantId: 't-1' },
      rules,
    );
    expect(warnings.join(' ')).toMatch(/guaranteed results/i);
  });

  it('flags pack PHI patterns the engine defaults know nothing about', () => {
    // The engine ships no HIPAA-shaped rules; the medspa pack does. This is the
    // §0.10 boundary working — the mechanism is generic, the content is not.
    const engineOnly = lintContent(
      { content: 'Your lab results are ready.', channel: 'email', tenantId: 't-1' },
      DEFAULT_RULES,
    );
    const withPack = lintContent(
      { content: 'Your lab results are ready.', channel: 'email', tenantId: 't-1' },
      rules,
    );

    expect(engineOnly).toHaveLength(0);
    expect(withPack.length).toBeGreaterThan(0);
  });

  it('keeps the engine default length ceilings the pack does not override', () => {
    const warnings = lintContent(
      { content: 'x'.repeat(1200), channel: 'push', tenantId: 't-1' },
      rules,
    );
    expect(warnings.join(' ')).toMatch(/1000 limit for push/);
  });

  it('passes clean content, so a warning means something', () => {
    expect(
      lintContent(
        { content: 'See you Tuesday at 3pm. Reply STOP to opt out.', channel: 'sms', tenantId: 't-1' },
        rules,
      ),
    ).toEqual([]);
  });
});

describe('a missing packs directory', () => {
  it('degrades to no content rather than failing boot', () => {
    const empty = loadPacks(join(process.cwd(), 'does-not-exist'), logger);
    expect(empty.list()).toEqual([]);
    expect(empty.compliance()).toEqual([]);
    expect(mergeRules(...empty.compliance())).toEqual(DEFAULT_RULES);
  });
});
