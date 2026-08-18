/**
 * `testing/seed-local.sql` still matches the schema, and still means what it says.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS DOES NOT RUN ANYTHING AGAINST A REAL DATABASE
 *
 * Same arrangement as `schema.test.ts`: testcontainers starts an empty,
 * throwaway Postgres, the baseline migrations and then the seed are applied to
 * it, the assertions run, and it is destroyed. It never has a route to a
 * database holding data.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A HAND-WRITTEN FIXTURE NEEDS A TEST AT ALL
 *
 * `docs/LOCAL_DEV.md` argued against exactly this file — fixtures belong in
 * `tests/` or in a pack, *"not in an ad-hoc SQL file that drifts from the
 * schema the way the §0.5 Seam D ghost tables did"*. Half that reasoning has
 * expired (it was "nothing before P5 owns the shape of a recipients row", and
 * every phase is done). The drift half has not, and it is the reason this suite
 * exists: an ad-hoc SQL fixture with nothing checking it breaks silently the
 * next time a column moves, and the failure surfaces as a confusing 4xx three
 * files away.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * "IT INSERTS" IS NOT THE ASSERTION THAT MATTERS
 *
 * Both bugs this fixture actually shipped with inserted **perfectly happily**
 * and failed at use time:
 *
 *   1. contact points written as `type: "sms"`. The channel is called `sms`;
 *      the contact point is called `phone`. The row is valid JSONB either way,
 *      and the failure was "No phone contact point for this recipient" against
 *      a recipient that visibly had one.
 *
 *   2. `external_ref.system` written as `mentera` instead of `mentera-patient`.
 *      Also valid, and it made every legacy route silently create a second,
 *      contactless recipient instead of resolving the seeded one.
 *
 * A suite that only applied the file and checked row counts would have passed
 * for both. So the assertions below are about **meaning** — they compare the
 * fixture against the constants the engine actually reads, and where no shared
 * constant exists they say so rather than quietly duplicating a literal.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';

import { MEDSPA_RECIPIENT_SYSTEM } from '../../src/api/compat/translate.js';
import { baselineMigrations } from '../helpers/migrations.js';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');
const SEED = join(process.cwd(), 'testing', 'seed-local.sql');

let container: StartedPostgreSqlContainer;
let client: Client;

async function applySeed(): Promise<void> {
  await client.query(readFileSync(SEED, 'utf8'));
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = new Client({ connectionString: container.getConnectionUri() });
  await client.connect();

  for (const file of baselineMigrations(MIGRATIONS_DIR)) {
    await client.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
  await applySeed();
}, 240_000);

afterAll(async () => {
  await client?.end();
  await container?.stop();
});

describe('seed-local.sql against the current schema', () => {
  it('applies to a freshly migrated database', async () => {
    // Reaching `beforeAll` without throwing is most of this assertion. The
    // counts confirm it inserted rather than silently matching zero rows.
    const { rows } = await client.query<{ tenants: string; recipients: string }>(
      `SELECT (SELECT count(*) FROM tenants     WHERE id        LIKE 't-%') AS tenants,
              (SELECT count(*) FROM recipients  WHERE tenant_id LIKE 't-%') AS recipients`,
    );
    expect(Number(rows[0]!.tenants)).toBe(3);
    expect(Number(rows[0]!.recipients)).toBe(7);
  });

  it('is idempotent — re-applying converges rather than duplicating', async () => {
    // Re-running is the documented way to reset fixture state after a test run
    // has mutated it, so this is a contract, not a nicety.
    await applySeed();
    await applySeed();

    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*) FROM recipients WHERE tenant_id LIKE 't-%'`,
    );
    expect(Number(rows[0]!.count)).toBe(7);
  });

  it('runs without psql meta-commands, so any client can apply it', () => {
    // `\echo` and friends are psql-only. A file using them cannot be applied by
    // the client above — which would mean this whole suite could not exist.
    const sql = readFileSync(SEED, 'utf8');
    const meta = sql.split('\n').filter((line) => /^\s*\\/.test(line));
    expect(meta).toEqual([]);
  });
});

describe('the fixtures mean what the engine reads', () => {
  it('keys recipients by the external system the compat shim resolves', async () => {
    // THE COUPLING THAT MATTERS. `CompatIdentity` looks recipients up by this
    // exact string, and `9004_recipients.sql` writes the same one, so a seed
    // using anything else produces recipients the legacy surface cannot find —
    // it creates a second, contactless one instead. Imported rather than
    // written out, so a rename moves both together.
    const { rows } = await client.query<{ system: string }>(
      `SELECT DISTINCT external_ref->>'system' AS system
         FROM recipients WHERE tenant_id LIKE 't-%'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.system).toBe(MEDSPA_RECIPIENT_SYSTEM);
  });

  it('writes contact points as contact-point types, never as channel names', async () => {
    // `sms` is a CHANNEL; the contact point for it is `phone`. Every call site
    // maps between them inline (`api/v1/channels.ts`, `compat/communications.ts`,
    // `mcp/index.ts`), and the canonical list is the comment at
    // `db/schema/recipients.ts:38`. There is no shared constant to import — if
    // one is ever added, this literal should be replaced with it.
    const KNOWN = new Set(['email', 'phone', 'slack', 'push', 'webhook', 'in_app']);

    const { rows } = await client.query<{ type: string }>(
      `SELECT DISTINCT jsonb_array_elements(contact_points)->>'type' AS type
         FROM recipients WHERE tenant_id LIKE 't-%'`,
    );
    const types = rows.map((r) => r.type);

    expect(types.length).toBeGreaterThan(0);
    expect(types).not.toContain('sms');
    expect(types.filter((t) => !KNOWN.has(t))).toEqual([]);
  });

  it('gives every recipient a contact point for each channel it prefers', async () => {
    // The strongest form of the check above: a fixture is only useful if the
    // engine can actually reach it on the channels the fixture claims. This is
    // what "No phone contact point for this recipient" looked like from the
    // outside, and it is worth failing here instead of three files away.
    const { rows } = await client.query<{ id: string; channel: string }>(
      `SELECT r.id, c.channel
         FROM recipients r
         JOIN recipient_preferences p ON p.recipient_id = r.id
         CROSS JOIN LATERAL unnest(p.preferred_channels) AS c(channel)
        WHERE r.tenant_id LIKE 't-%'
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(r.contact_points) AS cp
             WHERE cp->>'type' = CASE WHEN c.channel = 'sms' THEN 'phone' ELSE c.channel END
          )`,
    );

    expect(rows).toEqual([]);
  });

  it('keeps the tenant that makes the GDPR endpoints reachable', async () => {
    // `compliance_profile` is `{}` for every tenant that ships, so
    // POST /v1/recipients/:id/erase and GET /export answer 403 everywhere and
    // are untestable. `t-gdpr` exists solely to be the tenant that carries it —
    // dropping the flag would silently remove that coverage.
    const { rows } = await client.query<{ gdpr: boolean | null }>(
      `SELECT (compliance_profile->>'gdpr')::boolean AS gdpr
         FROM tenants WHERE id = 't-gdpr'`,
    );
    expect(rows[0]?.gdpr).toBe(true);
  });

  it('leaves the happy-path tenant able to send without a consent record', async () => {
    // `require_opt_in` defaults to true for an unconfigured tenant (D108).
    // `t-alpha` opts out so the happy path sends, and `t-gdpr` keeps it so the
    // consent gate stays observable. Flipping either makes a documented test
    // step in TEST_PLAN.md quietly wrong.
    const { rows } = await client.query<{ tenant_id: string; require_opt_in: boolean }>(
      `SELECT tenant_id, require_opt_in FROM tenant_channel_configs
        WHERE tenant_id IN ('t-alpha', 't-gdpr') ORDER BY tenant_id`,
    );
    expect(rows).toEqual([
      { tenant_id: 't-alpha', require_opt_in: false },
      { tenant_id: 't-gdpr', require_opt_in: true },
    ]);
  });

  it('gives every recipient a distinct unsubscribe token', async () => {
    // `GET /unsubscribe/:token` is the one route mounted before the auth
    // middleware — it arrives from an email client with no headers, and the
    // token IS the credential. A null token makes that path untestable.
    const { rows } = await client.query<{ total: string; distinct: string }>(
      `SELECT count(unsubscribe_token) AS total,
              count(DISTINCT unsubscribe_token) AS distinct
         FROM recipient_preferences WHERE tenant_id LIKE 't-%'`,
    );
    expect(Number(rows[0]!.total)).toBe(7);
    expect(Number(rows[0]!.distinct)).toBe(7);
  });
});

describe('the ids other tooling hard-codes', () => {
  /**
   * `testing/bootstrap.mjs`, the generated Postman environment and
   * `testing/TEST_PLAN.md` all name these literally. The fixed ids are the
   * whole reason a request in the collection is runnable on its own, so
   * renaming one in the seed breaks tooling that this suite would otherwise
   * never touch.
   */
  const REQUIRED: Array<[string, string]> = [
    ['11111111-0000-4000-8000-00000000aaa1', 'happy path — email and phone'],
    ['11111111-0000-4000-8000-00000000aaa2', 'email only'],
    ['11111111-0000-4000-8000-00000000aaa3', 'unsubscribed'],
    ['11111111-0000-4000-8000-00000000aaa4', 'quiet hours, Asia/Tokyo'],
    ['11111111-0000-4000-8000-00000000aaa5', 'external ref lookup'],
    ['22222222-0000-4000-8000-00000000bbb1', 'the other tenant'],
    ['33333333-0000-4000-8000-00000000dd01', 'the GDPR subject'],
  ];

  it.each(REQUIRED)('still seeds %s (%s)', async (id) => {
    const { rows } = await client.query(`SELECT 1 FROM recipients WHERE id = $1`, [id]);
    expect(rows).toHaveLength(1);
  });

  it('keeps the edge cases distinguishable from the happy path', async () => {
    // Each of these exists to make one branch of the compliance gate
    // observable. If a future edit makes them all identical the seed still
    // applies, the ids still resolve, and the coverage is gone.
    const { rows } = await client.query<{ status: string; allow: boolean; tz: string }>(
      `SELECT r.status, p.allow_communications AS allow, r.timezone AS tz
         FROM recipients r JOIN recipient_preferences p ON p.recipient_id = r.id
        WHERE r.id IN ('11111111-0000-4000-8000-00000000aaa3',
                       '11111111-0000-4000-8000-00000000aaa4')
        ORDER BY r.id`,
    );

    // aaa3 is suppressed by BOTH mechanisms, so a test can tell them apart.
    expect(rows[0]!.status).toBe('unsubscribed');
    expect(rows[0]!.allow).toBe(false);

    // aaa4 is reachable, but in a timezone where a US-hours window is quiet.
    expect(rows[1]!.tz).toBe('Asia/Tokyo');
    expect(rows[1]!.allow).toBe(true);
  });
});
