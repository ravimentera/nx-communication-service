/**
 * The compliance gate against a real Postgres, plus the point of the whole
 * phase: preferences survive a restart.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { baselineMigrations } from '../helpers/migrations.js';

import { eq } from 'drizzle-orm';
import { Client } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import winston from 'winston';

import { createDb, type Db } from '../../src/db/index.js';
import {
  consentRecords,
  messages,
  recipients,
  tenantChannelConfigs,
  tenants,
} from '../../src/db/schema.js';
import { ConsentService } from '../../src/engine/compliance/consent.service.js';
import { ComplianceGate } from '../../src/engine/compliance/gate.js';
import { PreferenceService } from '../../src/engine/compliance/preference.service.js';
import { RecipientService } from '../../src/engine/recipients/recipient.service.js';

const logger = winston.createLogger({ silent: true });
const TENANT = 't-comp';
const scope = { tenantId: TENANT };

let container: StartedPostgreSqlContainer;
let pool: ReturnType<typeof createDb>['pool'];
let db: Db;
let preferences: PreferenceService;
let recipientService: RecipientService;

function gate(shadowMode: boolean): ComplianceGate {
  return new ComplianceGate({
    db,
    logger,
    preferences,
    shadowMode,
    unsubscribeUrl: async () => 'https://example.test/unsubscribe/tok',
  });
}

async function makeRecipient(overrides: { status?: string; timezone?: string } = {}) {
  const [row] = await db
    .insert(recipients)
    .values({
      tenantId: TENANT,
      externalRef: { system: 'test', id: `r-${Math.random().toString(36).slice(2)}` },
      displayName: 'Ada',
      status: overrides.status ?? 'active',
      timezone: overrides.timezone ?? null,
    })
    .returning();
  return row!;
}

const input = (recipientId: string, over: Record<string, unknown> = {}) =>
  ({
    scope,
    channel: 'email' as const,
    priority: 'MEDIUM' as const,
    recipientId,
    rendered: { body: 'hello' },
    ...over,
  }) as Parameters<ComplianceGate['check']>[0];

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();

  const client = new Client({ connectionString: container.getConnectionUri() });
  await client.connect();
  const dir = join(process.cwd(), 'migrations');
  // The 0xxx schema series only — the 9xxx files are the one-shot mentera-core
  // data migration and need a linked source database (migration.test.ts covers them).
  for (const file of baselineMigrations(dir)) {
    await client.query(readFileSync(join(dir, file), 'utf8'));
  }
  await client.query(`INSERT INTO tenants (id, name, timezone) VALUES ('${TENANT}','Comp','UTC')`);
  await client.end();

  const handle = createDb({ url: container.getConnectionUri() }, logger);
  pool = handle.pool;
  db = handle.db;
  preferences = new PreferenceService({
    db,
    logger,
    defaultTimezone: 'UTC',
    unsubscribeBaseUrl: 'https://example.test/unsubscribe',
  });
  recipientService = new RecipientService({ db, logger });

  // ── THE TENANT'S OPT-IN POSTURE IS STATED, NOT INHERITED ──────────────────
  //
  // `require_opt_in` is `NOT NULL DEFAULT true` and the gate now honours that
  // default for a tenant with NO config row — previously a missing row read as
  // `false`, so the least-configured tenant got the most permissive treatment.
  //
  // Most cases in this file are about a different check entirely, so the row
  // says `false` and the two suites that care about consent flip it explicitly.
  // Relying on the absence of a row to mean "no opt-in required" is exactly the
  // accident the gate change removes.
  await db.insert(tenantChannelConfigs).values({
    tenantId: TENANT,
    name: 'cfg',
    requireOptIn: false,
  });
}, 240_000);

afterAll(async () => {
  await pool?.end().catch(() => {});
  await container?.stop();
});

describe('check 1 — recipient status blocks', () => {
  it.each([
    ['unsubscribed', 'RECIPIENT_UNSUBSCRIBED'],
    ['bounced', 'RECIPIENT_BOUNCED'],
    ['deleted', 'RECIPIENT_DELETED'],
  ])('%s → %s', async (status, reason) => {
    const recipient = await makeRecipient({ status });
    const verdict = await gate(false).check(input(recipient.id));
    expect(verdict.allow).toBe(false);
    if (!verdict.allow) {
      expect(verdict.reason).toBe(reason);
      expect(verdict.deferrable).toBe(false);
    }
  });

  it('active passes', async () => {
    const recipient = await makeRecipient();
    expect((await gate(false).check(input(recipient.id))).allow).toBe(true);
  });
});

describe('check 2 — global opt-out', () => {
  it('blocks a normal message', async () => {
    const recipient = await makeRecipient();
    await preferences.upsert(scope, recipient.id, { allowCommunications: false });
    const verdict = await gate(false).check(input(recipient.id));
    expect(verdict.allow).toBe(false);
    if (!verdict.allow) expect(verdict.reason).toBe('COMMUNICATIONS_DISABLED');
  });

  it('still blocks URGENT when the message is not transactional', async () => {
    const recipient = await makeRecipient();
    await preferences.upsert(scope, recipient.id, { allowCommunications: false });
    const verdict = await gate(false).check(input(recipient.id, { priority: 'URGENT' }));
    expect(verdict.allow).toBe(false);
  });

  it('allows URGENT + transactional — both conditions are required', async () => {
    const recipient = await makeRecipient();
    await preferences.upsert(scope, recipient.id, { allowCommunications: false });
    const verdict = await gate(false).check(
      input(recipient.id, { priority: 'URGENT', transactional: true }),
    );
    expect(verdict.allow).toBe(true);
  });
});

describe('check 3 — channel preference and consent', () => {
  it('blocks a channel the recipient did not choose', async () => {
    const recipient = await makeRecipient();
    await preferences.upsert(scope, recipient.id, { preferredChannels: ['sms'] });
    const verdict = await gate(false).check(input(recipient.id, { channel: 'email' }));
    expect(verdict.allow).toBe(false);
    if (!verdict.allow) expect(verdict.reason).toBe('CHANNEL_OPTED_OUT');
  });

  it('treats an empty channel list as no restriction', async () => {
    const recipient = await makeRecipient();
    await preferences.upsert(scope, recipient.id, { preferredChannels: [] });
    expect((await gate(false).check(input(recipient.id))).allow).toBe(true);
  });

  it('requires a consent record when the tenant sets require_opt_in', async () => {
    await db
      .update(tenantChannelConfigs)
      .set({ requireOptIn: true })
      .where(eq(tenantChannelConfigs.tenantId, TENANT));
    const recipient = await makeRecipient();

    const blocked = await gate(false).check(input(recipient.id));
    expect(blocked.allow).toBe(false);
    if (!blocked.allow) expect(blocked.reason).toBe('CONSENT_REQUIRED');

    await db.insert(consentRecords).values({
      tenantId: TENANT,
      recipientId: recipient.id,
      channel: 'email',
      granted: true,
      grantedAt: new Date(),
    });
    expect((await gate(false).check(input(recipient.id))).allow).toBe(true);

    await db.update(tenantChannelConfigs).set({ requireOptIn: false }).where(eq(tenantChannelConfigs.tenantId, TENANT));
  });
});

/**
 * The tenant nobody has configured.
 *
 * `require_opt_in` is `NOT NULL DEFAULT true`, so every row that exists says
 * opt-in is required. `loadTenantConfig()` returns null when there is no row,
 * and `tenantConfig?.requireOptIn` made that `undefined` — falsy — so the one
 * tenant state that has never been configured was the one that skipped the
 * check entirely.
 *
 * Backwards in the direction that matters: a brand-new tenant, least likely to
 * have consent records or a considered policy, got the most permissive
 * treatment — and it contradicted what the schema promises anyone reading it.
 */
