/**
 * Which columns hold secrets, and how a config row's secrets move between the
 * flat plaintext columns and `credentials_encrypted`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * READS PREFER CIPHERTEXT AND FALL BACK TO PLAINTEXT. THAT IS TEMPORARY, AND IT
 * IS WHAT MAKES THE CUTOVER SURVIVABLE.
 *
 * `9003_channel_configs.sql` is still inserting plaintext credentials for the
 * length of the parallel run, and the delta sync re-runs it. A build that read
 * only `credentials_encrypted` would find nothing for every row that arrived
 * after the backfill, and every send for that tenant would fail to resolve
 * credentials.
 *
 * So the order is: encrypted value if there is one, plaintext otherwise. Once
 * the parallel run ends and `0013_encrypt_credentials.sql` nulls the plaintext
 * columns, the fallback finds nothing and stops mattering — with no second code
 * change and no window where a rotated credential is unreadable.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { Logger } from 'winston';

import { CryptoError, type SealedValue, type Sealer } from '../../platform/crypto/envelope.js';

/**
 * The secret-bearing columns. Everything else on these tables is a phone
 * number, an address or a flag — identifying, but not a credential, and
 * sealing them would make the row unreadable to the SQL an operator debugs with
 * for no gain.
 *
 * `twilio_account_sid` is deliberately NOT here: it is an account identifier,
 * it appears in Twilio's own webhook payloads, and `getTenantConfigByTwilioAccount`
 * looks a row up by it — sealing it would break inbound signature verification.
 */
export const TENANT_SECRET_COLUMNS = [
  'twilioAuthToken',
  'sendgridApiKey',
  'slackBotToken',
] as const;

export type TenantSecretColumn = (typeof TENANT_SECRET_COLUMNS)[number];

/** `agent_channel_configs` carries no secret of its own today — see D96. */
export const AGENT_SECRET_COLUMNS: readonly string[] = [];

export type SealedBundle = Partial<Record<string, SealedValue>>;

export interface CredentialCipherDeps {
  sealer: Sealer;
  logger: Logger;
}

export class CredentialCipher {
  constructor(private readonly deps: CredentialCipherDeps) {}

  get activeKeyId(): string {
    return this.deps.sealer.activeKeyId;
  }

  /** Seal every present secret into one bundle for the jsonb column. */
  seal(row: Partial<Record<TenantSecretColumn, string | null>>): SealedBundle {
    const bundle: SealedBundle = {};
    for (const column of TENANT_SECRET_COLUMNS) {
      const value = row[column];
      if (value) bundle[column] = this.deps.sealer.seal(value);
    }
    return bundle;
  }

  /**
   * Resolve one secret: the sealed value when present, the plaintext column
   * otherwise.
   *
   * A value that fails to open is **not** silently replaced by the plaintext.
   * That would turn a wrong key or a tampered row into a working send, which is
   * precisely the event that should be visible.
   */
  resolve(
    column: TenantSecretColumn,
    bundle: unknown,
    plaintext: string | null | undefined,
  ): string | null {
    const sealed = readBundle(bundle)?.[column];

    if (sealed) {
      try {
        return this.deps.sealer.open(sealed);
      } catch (error) {
        this.deps.logger.error('failed to open a sealed credential', {
          column,
          keyId: sealed.keyId,
          code: error instanceof CryptoError ? error.code : 'UNKNOWN',
        });
        throw error;
      }
    }

    return plaintext ?? null;
  }

  /**
   * Open a whole row's secrets, so callers can treat a config row as though the
   * flat columns still held usable values.
   */
  decryptRow<T extends Partial<Record<TenantSecretColumn, string | null>>>(
    row: T & { credentialsEncrypted?: unknown },
  ): T {
    const bundle = readBundle(row.credentialsEncrypted);
    if (!bundle) return row;

    const decrypted = { ...row };
    for (const column of TENANT_SECRET_COLUMNS) {
      decrypted[column] = this.resolve(column, bundle, row[column]) as T[TenantSecretColumn];
    }
    return decrypted;
  }

  /** True when the row holds a secret that is not sealed yet. */
  needsSealing(row: Partial<Record<TenantSecretColumn, string | null>> & {
    credentialsEncrypted?: unknown;
  }): boolean {
    const bundle = readBundle(row.credentialsEncrypted);
    return TENANT_SECRET_COLUMNS.some((column) => Boolean(row[column]) && !bundle?.[column]);
  }
}

function readBundle(value: unknown): Record<string, SealedValue> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, SealedValue>;
}
