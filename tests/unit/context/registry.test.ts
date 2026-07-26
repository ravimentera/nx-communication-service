/**
 * The registry is a security boundary: `mentera.provider.ts` can reach
 * patient-service using the engine's own gateway credentials, so a tenant that
 * has not installed the medspa pack must not be able to invoke it.
 */
import winston from 'winston';

import { InlineContextProvider } from '../../../src/adapters/context/inline.provider.js';
import { MenteraContextProvider } from '../../../src/adapters/context/mentera.provider.js';
import { CORE_PACK, ContextRegistry } from '../../../src/engine/context/registry.js';
import { ForbiddenError, ValidationError } from '../../../src/platform/http/errors.js';

const logger = winston.createLogger({ silent: true });

function build(installed: string[]) {
  const calls: string[] = [];
  const registry = new ContextRegistry({ installedPacks: async () => installed });

  registry.register(new InlineContextProvider(), CORE_PACK);
  registry.register(
    new MenteraContextProvider({
      config: { patientServiceUrl: 'http://patients.internal' },
      logger,
      get: async (url) => {
        calls.push(url);
        return { data: { data: { firstName: 'Ada', lastName: 'Lovelace' } } };
      },
    }),
    'medspa',
  );

  return { registry, calls };
}

describe('pack gating', () => {
  it('refuses mentera-patient for a tenant without the medspa pack — and makes no HTTP call', async () => {
    const { registry, calls } = build([]);

    await expect(
      registry.fetch({ kind: 'mentera-patient', id: 'p-1' }, { tenantId: 't-nopack' }),
    ).rejects.toThrow(ForbiddenError);

    // The whole point: the request never left the process.
    expect(calls).toEqual([]);
  });

  it('names the required pack in the error', async () => {
    const { registry } = build([]);
    try {
      await registry.fetch({ kind: 'mentera-patient', id: 'p-1' }, { tenantId: 't-nopack' });
      fail('expected a throw');
    } catch (error) {
      expect((error as ForbiddenError).details).toEqual({
        kind: 'mentera-patient',
        requiredPack: 'medspa',
      });
    }
  });

  it('allows it for a tenant that has installed the pack', async () => {
    const { registry, calls } = build(['medspa']);
    const context = await registry.fetch(
      { kind: 'mentera-patient', id: 'p-1' },
      { tenantId: 't-medspa' },
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(context.recipient).toEqual({ firstName: 'Ada', lastName: 'Lovelace' });
  });

  it('allows the core inline provider for every tenant', async () => {
    const { registry } = build([]);
    const context = await registry.fetch(
      { kind: 'inline', params: { treatmentName: 'Hydrafacial' } },
      { tenantId: 't-anyone' },
    );
    expect(context).toEqual({ treatmentName: 'Hydrafacial' });
  });

  it('rejects an unknown kind with a ValidationError, never a silent fallback', async () => {
    const { registry, calls } = build(['medspa']);
    await expect(
      registry.fetch({ kind: 'not-a-provider' }, { tenantId: 't1' }),
    ).rejects.toThrow(ValidationError);
    expect(calls).toEqual([]);
  });

  it('gates resolveRecipient the same way as fetch', async () => {
    const { registry, calls } = build([]);
    await expect(
      registry.resolveRecipient({ kind: 'mentera-patient', id: 'p-1' }, { tenantId: 't-nopack' }),
    ).rejects.toThrow(ForbiddenError);
    expect(calls).toEqual([]);
  });
});

describe('inline provider', () => {
  const provider = new InlineContextProvider();

  it('returns the supplied params unchanged', async () => {
    expect(await provider.fetch({ kind: 'inline', params: { a: 1 } })).toEqual({ a: 1 });
  });

  it('returns an empty object when nothing was supplied', async () => {
    expect(await provider.fetch({ kind: 'inline' })).toEqual({});
  });

  it('reads recipient identity out of the payload', async () => {
    const resolved = await provider.resolveRecipient({
      kind: 'inline',
      id: 'r-1',
      params: { recipient: { displayName: 'Ada', email: 'ada@example.com' } },
    });
    expect(resolved.displayName).toBe('Ada');
    expect(resolved.contactPoints).toEqual([
      { type: 'email', value: 'ada@example.com', primary: true },
    ]);
    expect(resolved.externalRef).toEqual({ system: 'inline', id: 'r-1' });
  });

  it('accepts a bare email/phone shorthand', async () => {
    const resolved = await provider.resolveRecipient({
      kind: 'inline',
      params: { name: 'Ada', phone: '+15551234567' },
    });
    expect(resolved.displayName).toBe('Ada');
    expect(resolved.contactPoints).toEqual([
      { type: 'phone', value: '+15551234567', primary: true },
    ]);
  });
});

describe('mentera provider partial failure', () => {
  it('degrades rather than failing when a secondary call rejects', async () => {
    const provider = new MenteraContextProvider({
      config: { patientServiceUrl: 'http://patients.internal' },
      logger,
      get: async (url) => {
        // Demographics succeed; visits and insights blow up.
        if (url.endsWith('/p-1')) return { data: { data: { firstName: 'Ada' } } };
        throw new Error('upstream exploded');
      },
    });

    const context = await provider.fetch({ kind: 'mentera-patient', id: 'p-1' }, { tenantId: 't1' });
    // A missing health-insight must never stop a message going out.
    expect(context.recipient).toEqual({ firstName: 'Ada' });
    expect(context.visits).toBeNull();
    expect(context.healthInsights).toBeNull();
  });

  it('returns an empty context when no service url is configured', async () => {
    const provider = new MenteraContextProvider({ config: {}, logger });
    expect(await provider.fetch({ kind: 'mentera-patient', id: 'p-1' }, { tenantId: 't1' })).toEqual(
      {},
    );
  });

  it('forwards tenant and gateway headers', async () => {
    let seen: Record<string, string> = {};
    const provider = new MenteraContextProvider({
      config: { patientServiceUrl: 'http://patients.internal' },
      logger,
      get: async (_url, config) => {
        seen = config.headers as Record<string, string>;
        return { data: { data: {} } };
      },
    });

    await provider.fetch({ kind: 'mentera-patient', id: 'p-1' }, { tenantId: 't1', subTenantId: 's1' });
    expect(seen['x-gateway-request']).toBe('true');
    expect(seen['x-tenant-id']).toBe('t1');
    // Dual headers for the parallel-run window.
    expect(seen['x-medspa-id']).toBe('t1');
    expect(seen['x-location-id']).toBe('s1');
  });
});
