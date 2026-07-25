import winston from 'winston';

import { applyAliases } from '../../../src/engine/content/render-context.js';
import { Renderer } from '../../../src/engine/content/renderer.js';
import type { RenderContext } from '../../../src/engine/content/render-context.js';

const logger = winston.createLogger({ silent: true });

const MEDSPA_ALIASES = {
  patientName: 'recipient.displayName',
  doctorName: 'sender.displayName',
  appointmentDate: 'context.appointmentDate',
  medspaName: 'tenant.name',
};

function ctx(overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    recipient: { displayName: 'Ada Lovelace', locale: 'en-US', timezone: 'America/New_York' },
    sender: { displayName: 'Dr. Rivera' },
    tenant: { id: 't1', name: 'Northside Clinic', locale: 'en-US', timezone: 'America/New_York' },
    context: {},
    message: {},
    now: '2026-01-15T12:00:00.000Z',
    ...overrides,
  };
}

function renderer(): Renderer {
  return new Renderer({ logger, aliases: { medspa: MEDSPA_ALIASES } });
}

describe('alias map — existing medspa templates render unchanged', () => {
  it('rewrites a bare legacy variable to its context path', () => {
    expect(applyAliases('Hi {{patientName}}', MEDSPA_ALIASES)).toBe(
      'Hi {{recipient.displayName}}',
    );
  });

  it('rewrites inside a block helper', () => {
    expect(applyAliases('{{#if patientName}}x{{/if}}', MEDSPA_ALIASES)).toBe(
      '{{#if recipient.displayName}}x{{/if}}',
    );
  });

  it('rewrites every argument of a helper call', () => {
    expect(applyAliases('{{ifCond patientName "==" doctorName}}', MEDSPA_ALIASES)).toContain(
      'recipient.displayName',
    );
    expect(applyAliases('{{ifCond patientName "==" doctorName}}', MEDSPA_ALIASES)).toContain(
      'sender.displayName',
    );
  });

  it('leaves an already-migrated path alone', () => {
    expect(applyAliases('{{recipient.displayName}}', MEDSPA_ALIASES)).toBe(
      '{{recipient.displayName}}',
    );
  });

  it('leaves unknown identifiers alone', () => {
    expect(applyAliases('{{somethingElse}}', MEDSPA_ALIASES)).toBe('{{somethingElse}}');
  });

  it('is a no-op with an empty map', () => {
    expect(applyAliases('Hi {{patientName}}', {})).toBe('Hi {{patientName}}');
  });

  it('renders a legacy medspa template end to end', async () => {
    const result = await renderer().render(
      'Hi {{patientName}}, {{doctorName}} at {{medspaName}} is checking in.',
      ctx(),
      { aliases: MEDSPA_ALIASES },
    );
    expect(result.output).toBe('Hi Ada Lovelace, Dr. Rivera at Northside Clinic is checking in.');
  });
});

