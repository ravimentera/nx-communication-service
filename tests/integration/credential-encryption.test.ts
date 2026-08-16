/**
 * Credential encryption, and `0013_encrypt_credentials.sql`.
 *
 * `0013` is the one migration in the `0*` series that is not baseline schema —
 * it is a decommissioning step, and applying it before credentials are sealed
 * would leave a tenant unable to send. This suite is the only place it runs, and
 * it applies it deliberately, after proving the guard refuses when it should.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { baselineMigrations } from '../helpers/migrations.js';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { Client } from 'pg';
import winston from 'winston';

import { createDb, type Db } from '../../src/db/index.js';
import { tenantChannelConfigs, tenants } from '../../src/db/schema.js';
import { ChannelConfigService } from '../../src/engine/delivery/channel-config.service.js';
import { CredentialCipher } from '../../src/engine/tenancy/credential-cipher.js';
import { CryptoError, Sealer, hasDuplicateKeys, parseKeyList } from '../../src/platform/crypto/envelope.js';
import { Cache, createRedis, type RedisHandle } from '../../src/platform/redis/index.js';

const logger = winston.createLogger({ silent: true });
const MIGRATIONS = join(process.cwd(), 'migrations');

// Two 32-byte keys, so rotation has something to rotate to.
const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');

const sealerA = new Sealer({ keys: { k1: KEY_A }, activeKeyId: 'k1' });

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: { end: () => Promise<void> };
let redis: RedisHandle;
let configs: ChannelConfigService;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();

  const client = new Client({ connectionString: container.getConnectionUri() });
  await client.connect();
  for (const file of baselineMigrations(MIGRATIONS)) {
    await client.query(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
  await client.end();

  const created = createDb({ url: container.getConnectionUri() }, logger);
  db = created.db;
  pool = created.pool;

  await db.insert(tenants).values([
    { id: 'sealed-tenant', name: 'Sealed' },
    { id: 'plaintext-tenant', name: 'Plaintext' },
  ]);

  redis = await createRedis({ skip: true, keyPrefix: 'test:' } as never, logger);
  configs = new ChannelConfigService(
    db,
    new Cache(redis, logger),
    logger,
    new CredentialCipher({ sealer: sealerA, logger }),
  );
}, 300_000);

afterAll(async () => {
  await redis?.close().catch(() => {});
  await pool?.end().catch(() => {});
  await container?.stop().catch(() => {});
});

describe('Sealer', () => {
  it('round-trips a value', () => {
    const sealed = sealerA.seal('SG.a-real-looking-key');
    expect(sealed).toMatchObject({ v: 1, keyId: 'k1' });
    expect(sealerA.open(sealed)).toBe('SG.a-real-looking-key');
  });

  it('never produces the same ciphertext twice', () => {
    // A fresh IV per seal. Identical ciphertexts would leak which tenants share
    // a credential.
    const one = sealerA.seal('same-secret');
    const two = sealerA.seal('same-secret');
    expect(one.ct).not.toBe(two.ct);
    expect(one.iv).not.toBe(two.iv);
  });

  it('refuses a tampered ciphertext rather than decrypting to something', () => {
    const sealed = sealerA.seal('do-not-touch');
    const tampered = { ...sealed, ct: Buffer.from('rewritten').toString('base64') };
    expect(() => sealerA.open(tampered)).toThrow(CryptoError);
  });

  it('refuses a tampered auth tag', () => {
    const sealed = sealerA.seal('do-not-touch');
    const tampered = { ...sealed, tag: Buffer.alloc(16, 9).toString('base64') };
    expect(() => sealerA.open(tampered)).toThrow(/Failed to decrypt/);
  });

  it('will not open a value sealed under a key it does not have', () => {
    const other = new Sealer({ keys: { k2: KEY_B }, activeKeyId: 'k2' });
    const sealed = other.seal('elsewhere');
    expect(() => sealerA.open(sealed)).toThrow(/No key 'k2' is configured/);
  });

  it('opens an old key’s value while sealing under the new one', () => {
    // The whole reason `encryption_key_id` exists: rotation is a backfill, not
    // a single transaction that must decrypt every row at once.
    const before = new Sealer({ keys: { k1: KEY_A }, activeKeyId: 'k1' }).seal('older');
    const rotating = new Sealer({ keys: { k1: KEY_A, k2: KEY_B }, activeKeyId: 'k2' });

    expect(rotating.open(before)).toBe('older');
    expect(rotating.needsRotation(before)).toBe(true);
    expect(rotating.seal('newer').keyId).toBe('k2');
  });

  it.each([
    ['a short key', { k1: Buffer.alloc(16, 1).toString('base64') }, /needs exactly 32/],
    ['no keys at all', {}, /No encryption keys/],
  ])('refuses %s at construction', (_label, keys, message) => {
    expect(() => new Sealer({ keys, activeKeyId: 'k1' })).toThrow(message);
  });

  it('refuses an active key id that is not among the keys', () => {
    expect(() => new Sealer({ keys: { k1: KEY_A }, activeKeyId: 'k9' })).toThrow(
      /not among the configured keys/,
    );
  });
});

describe('parseKeyList', () => {
  it('parses one and many', () => {
    expect(parseKeyList(`k1:${KEY_A}`)).toEqual({ k1: KEY_A });
    expect(parseKeyList(` k1:${KEY_A} , k2:${KEY_B} `)).toEqual({ k1: KEY_A, k2: KEY_B });
  });

  it('rejects a malformed entry without echoing the key material', () => {
    // The error goes to a log; the secret must not go with it.
    expect(() => parseKeyList('nokeyid')).toThrow(/Malformed encryption key entry/);
    expect(() => parseKeyList('nokeyid')).not.toThrow(/nokeyid.*:/);
  });

  it('spots the same key configured under two ids', () => {
    expect(hasDuplicateKeys({ k1: KEY_A, k2: KEY_A })).toBe(true);
    expect(hasDuplicateKeys({ k1: KEY_A, k2: KEY_B })).toBe(false);
  });
});

describe('ChannelConfigService with a cipher', () => {
  it('seals on write and reads back plainly', async () => {
    await configs.upsertTenantConfig('sealed-tenant', {
      name: 'Sealed',
      twilioAccountSid: 'ACsealed',
      twilioAuthToken: 'twilio-secret',
      sendgridApiKey: 'SG.sealed',
    });

    const read = await configs.getTenantConfig('sealed-tenant');
    expect(read?.twilioAuthToken).toBe('twilio-secret');
    expect(read?.sendgridApiKey).toBe('SG.sealed');

    // What is actually stored is ciphertext, and the account sid is left alone
    // because a webhook has to look a row up by it.
    const [row] = await db
      .select()
      .from(tenantChannelConfigs)
      .where(eq(tenantChannelConfigs.tenantId, 'sealed-tenant'));

    const bundle = row?.credentialsEncrypted as Record<string, { ct: string }>;
    expect(Object.keys(bundle).sort()).toEqual(['sendgridApiKey', 'twilioAuthToken']);
    expect(JSON.stringify(bundle)).not.toContain('twilio-secret');
    expect(row?.encryptionKeyId).toBe('k1');
    expect(row?.twilioAccountSid).toBe('ACsealed');
  });

  it('does not drop the other credentials when one is updated', async () => {
    // The stored bundle is one jsonb column, so a partial write that replaced it
    // would silently retire the credentials it did not mention — the D95 shape.
    await configs.upsertTenantConfig('sealed-tenant', { slackBotToken: 'xoxb-added' });

    const read = await configs.getTenantConfig('sealed-tenant');
    expect(read?.slackBotToken).toBe('xoxb-added');
    expect(read?.twilioAuthToken).toBe('twilio-secret');
    expect(read?.sendgridApiKey).toBe('SG.sealed');
  });

  it('keeps cleartext out of the cache', async () => {
    await configs.getTenantConfig('sealed-tenant');

    // The key is hashed now — callers compose ids with `:` separators, so a
    // tenant id containing one used to alias onto a different pair. Scan for
    // the namespace rather than reconstructing the digest, which would just
    // restate the implementation.
    const keys = await redis.store.keys('test:config:tenant:*');
    expect(keys.length).toBeGreaterThan(0);

    const cached = await Promise.all(keys.map((key) => redis.store.get(key)));
    expect(cached.some(Boolean)).toBe(true);
    for (const value of cached) {
      expect(value ?? '').not.toContain('twilio-secret');
      expect(value ?? '').not.toContain('SG.sealed');
    }
  });

  it('still reads a row that was written before encryption was turned on', async () => {
    // 9003_channel_configs.sql inserts plaintext for the whole parallel run, so
    // reads must resolve both shapes at once or every send for a
    // freshly-synced tenant fails.
    await db.insert(tenantChannelConfigs).values({
      tenantId: 'plaintext-tenant',
      name: 'Plaintext',
      twilioAuthToken: 'legacy-plaintext',
    });

    const read = await configs.getTenantConfig('plaintext-tenant');
    expect(read?.twilioAuthToken).toBe('legacy-plaintext');
  });

  it('reports rather than falls back when a sealed value will not open', async () => {
    // A wrong key must not quietly resolve to the plaintext column: that turns
    // the event worth seeing into a working send.
    const wrongKey = new ChannelConfigService(
      db,
      new Cache(await createRedis({ skip: true, keyPrefix: 'wrong:' } as never, logger), logger),
      logger,
      new CredentialCipher({
        sealer: new Sealer({ keys: { k1: KEY_B }, activeKeyId: 'k1' }),
        logger,
      }),
    );

    await expect(wrongKey.getTenantConfig('sealed-tenant')).rejects.toThrow(/Failed to decrypt/);
  });

  it('leaves credentials in plaintext when no cipher is configured', async () => {
    // The default, and every phase before P12.
    const noCipher = new ChannelConfigService(db, new Cache(redis, logger), logger);
    await noCipher.upsertTenantConfig('plaintext-tenant', { sendgridApiKey: 'SG.unsealed' });

    const [row] = await db
      .select()
      .from(tenantChannelConfigs)
      .where(eq(tenantChannelConfigs.tenantId, 'plaintext-tenant'));
    expect(row?.sendgridApiKey).toBe('SG.unsealed');
  });
});

describe('0013_encrypt_credentials.sql', () => {
  const sql = readFileSync(join(MIGRATIONS, '0013_encrypt_credentials.sql'), 'utf8');

  async function run(): Promise<void> {
    const client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  }

  it('refuses to run while a credential is still unsealed', async () => {
    // `plaintext-tenant` holds `legacy-plaintext` and `SG.unsealed` with nothing
    // sealed. Nulling now would destroy the only copy.
    await expect(run()).rejects.toThrow(/Refusing to null plaintext credentials/);
  });

  it('names the tenants that are holding it up', async () => {
    await expect(run()).rejects.toThrow(/plaintext-tenant/);
  });

  it('nulls the plaintext once everything is sealed, and sends still work', async () => {
    // Seal what the backfill script would have sealed.
    const cipher = new CredentialCipher({ sealer: sealerA, logger });
    await db
      .update(tenantChannelConfigs)
      .set({
        credentialsEncrypted: cipher.seal({
          twilioAuthToken: 'legacy-plaintext',
          sendgridApiKey: 'SG.unsealed',
        }),
        encryptionKeyId: 'k1',
      })
      .where(eq(tenantChannelConfigs.tenantId, 'plaintext-tenant'));

    await run();

    const rows = await db.select().from(tenantChannelConfigs);
    expect(rows.every((r) => r.twilioAuthToken === null)).toBe(true);
    expect(rows.every((r) => r.sendgridApiKey === null)).toBe(true);
    expect(rows.every((r) => r.slackBotToken === null)).toBe(true);

    // And the values are still resolvable, which is the point.
    await configs.invalidate('plaintext-tenant');
    const read = await configs.getTenantConfig('plaintext-tenant');
    expect(read?.twilioAuthToken).toBe('legacy-plaintext');
    expect(read?.sendgridApiKey).toBe('SG.unsealed');
  });

  it('leaves twilio_account_sid alone — a webhook looks the row up by it', async () => {
    const [row] = await db
      .select()
      .from(tenantChannelConfigs)
      .where(eq(tenantChannelConfigs.tenantId, 'sealed-tenant'));
    expect(row?.twilioAccountSid).toBe('ACsealed');
  });

  it('stops plaintext coming back', async () => {
    // Without the CHECK, the next 9003 re-run or a hand-written UPDATE quietly
    // reintroduces it and nothing notices until an audit.
    await expect(
      db
        .update(tenantChannelConfigs)
        .set({ sendgridApiKey: 'SG.snuck-back-in' })
        .where(eq(tenantChannelConfigs.tenantId, 'sealed-tenant')),
    ).rejects.toThrow(/no_plaintext_credentials/);
  });

  it('is idempotent', async () => {
    await expect(run()).resolves.toBeUndefined();
  });
});
