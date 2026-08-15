#!/usr/bin/env node
/**
 * One-shot backfill: seal the plaintext channel credentials into
 * `credentials_encrypted`.
 *
 * P12, workstream 3. The columns have been reserved since P2 and unused; this
 * fills them. It is the step BETWEEN two things:
 *
 *   1. deploying a build with CREDENTIAL_ENCRYPTION_KEYS set, which seals on
 *      every write from then on but leaves existing rows alone, and
 *   2. `migrations/0013_encrypt_credentials.sql`, which nulls the plaintext
 *      columns and refuses to run while any row would be left unreadable.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS SCRIPT IS NOT A MIGRATION AND DOES NOT RUN ONE.
 *
 * It writes to two columns that already exist and reads three it does not
 * change. Hard rule 1 forbids an agent running a migration; this is an operator
 * tool that an operator runs, and it defaults to reporting rather than writing.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Usage:
 *
 *   # report what would change, touching nothing (the default)
 *   node scripts/encrypt-credentials.mjs
 *
 *   # actually write
 *   node scripts/encrypt-credentials.mjs --apply
 *
 *   # re-seal rows under a new active key, after rotating
 *   node scripts/encrypt-credentials.mjs --apply --rotate
 *
 * Environment: DATABASE_URL, CREDENTIAL_ENCRYPTION_KEYS,
 * CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID.
 *
 * Safe to re-run. A row already sealed under the active key is skipped, so an
 * interrupted run is resumed by running it again.
 */
import { createCipheriv, randomBytes } from 'node:crypto';
import process from 'node:process';

import pg from 'pg';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Mirrors TENANT_SECRET_COLUMNS in src/engine/tenancy/credential-cipher.ts. */
const SECRETS = [
  { column: 'twilio_auth_token', field: 'twilioAuthToken' },
  { column: 'sendgrid_api_key', field: 'sendgridApiKey' },
  { column: 'slack_bot_token', field: 'slackBotToken' },
];

const apply = process.argv.includes('--apply');
const rotate = process.argv.includes('--rotate');

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function loadKeys() {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEYS;
  if (!raw) fail('CREDENTIAL_ENCRYPTION_KEYS is not set');

  const keys = new Map();
  for (const entry of raw.split(',').map((e) => e.trim()).filter(Boolean)) {
    const separator = entry.indexOf(':');
    if (separator <= 0) fail("malformed key entry; expected '<keyId>:<base64 key>'");
    const keyId = entry.slice(0, separator);
    const key = Buffer.from(entry.slice(separator + 1), 'base64');
    if (key.length !== 32) {
      fail(`key '${keyId}' is ${key.length} bytes; AES-256 needs 32 (openssl rand -base64 32)`);
    }
    keys.set(keyId, key);
  }

  const activeKeyId = process.env.CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID ?? [...keys.keys()][0];
  if (!keys.has(activeKeyId)) fail(`active key id '${activeKeyId}' is not among the keys supplied`);
  return { keys, activeKeyId };
}

function seal(key, keyId, plaintext) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    v: 1,
    keyId,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

async function main() {
  if (!process.env.DATABASE_URL) fail('DATABASE_URL is not set');

  const { keys, activeKeyId } = loadKeys();
  const activeKey = keys.get(activeKeyId);

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const { rows } = await client.query(
      `SELECT id, tenant_id, ${SECRETS.map((s) => s.column).join(', ')},
              credentials_encrypted, encryption_key_id
         FROM tenant_channel_configs
        ORDER BY tenant_id`,
    );

    let sealed = 0;
    let skipped = 0;
    let empty = 0;

    for (const row of rows) {
      const bundle = row.credentials_encrypted ?? {};
      const next = { ...bundle };
      const changed = [];

      for (const { column, field } of SECRETS) {
        const plaintext = row[column];
        if (!plaintext) continue;

        const existing = bundle[field];
        // Already sealed under the active key, and not rotating: leave it.
        if (existing && (!rotate || existing.keyId === activeKeyId)) continue;

        next[field] = seal(activeKey, activeKeyId, plaintext);
        changed.push(field);
      }

      if (changed.length === 0) {
        if (Object.keys(next).length === 0) empty += 1;
        else skipped += 1;
        continue;
      }

      process.stdout.write(
        `${apply ? 'sealing' : 'would seal'} ${row.tenant_id}: ${changed.join(', ')}\n`,
      );

      if (apply) {
        await client.query(
          `UPDATE tenant_channel_configs
              SET credentials_encrypted = $1, encryption_key_id = $2, updated_at = now()
            WHERE id = $3`,
          [JSON.stringify(next), activeKeyId, row.id],
        );
      }
      sealed += 1;
    }

    process.stdout.write(
      `\n${apply ? 'sealed' : 'would seal'} ${sealed} row(s); ` +
        `${skipped} already sealed; ${empty} hold no credentials; ${rows.length} total\n`,
    );

    if (!apply) {
      process.stdout.write('\nnothing was written. re-run with --apply to write.\n');
      return;
    }

    // The precondition 0013 checks. Reporting it here means the operator learns
    // it now rather than from a migration that refuses to run.
    const { rows: remaining } = await client.query(
      `SELECT count(*)::int AS n
         FROM tenant_channel_configs
        WHERE (twilio_auth_token IS NOT NULL AND credentials_encrypted -> 'twilioAuthToken' IS NULL)
           OR (sendgrid_api_key  IS NOT NULL AND credentials_encrypted -> 'sendgridApiKey'  IS NULL)
           OR (slack_bot_token   IS NOT NULL AND credentials_encrypted -> 'slackBotToken'   IS NULL)`,
    );

    const left = remaining[0]?.n ?? 0;
    process.stdout.write(
      left === 0
        ? '\nevery credential is sealed. migrations/0013_encrypt_credentials.sql can now be applied.\n'
        : `\n${left} row(s) still hold an unsealed credential — 0013 will refuse to run. Re-run this script.\n`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
