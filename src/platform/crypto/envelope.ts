/**
 * Envelope encryption for channel credentials.
 *
 * `credentials_encrypted` and `encryption_key_id` were reserved in P2 with the
 * note "P12 can flip to envelope encryption and drop the flat columns without
 * another migration". This is the flip.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to open rather
 * than decrypting to something. One random 12-byte IV per seal, never reused.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO DELIBERATE DIVERGENCES FROM `shared-libs/utils/encryption.ts`
 *
 * 1. **No usable default key.** The shared-libs service defaults its secret to
 *    the literal `'default-encryption-key-change-in-production'` and only
 *    refuses it when `NODE_ENV === 'production'`. Every other environment
 *    therefore encrypts with a key that is in the repository — which is worse
 *    than storing plaintext, because the column now *looks* protected and the
 *    next person reasons accordingly. Here a key must be supplied, and a
 *    malformed or short one fails at construction.
 *
 * 2. **The key is derived once, not per operation.** shared-libs runs scrypt on
 *    every encrypt *and every decrypt*, with a fresh salt each time. That is
 *    the correct shape for a password and the wrong one for a key: scrypt is
 *    deliberately expensive, and credential resolution sits on the send path.
 *    Keys here are 32 bytes of key material supplied as base64 — already
 *    uniform, with nothing to stretch.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * **Rotation is why `encryption_key_id` exists.** More than one key can be
 * loaded; one is active. New values seal under the active key, old values still
 * open under the key they name. Retiring a key is then a backfill, not an
 * outage — and nothing has to decrypt the whole table in one transaction.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** What goes in the jsonb column. Versioned so the format can change. */
export interface SealedValue {
  v: 1;
  keyId: string;
  iv: string;
  tag: string;
  ct: string;
}

export class CryptoError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'CryptoError';
  }
}

export interface SealerConfig {
  /** keyId -> base64-encoded 32 bytes. */
  keys: Record<string, string>;
  /** Which key new values are sealed under. Must be present in `keys`. */
  activeKeyId: string;
}

export class Sealer {
  private readonly keys = new Map<string, Buffer>();

  constructor(private readonly config: SealerConfig) {
    for (const [keyId, encoded] of Object.entries(config.keys)) {
      const key = Buffer.from(encoded, 'base64');
      if (key.length !== KEY_BYTES) {
        throw new CryptoError(
          `Encryption key '${keyId}' is ${key.length} bytes; AES-256 needs exactly ${KEY_BYTES}. Generate one with: openssl rand -base64 32`,
          'BAD_KEY_LENGTH',
        );
      }
      this.keys.set(keyId, key);
    }

    if (this.keys.size === 0) {
      throw new CryptoError('No encryption keys were configured', 'NO_KEYS');
    }
    if (!this.keys.has(config.activeKeyId)) {
      throw new CryptoError(
        `Active key id '${config.activeKeyId}' is not among the configured keys (${[...this.keys.keys()].join(', ')})`,
        'UNKNOWN_ACTIVE_KEY',
      );
    }
  }

  get activeKeyId(): string {
    return this.config.activeKeyId;
  }

  seal(plaintext: string): SealedValue {
    const key = this.keys.get(this.config.activeKeyId)!;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });

    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

    return {
      v: 1,
      keyId: this.config.activeKeyId,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ct: ct.toString('base64'),
    };
  }

  open(sealed: SealedValue): string {
    if (sealed.v !== 1) {
      throw new CryptoError(`Unsupported sealed-value version ${String(sealed.v)}`, 'BAD_VERSION');
    }

    const key = this.keys.get(sealed.keyId);
    if (!key) {
      // The row names a key this process was not given. Say which, because the
      // fix is a configuration change and the operator needs the id.
      throw new CryptoError(
        `No key '${sealed.keyId}' is configured; this value cannot be decrypted here`,
        'UNKNOWN_KEY',
      );
    }

    try {
      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(sealed.iv, 'base64'), {
        authTagLength: TAG_BYTES,
      });
      decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(sealed.ct, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch (error) {
      // GCM authentication failed: wrong key, or the ciphertext was altered.
      // Never fall back to anything — a credential that will not open is a
      // failure to report, not a reason to reach for the plaintext column.
      throw new CryptoError(
        `Failed to decrypt a value sealed under key '${sealed.keyId}': ${
          error instanceof Error ? error.message : String(error)
        }`,
        'DECRYPT_FAILED',
      );
    }
  }

  /** True when this value was sealed under a key that is no longer the active one. */
  needsRotation(sealed: SealedValue): boolean {
    return sealed.keyId !== this.config.activeKeyId;
  }
}

/**
 * `id:base64key,id2:base64key2` → `{id: base64key, ...}`.
 *
 * A list rather than a single key so that rotating does not require every
 * replica to be restarted in the same instant: both keys are configured, the
 * active one moves, and the old one is removed once nothing names it.
 */
export function parseKeyList(raw: string): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const entry of raw.split(',').map((e) => e.trim()).filter(Boolean)) {
    const separator = entry.indexOf(':');
    if (separator <= 0) {
      throw new CryptoError(
        `Malformed encryption key entry '${redact(entry)}'; expected '<keyId>:<base64 key>'`,
        'BAD_KEY_LIST',
      );
    }
    keys[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return keys;
}

/** Never put key material in an error message. */
function redact(entry: string): string {
  const separator = entry.indexOf(':');
  return separator > 0 ? `${entry.slice(0, separator)}:<redacted>` : '<redacted>';
}

/** Guards against a key accidentally configured twice under different ids. */
export function hasDuplicateKeys(keys: Record<string, string>): boolean {
  const seen: Buffer[] = [];
  for (const encoded of Object.values(keys)) {
    const key = Buffer.from(encoded, 'base64');
    if (seen.some((other) => other.length === key.length && timingSafeEqual(other, key))) {
      return true;
    }
    seen.push(key);
  }
  return false;
}