describe('a tenant with no channel config at all', () => {
  const FRESH = 't-comp-fresh';

  beforeAll(async () => {
    await db.insert(tenants).values({ id: FRESH, name: 'Fresh' }).onConflictDoNothing();
  });

  const freshInput = (recipientId: string) =>
    ({
      scope: { tenantId: FRESH },
      channel: 'email' as const,
      priority: 'MEDIUM' as const,
      recipientId,
      rendered: { body: 'hello' },
    }) as Parameters<ComplianceGate['check']>[0];

  async function freshRecipient() {
    const [row] = await db
      .insert(recipients)
      .values({
        tenantId: FRESH,
        externalRef: { system: 'test', id: `f-${Math.random().toString(36).slice(2)}` },
        displayName: 'Grace',
      })
      .returning();
    return row!;
  }

  it('requires consent, matching the column default rather than ignoring it', async () => {
    const recipient = await freshRecipient();
    const verdict = await gate(false).check(freshInput(recipient.id));

    expect(verdict.allow).toBe(false);
    if (!verdict.allow) expect(verdict.reason).toBe('CONSENT_REQUIRED');
  });

  it('sends once consent is recorded — the state is reachable, not a dead end', async () => {
    const recipient = await freshRecipient();
    await new ConsentService({ db, logger }).grant({ tenantId: FRESH }, recipient.id, {
      channels: ['email'],
      source: 'signup_form',
    });

    expect((await gate(false).check(freshInput(recipient.id))).allow).toBe(true);
  });

  it('is still only a shadow warning while shadow mode is on', async () => {
    // Which is why turning this default around is safe to ship: nothing is
    // blocked until an operator enforces per tenant, and the runbook has them
    // read 9011's unconsented count first.
    const recipient = await freshRecipient();
    const verdict = await gate(true).check(freshInput(recipient.id));

    expect(verdict.allow).toBe(true);
    if (verdict.allow) expect(verdict.shadowed).toBe('CONSENT_REQUIRED');
  });
});

