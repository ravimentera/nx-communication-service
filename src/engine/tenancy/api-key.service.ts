/**
 * API keys — `AUTH_MODE=apikey`, the thing that lets a vendor run this service
 * with no Mentera gateway in front of it.
 *
 * `tenant_api_keys` has existed since P2 and has never been read; P1 left the
 * middleware branch as an explicit 501 so the seam existed without pretending
 * to be secure. This is the implementation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE HASH IS SHA-256, NOT BCRYPT — AND THAT IS THE STRONGER CHOICE HERE.
 *
 * `tenancy.ts:55` describes the column as an "Argon2/bcrypt digest". Those are
 * password hashes: deliberately slow, and **individually salted**, which means
 * the digest of a presented secret cannot be computed and looked up. Verifying
 * would have to load every key in the table and test the candidate against each
 * one — O(number of keys in the entire installation) bcrypt operations, on every
 * request, and the `tenant_api_keys_hash_unique` index the same file declares
 * would be unusable.
 *
 * Slow hashing exists to make brute-forcing a *low-entropy human-chosen* secret
 * expensive. An API key here is 32 bytes from `randomBytes` — 256 bits. There is
 * no dictionary to run and no brute force to slow down, so the property bcrypt
 * buys does not apply, while the cost it imposes very much does.
 *
 * SHA-256 of the presented secret, compared against a unique-indexed column, is
 * a single indexed lookup and gives up nothing. See D94.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The plaintext key is returned **once**, at creation, and never stored. A lost
 * key is rotated, not recovered.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Logger } from 'winston';

import type { Db } from '../../db/index.js';
import { tenantApiKeys } from '../../db/schema.js';
import { NotFoundError, ValidationError } from '../../platform/http/errors.js';
import type { KeyValueStore } from '../../platform/redis/client.js';

/**
 * A recognisable prefix so a leaked key is greppable — by a secret scanner, by
 * a support engineer reading a paste, and by the person who committed it.
 */
const KEY_PREFIX = 'ork_';

/** How long a verified key stays cached. Short: a revocation must take effect. */
const CACHE_TTL_SECONDS = 30;

export interface ApiKeyRecord {
  id: string;
  tenantId: string;
  name: string;
  scopes: string[];
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

/** What the auth middleware needs to build an identity. */
export interface ResolvedApiKey {
  keyId: string;
  tenantId: string;
  scopes: string[];
}

export interface ApiKeyServiceDeps {
  db: Db;
  logger: Logger;
  /** Verification cache. Degrades to the in-memory store like everything else. */
  cache: KeyValueStore;
  keyPrefix?: string;
}

export function hashKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export class ApiKeyService {
  constructor(private readonly deps: ApiKeyServiceDeps) {}

  private cacheKey(hash: string): string {
    return `${this.deps.keyPrefix ?? 'outreach:'}apikey:${hash}`;
  }

  /**
   * Create a key. The plaintext is in the return value and nowhere else — not
   * in the row, not in a log line.
   */
  async create(input: {
    tenantId: string;
    name: string;
    scopes: string[];
    expiresAt?: Date;
  }): Promise<{ key: string; record: ApiKeyRecord }> {
    if (input.scopes.length === 0) {
      // A key that can do everything by default is how a "read-only reporting
      // key" ends up able to send messages.
      throw new ValidationError('An API key must declare at least one scope');
    }

    const plaintext = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;

    const [row] = await this.deps.db
      .insert(tenantApiKeys)
      .values({
        tenantId: input.tenantId,
        name: input.name,
        keyHash: hashKey(plaintext),
        scopes: input.scopes,
        expiresAt: input.expiresAt ?? null,
      })
      .returning();

    this.deps.logger.info('api key created', {
      tenantId: input.tenantId,
      keyId: row?.id,
      name: input.name,
      scopes: input.scopes,
      expiresAt: input.expiresAt?.toISOString(),
    });

    return { key: plaintext, record: toRecord(row) };
  }

  async list(tenantId: string): Promise<ApiKeyRecord[]> {
    const rows = await this.deps.db
      .select()
      .from(tenantApiKeys)
      .where(eq(tenantApiKeys.tenantId, tenantId))
      .orderBy(desc(tenantApiKeys.createdAt));
    return rows.map(toRecord);
  }

  /**
   * Revoke. Not a delete: the row is the only record that the key existed, and
   * "which key sent this?" is a question an incident asks after the key is gone.
   */
  async revoke(tenantId: string, keyId: string): Promise<ApiKeyRecord> {
    const [row] = await this.deps.db
      .update(tenantApiKeys)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(tenantApiKeys.tenantId, tenantId), eq(tenantApiKeys.id, keyId)))
      .returning();