describe('helpers', () => {
  it('formatDate honours the recipient timezone, not the server', async () => {
    // 2026-01-15T02:00Z is still the 14th in New York.
    const result = await renderer().render('{{formatDate context.when "short"}}', {
      ...ctx(),
      context: { when: '2026-01-15T02:00:00.000Z' },
    });
    expect(result.output).toBe('1/14/2026');
  });

  it('formatDate falls back to the tenant zone when the recipient has none', async () => {
    const result = await renderer().render('{{formatDate context.when "short"}}', {
      ...ctx({ recipient: { displayName: 'x' } }),
      context: { when: '2026-01-15T02:00:00.000Z' },
    });
    expect(result.output).toBe('1/14/2026');
  });

  it('formatDate supports every documented style', async () => {
    const r = renderer();
    const base = { ...ctx(), context: { when: '2026-01-15T17:30:00.000Z' } };
    expect((await r.render('{{formatDate context.when "iso"}}', base)).output).toBe(
      '2026-01-15T17:30:00.000Z',
    );
    expect((await r.render('{{formatDate context.when "long"}}', base)).output).toContain('January');
    expect((await r.render('{{formatDate context.when "time"}}', base)).output).toMatch(/\d/);
  });

  it('formatDate returns empty for a missing or invalid date', async () => {
    const r = renderer();
    expect((await r.render('[{{formatDate context.nope "short"}}]', ctx())).output).toBe('[]');
    expect(
      (await r.render('[{{formatDate context.bad "short"}}]', { ...ctx(), context: { bad: 'nope' } }))
        .output,
    ).toBe('[]');
  });

  it('ifCond covers every operator', async () => {
    const r = renderer();
    const cases: Array<[string, string]> = [
      ['{{#ifCond 1 "==" 1}}y{{else}}n{{/ifCond}}', 'y'],
      ['{{#ifCond 1 "===" 2}}y{{else}}n{{/ifCond}}', 'n'],
      ['{{#ifCond 1 "!=" 2}}y{{else}}n{{/ifCond}}', 'y'],
      ['{{#ifCond 1 "!==" 1}}y{{else}}n{{/ifCond}}', 'n'],
      ['{{#ifCond 1 "<" 2}}y{{else}}n{{/ifCond}}', 'y'],
      ['{{#ifCond 2 "<=" 2}}y{{else}}n{{/ifCond}}', 'y'],
      ['{{#ifCond 3 ">" 2}}y{{else}}n{{/ifCond}}', 'y'],
      ['{{#ifCond 2 ">=" 3}}y{{else}}n{{/ifCond}}', 'n'],
      ['{{#ifCond 1 "&&" 1}}y{{else}}n{{/ifCond}}', 'y'],
      ['{{#ifCond 0 "||" 0}}y{{else}}n{{/ifCond}}', 'n'],
      ['{{#ifCond 1 "??" 1}}y{{else}}n{{/ifCond}}', 'n'],
    ];
    for (const [source, expected] of cases) {
      expect((await r.render(source, ctx())).output).toBe(expected);
    }
  });

  it('addTracking appends utm parameters', async () => {
    const result = await renderer().render('{{{addTracking context.url context.utm}}}', {
      ...ctx(),
      context: {
        url: 'https://example.com/book',
        utm: { utmSource: 'sms', utmCampaign: 'winter' },
      },
    });
    expect(result.output).toContain('utm_source=sms');
    expect(result.output).toContain('utm_campaign=winter');
  });

  it('addTracking returns the original string for an invalid url', async () => {
    const result = await renderer().render('{{{addTracking context.url context.utm}}}', {
      ...ctx(),
      context: { url: 'not a url', utm: { utmSource: 'sms' } },
    });
    expect(result.output).toBe('not a url');
  });

  it('addTracking returns the url untouched when there is no tracking object', async () => {
    const result = await renderer().render('{{{addTracking context.url context.nope}}}', {
      ...ctx(),
      context: { url: 'https://example.com/' },
    });
    expect(result.output).toBe('https://example.com/');
  });

  it('json stringifies', async () => {
    const result = await renderer().render('{{{json context.data}}}', {
      ...ctx(),
      context: { data: { a: 1 } },
    });
    expect(result.output).toBe('{"a":1}');
  });

  it('substring slices', async () => {
    const result = await renderer().render('{{substring context.s 0 5}}', {
      ...ctx(),
      context: { s: 'abcdefghij' },
    });
    expect(result.output).toBe('abcde');
  });

  it('substring returns empty for missing text', async () => {
    expect((await renderer().render('[{{substring context.x 0 5}}]', ctx())).output).toBe('[]');
  });
});

describe('unknown variables never render as "undefined"', () => {
  it('renders a missing path as empty', async () => {
    const result = await renderer().render('Hello [{{recipient.nope}}]', ctx());
    expect(result.output).toBe('Hello []');
  });

  it('renders a missing nested namespace as empty', async () => {
    const result = await renderer().render('[{{context.deeply.nested.thing}}]', ctx());
    expect(result.output).toBe('[]');
  });

  it('never emits the literal string undefined', async () => {
    const result = await renderer().render('{{a}}{{b.c}}{{context.d}}', ctx());
    expect(result.output).not.toContain('undefined');
  });
});

describe('MJML', () => {
  it('compiles MJML to HTML', async () => {
    const source = `<mjml><mj-body><mj-section><mj-column><mj-text>Hi {{patientName}}</mj-text></mj-column></mj-section></mj-body></mjml>`;
    const result = await renderer().render(source, ctx(), {
      format: 'MJML',
      aliases: MEDSPA_ALIASES,
    });
    expect(result.output).toContain('<html');
    expect(result.output).toContain('Ada Lovelace');
  });
});

describe('isolation', () => {
  it('does not register helpers on the global Handlebars singleton', async () => {
    renderer();
    const Handlebars = (await import('handlebars')).default;
    // If the source's global registerHelper pattern had been carried over,
    // these would leak onto every consumer in the process.
    expect(Handlebars.helpers.formatDate).toBeUndefined();
    expect(Handlebars.helpers.addTracking).toBeUndefined();
  });
});

describe('extractVariables', () => {
  it('lists referenced paths after aliasing, skipping block helpers', () => {
    const vars = renderer().extractVariables(
      'Hi {{patientName}} {{#if context.x}}{{context.y}}{{/if}}',
      MEDSPA_ALIASES,
    );
    expect(vars).toContain('recipient.displayName');
    expect(vars).toContain('context.y');
    expect(vars).not.toContain('if');
  });
});