/**
 * The write side of consent, which did not exist until P13.
 *
 * The gate has read `consent_records` since P5 and nothing could write a row,
 * so `require_opt_in` — `NOT NULL DEFAULT true` — made enforcement impossible
 * to switch on: an operator flipping shadow mode off would have blocked every
 * send in the tenant with `CONSENT_REQUIRED` and had no API to fix a single one.
 * The test above proves the gate reads a row; these prove one can be created,
 * withdrawn, and that withdrawing wins.
 */
describe('the consent writer', () => {
  let consent: ConsentService;

  beforeAll(() => {
    consent = new ConsentService({ db, logger });
  });

  async function requiringOptIn<T>(run: () => Promise<T>): Promise<T> {
    await db
      .update(tenantChannelConfigs)
      .set({ requireOptIn: true })
      .where(eq(tenantChannelConfigs.tenantId, TENANT));
    try {
      return await run();
    } finally {
      await db
        .update(tenantChannelConfigs)
        .set({ requireOptIn: false })
        .where(eq(tenantChannelConfigs.tenantId, TENANT));
    }
  }

  it('unblocks a recipient the gate was refusing', async () => {
    await requiringOptIn(async () => {
      const recipient = await makeRecipient();

      const before = await gate(false).check(input(recipient.id));
      expect(before.allow).toBe(false);
      if (!before.allow) expect(before.reason).toBe('CONSENT_REQUIRED');

      await consent.grant(scope, recipient.id, {
        channels: ['email'],
        source: 'signup_form',
        proof: { ip: '203.0.113.4', formId: 'newsletter' },
      });

      expect((await gate(false).check(input(recipient.id))).allow).toBe(true);
    });
  });

  it('keeps one row per channel, so a re-grant cannot stack', async () => {
    const recipient = await makeRecipient();
    await consent.grant(scope, recipient.id, { channels: ['email'], source: 'signup_form' });
    await consent.grant(scope, recipient.id, { channels: ['email'], source: 'double_optin' });

    const rows = await consent.list(scope, recipient.id);
    expect(rows).toHaveLength(1);
    // The later grant is the one that stands, with its own proof.
    expect(rows[0]!.source).toBe('double_optin');
  });

  it('lets a revocation win over an earlier grant', async () => {
    await requiringOptIn(async () => {
      const recipient = await makeRecipient();
      await consent.grant(scope, recipient.id, { channels: ['email'], source: 'signup_form' });
      expect((await gate(false).check(input(recipient.id))).allow).toBe(true);

      await consent.revoke(scope, recipient.id, ['email'], 'asked us to stop');

      const after = await gate(false).check(input(recipient.id));
      expect(after.allow).toBe(false);
      if (!after.allow) expect(after.reason).toBe('CONSENT_REQUIRED');

      // Not deleted. The record that they agreed and then withdrew IS the audit
      // trail, and it is the only thing that can answer "when did this change?".
      const rows = await consent.list(scope, recipient.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ granted: false });
      expect(rows[0]!.revokedAt).not.toBeNull();
      expect(rows[0]!.grantedAt).not.toBeNull();
    });
  });

  it('revokes every channel when none is named', async () => {
    const recipient = await makeRecipient();
    await consent.grant(scope, recipient.id, {
      channels: ['email', 'sms'],
      source: 'verbal',
    });

    const revoked = await consent.revoke(scope, recipient.id);
    expect(revoked.map((r) => r.channel).sort()).toEqual(['email', 'sms']);
  });

  /**
   * The two are read by different checks in the gate — `allowCommunications`
   * fails check 2, `hasConsent()` is check 3 — and only one of them was being
   * written. An unsubscribed recipient kept a granted consent row.
   */
  it('is withdrawn by an unsubscribe, not just the preference flag', async () => {
    const recipient = await makeRecipient();
    await consent.grant(scope, recipient.id, { channels: ['email'], source: 'signup_form' });

    await preferences.unsubscribe(scope, recipient.id, 'clicked the footer');

    const rows = await consent.list(scope, recipient.id);
    expect(rows[0]).toMatchObject({ granted: false });
    expect(rows[0]!.revokedAt).not.toBeNull();
  });

  it('refuses a consent dated in the future', async () => {
    const recipient = await makeRecipient();
    await expect(
      consent.grant(scope, recipient.id, {
        channels: ['email'],
        source: 'api',
        grantedAt: new Date(Date.now() + 86_400_000),
      }),
    ).rejects.toThrow(/future/i);
  });

  it('refuses a recipient belonging to another tenant', async () => {
    const recipient = await makeRecipient();
    await expect(
      consent.grant(
        { tenantId: 'someone-else' },
        recipient.id,
        { channels: ['email'], source: 'api' },
      ),
    ).rejects.toThrow(/not found/i);
  });

  it('captures an imported batch without resurrecting a withdrawal', async () => {
    const kept = await makeRecipient();
    const withdrawn = await makeRecipient();

    await consent.grant(scope, withdrawn.id, { channels: ['email'], source: 'signup_form' });
    await consent.revoke(scope, withdrawn.id, ['email']);

    const written = await consent.captureImported(scope, [kept.id, withdrawn.id], {
      channels: ['email'],
      source: 'import',
      grantedAt: new Date('2026-01-15T00:00:00.000Z'),
      proof: { file: 'tradeshow-leads.csv' },
    });

    // One row written, not two: a bulk file is not evidence that somebody who
    // withdrew has reconsidered.
    expect(written).toBe(1);
    expect((await consent.list(scope, kept.id))[0]).toMatchObject({ granted: true });
    expect((await consent.list(scope, withdrawn.id))[0]).toMatchObject({ granted: false });
  });
});