    if (!row) throw new NotFoundError(`API key '${keyId}' not found`);

    await this.deps.cache.del(this.cacheKey(row.keyHash));
    this.deps.logger.info('api key revoked', { tenantId, keyId });
    return toRecord(row);
  }

  /**
   * Rotate: issue a replacement and revoke the old one after `graceSeconds`.
   *
   * Rotation without an overlap is an outage — the caller has to deploy the new
   * key at the same instant the old one dies. The grace window defaults to an
   * hour and the old key keeps working until it elapses.
   */
  async rotate(
    tenantId: string,
    keyId: string,
    graceSeconds = 3600,
  ): Promise<{ key: string; record: ApiKeyRecord; previousExpiresAt: Date }> {
    const [existing] = await this.deps.db
      .select()
      .from(tenantApiKeys)
      .where(and(eq(tenantApiKeys.tenantId, tenantId), eq(tenantApiKeys.id, keyId)))
      .limit(1);

    if (!existing) throw new NotFoundError(`API key '${keyId}' not found`);

    const created = await this.create({
      tenantId,
      name: existing.name,
      scopes: existing.scopes,
      expiresAt: existing.expiresAt ?? undefined,
    });

    const previousExpiresAt = new Date(Date.now() + graceSeconds * 1000);
    await this.deps.db
      .update(tenantApiKeys)
      .set({ expiresAt: previousExpiresAt, updatedAt: new Date() })
      .where(and(eq(tenantApiKeys.tenantId, tenantId), eq(tenantApiKeys.id, keyId)));

    await this.deps.cache.del(this.cacheKey(existing.keyHash));
    this.deps.logger.info('api key rotated', {
      tenantId,
      previousKeyId: keyId,
      newKeyId: created.record.id,
      previousExpiresAt: previousExpiresAt.toISOString(),
    });

    return { ...created, previousExpiresAt };
  }

  /**
   * Verify a presented key. Returns null for anything not currently usable —
   * unknown, revoked or expired — deliberately without saying which. A caller
   * holding a revoked key and a caller guessing learn the same thing.
   */
  async verify(presented: string): Promise<ResolvedApiKey | null> {
    if (!presented.startsWith(KEY_PREFIX)) return null;

    const hash = hashKey(presented);
    const cacheKey = this.cacheKey(hash);

    const cached = await this.deps.cache.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as ResolvedApiKey;
      } catch {
        // Corrupt entry: fall through to the database rather than fail the call.
      }
    }

    const [row] = await this.deps.db
      .select()
      .from(tenantApiKeys)
      .where(and(eq(tenantApiKeys.keyHash, hash), isNull(tenantApiKeys.revokedAt)))
      .limit(1);

    if (!row) return null;

    // The lookup already matched on the full digest, so this compares equal by
    // construction. It is here because the equality that decides authentication
    // should be the constant-time one on principle — the next person to change
    // this function may not preserve the indexed-lookup shape.
    if (!constantTimeEquals(row.keyHash, hash)) return null;

    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;

    const resolved: ResolvedApiKey = {
      keyId: row.id,
      tenantId: row.tenantId,
      scopes: row.scopes,
    };

    await this.deps.cache.set(cacheKey, JSON.stringify(resolved), CACHE_TTL_SECONDS);
    void this.touch(row.id, row.lastUsedAt);
    return resolved;
  }

  /**
   * Record use, at most once a minute per key.
   *
   * `last_used_at` is worth having — it is how an operator finds the key nobody
   * has used in six months and retires it — but a write on every authenticated
   * request would put one UPDATE on the hot path of every call the service
   * serves. Rounding to the minute keeps the answer useful and the cost near
   * zero. Fire-and-forget: failing to record a timestamp must not fail a
   * request.
   */
  private async touch(keyId: string, lastUsedAt: Date | null): Promise<void> {
    if (lastUsedAt && Date.now() - lastUsedAt.getTime() < 60_000) return;
    try {
      await this.deps.db
        .update(tenantApiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(tenantApiKeys.id, keyId));
    } catch (error) {
      this.deps.logger.warn('failed to record api key use', {
        keyId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function toRecord(row: typeof tenantApiKeys.$inferSelect | undefined): ApiKeyRecord {
  if (!row) throw new Error('insert returned no row');
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    scopes: row.scopes,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}