describe('check 4 — per-playbook opt-out', () => {
  it('blocks only the opted-out playbook', async () => {
    const recipient = await makeRecipient();
    await preferences.upsert(scope, recipient.id, { eventOptOuts: ['medspa.promo'] });

    const blocked = await gate(false).check(input(recipient.id, { playbookKey: 'medspa.promo' }));
    expect(blocked.allow).toBe(false);
    if (!blocked.allow) expect(blocked.reason).toBe('PLAYBOOK_OPTED_OUT');

    expect(
      (await gate(false).check(input(recipient.id, { playbookKey: 'medspa.reminder' }))).allow,
    ).toBe(true);
  });
});

describe('check 5 — quiet hours DEFER, they do not block', () => {
  it('defers with a retryAt rather than blocking', async () => {
    const recipient = await makeRecipient();
    // A window covering the whole day except one minute, so the test does not
    // depend on when it runs.
    await preferences.upsert(scope, recipient.id, {
      quietHoursStart: '00:00',
      quietHoursEnd: '23:59',
      quietHoursTimezone: 'UTC',
    });

    const verdict = await gate(false).check(input(recipient.id));
    expect(verdict.allow).toBe(false);
    if (!verdict.allow) {
      expect(verdict.reason).toBe('QUIET_HOURS');
      // The distinction the whole phase turns on: try later, do not discard.
      expect(verdict.deferrable).toBe(true);
      expect(verdict.retryAt).toBeInstanceOf(Date);
    }
  });

  it('URGENT overrides quiet hours', async () => {
    const recipient = await makeRecipient();
    await preferences.upsert(scope, recipient.id, {
      quietHoursStart: '00:00',
      quietHoursEnd: '23:59',
      quietHoursTimezone: 'UTC',
    });
    expect((await gate(false).check(input(recipient.id, { priority: 'URGENT' }))).allow).toBe(true);
  });
});

/**
 * The tenant's default window.
 *
 * Quiet hours applied only when the RECIPIENT had personally configured one,
 * and almost nobody has — a freshly imported lead list has no preference rows
 * at all. So the check that exists to stop a message arriving at 3am was, in
 * practice, off for exactly the audiences most likely to get a bulk send.
 */
describe('check 5 — tenant-level quiet hours', () => {
  async function withTenantQuietHours<T>(
    quietHours: Record<string, string> | null,
    run: () => Promise<T>,
  ): Promise<T> {
    await db
      .update(tenants)
      .set({ settings: quietHours ? { quietHours } : {} })
      .where(eq(tenants.id, TENANT));
    try {
      return await run();
    } finally {
      await db.update(tenants).set({ settings: {} }).where(eq(tenants.id, TENANT));
    }
  }

  it('defers a recipient who has expressed no preference of their own', async () => {
    await withTenantQuietHours(
      // A window covering the whole day, so the test does not depend on when it
      // runs. Cross-midnight arithmetic has its own unit tests.
      { start: '00:00', end: '23:59', timezone: 'UTC' },
      async () => {
        const recipient = await makeRecipient();
        const verdict = await gate(false).check(input(recipient.id));
        expect(verdict.allow).toBe(false);
        if (!verdict.allow) {
          expect(verdict.reason).toBe('QUIET_HOURS');
          expect(verdict.deferrable).toBe(true);
        }
      },
    );
  });

  it('lets the recipient’s own window win over the tenant’s', async () => {
    await withTenantQuietHours(
      { start: '00:00', end: '23:59', timezone: 'UTC' },
      async () => {
        const recipient = await makeRecipient();
        // A personal preference is more specific than an organisational
        // default; overriding it would be the opposite of what it is for.
        await preferences.upsert(scope, recipient.id, {
          quietHoursStart: '03:00',
          quietHoursEnd: '03:01',
          quietHoursTimezone: 'UTC',
        });
        expect((await gate(false).check(input(recipient.id))).allow).toBe(true);
      },
    );
  });

  it('ignores a malformed window rather than throwing on the send path', async () => {
    await withTenantQuietHours({ start: 'not-a-time', end: '09:00' }, async () => {
      const recipient = await makeRecipient();
      expect((await gate(false).check(input(recipient.id))).allow).toBe(true);
    });
  });

  it('is off entirely when ENFORCE_QUIET_HOURS is false', async () => {
    // The flag sat in the config schema for six phases with no consumer, so a
    // deployment that set it got quiet hours anyway.
    const relaxed = new PreferenceService({
      db,
      logger,
      enforceQuietHours: false,
      defaultTimezone: 'UTC',
      unsubscribeBaseUrl: 'https://example.test/unsubscribe',
    });

    await withTenantQuietHours(
      { start: '00:00', end: '23:59', timezone: 'UTC' },
      async () => {
        const recipient = await makeRecipient();
        const relaxedGate = new ComplianceGate({
          db,
          logger,
          preferences: relaxed,
          shadowMode: false,
          unsubscribeUrl: async () => 'https://example.test/unsubscribe/tok',
        });
        expect((await relaxedGate.check(input(recipient.id))).allow).toBe(true);
      },
    );
  });
});

describe('check 7 — playbook throttle blocks', () => {
  it('blocks once the per-recipient daily cap is reached', async () => {
    const recipient = await makeRecipient();
    await db.insert(messages).values({
      tenantId: TENANT,
      recipientId: recipient.id,
      channel: 'email',
      direction: 'outbound',
      content: 'earlier',
      status: 'SENT',
    });

    const verdict = await gate(false).check(
      input(recipient.id, { throttle: { maxPerRecipientPerDay: 1 } }),
    );
    expect(verdict.allow).toBe(false);
    if (!verdict.allow) {
      expect(verdict.reason).toBe('THROTTLED');
      expect(verdict.deferrable).toBe(false);
    }
  });
});

describe('precedence', () => {
  it('reports the earliest failing check when several apply', async () => {
    const recipient = await makeRecipient({ status: 'unsubscribed' });
    await preferences.upsert(scope, recipient.id, {
      allowCommunications: false,
      quietHoursStart: '00:00',
      quietHoursEnd: '23:59',
      quietHoursTimezone: 'UTC',
    });
    const verdict = await gate(false).check(input(recipient.id));
    expect(verdict.allow).toBe(false);
    // Status is check 1; opt-out is 2; quiet hours 5.
    if (!verdict.allow) expect(verdict.reason).toBe('RECIPIENT_UNSUBSCRIBED');
  });
});

describe('shadow mode', () => {
  it('allows a message it would otherwise block, and says which reason', async () => {
    const recipient = await makeRecipient({ status: 'unsubscribed' });
    const verdict = await gate(true).check(input(recipient.id));
    expect(verdict.allow).toBe(true);
    if (verdict.allow) expect(verdict.shadowed).toBe('RECIPIENT_UNSUBSCRIBED');
  });

  it('is the same evaluation, just a different disposition', async () => {
    const recipient = await makeRecipient({ status: 'bounced' });
    const enforced = await gate(false).check(input(recipient.id));
    const shadow = await gate(true).check(input(recipient.id));
    expect(enforced.allow).toBe(false);
    expect(shadow.allow).toBe(true);
    if (!enforced.allow && shadow.allow) expect(shadow.shadowed).toBe(enforced.reason);
  });
});

describe('check 8 — mutations', () => {
  it('appends an unsubscribe link to bulk email', async () => {
    const recipient = await makeRecipient();
    const verdict = await gate(false).check(input(recipient.id));
    expect(verdict.allow).toBe(true);
    if (verdict.allow) {
      expect(verdict.mutations?.body).toContain('https://example.test/unsubscribe/tok');
    }
  });

  it('does not append one to a transactional email', async () => {
    const recipient = await makeRecipient();
    const verdict = await gate(false).check(input(recipient.id, { transactional: true }));
    expect(verdict.allow).toBe(true);
    if (verdict.allow) expect(verdict.mutations).toBeUndefined();
  });

  it('does not append one to SMS', async () => {
    const recipient = await makeRecipient();
    const verdict = await gate(false).check(input(recipient.id, { channel: 'sms' }));
    if (verdict.allow) expect(verdict.mutations).toBeUndefined();
  });
});

describe('preferences are durable — the point of deleting the Map', () => {
  it('survives a completely new service instance', async () => {
    const recipient = await makeRecipient();
    await preferences.upsert(scope, recipient.id, {
      allowCommunications: false,
      quietHoursStart: '22:00',
      quietHoursEnd: '06:00',
      quietHoursTimezone: 'America/New_York',
    });

    // A fresh instance with no shared state — the source's in-memory Map would
    // have come up empty here, which is exactly the bug.
    const restarted = new PreferenceService({
      db,
      logger,
      defaultTimezone: 'UTC',
      unsubscribeBaseUrl: 'https://example.test/unsubscribe',
    });

    const prefs = await restarted.get(scope, recipient.id);
    expect(prefs?.allowCommunications).toBe(false);
    expect(prefs?.quietHoursStart).toBe('22:00');
    expect(prefs?.quietHoursTimezone).toBe('America/New_York');
  });

  it('mints a working unsubscribe token and honours it', async () => {
    const recipient = await makeRecipient();
    const url = await preferences.unsubscribeUrl(scope, recipient.id);
    const token = url.split('/').pop()!;
    expect(token).toHaveLength(32);

    const result = await preferences.unsubscribeByToken(token);
    expect(result.recipientId).toBe(recipient.id);
    expect((await preferences.get(scope, recipient.id))?.allowCommunications).toBe(false);
  });

  it('rejects an unknown token', async () => {
    await expect(preferences.unsubscribeByToken('nope')).rejects.toThrow(/Unknown or expired/);
  });
});

describe('recipients replace the cross-database patients read', () => {
  it('listByIds([]) returns [] without touching the database', async () => {
    expect(await recipientService.listByIds(scope, [])).toEqual([]);
  });

  it('listByIds resolves display names in one query', async () => {
    const a = await makeRecipient();
    const b = await makeRecipient();
    const found = await recipientService.listByIds(scope, [a.id, b.id]);
    expect(found).toHaveLength(2);
    expect(found.every((r) => r.displayName === 'Ada')).toBe(true);
  });

  it('upsertByExternalRef is idempotent under concurrency', async () => {
    const ref = { system: 'mentera-patient', id: 'p-concurrent' };
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        recipientService.upsertByExternalRef(scope, ref, { displayName: 'Grace' }),
      ),
    );
    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(1);
  });

  it('does not blank a known field on a partial refresh', async () => {
    const ref = { system: 'mentera-patient', id: 'p-partial' };
    await recipientService.upsertByExternalRef(scope, ref, {
      displayName: 'Grace Hopper',
      timezone: 'America/New_York',
    });
    const refreshed = await recipientService.upsertByExternalRef(scope, ref, {
      displayName: 'Grace H.',
    });
    expect(refreshed.displayName).toBe('Grace H.');
    expect(refreshed.timezone).toBe('America/New_York');
  });
});
