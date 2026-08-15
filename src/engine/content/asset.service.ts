/**
 * Assets: bytes in the storage adapter, a row in `assets`.
 *
 * The source has no asset record at all. `saveAsset` (`template-engine.ts:1014`)
 * writes a file and returns its filename; nothing records who uploaded it, which
 * tenant it belongs to, or how big it was, and the `assets` table this service
 * has carried since P2 has never had a writer. That means an asset in the source
 * is untenanted by construction: the only handle on it is a filename in a shared
 * directory, so any caller who can guess one can fetch another clinic's image.
 *
 * Here every asset carries `tenant_id`, and the storage key is derived from it,
 * so the tenant boundary holds in the object store as well as in the table.
 *
 * The **key is service-assigned**: `<tenantId>/<kind>/<uuid><ext>`. A
 * caller-supplied filename is recorded in `metadata.filename` for display and
 * never reaches the filesystem, which is where the source's traversal exposure
 * came from.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { Logger } from 'winston';

import type { Db } from '../../db/index.js';
import { assets } from '../../db/schema.js';
import { ValidationError } from '../../platform/http/errors.js';
import type { StorageProvider } from '../../ports/storage.js';

export type AssetKind = 'image' | 'document' | 'generated';

export interface AssetRecord {
  id: string;
  tenantId: string;
  subTenantId?: string | null;
  kind: string;
  url: string;
  mimeType?: string | null;
  size?: number | null;
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
}

export interface SaveAssetInput {
  tenantId: string;
  subTenantId?: string;
  kind: AssetKind;
  body: Buffer;
  /** As supplied by the client. Recorded, never used to build a path. */
  filename?: string;
  mimeType?: string;
  uploadedBy?: string;
  metadata?: Record<string, unknown>;
}

export interface AssetServiceDeps {
  db: Db;
  storage: StorageProvider;
  logger: Logger;
  /** Bytes. A larger body is rejected before anything is written. */
  maxBytes: number;
}

/**
 * Extensions we are willing to name a stored object with, by MIME type.
 *
 * Deliberately a small allowlist rather than a `mime.extension()` lookup: the
 * extension ends up in a URL that a mail client will fetch, and the set of
 * things a template legitimately embeds is short. Anything unrecognised is
 * stored as `.bin` rather than rejected — the MIME type is still recorded, so
 * nothing is lost, and an unusual document type does not fail an upload.
 */
const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/html': 'html',
  'text/csv': 'csv',
};

export function extensionFor(mimeType?: string): string {
  if (!mimeType) return 'bin';
  return EXTENSIONS[mimeType.toLowerCase().split(';')[0]?.trim() ?? ''] ?? 'bin';
}

export class AssetService {
  /** Exposed so the multipart parser can reject an oversized body up front. */
  readonly maxBytes: number;

  constructor(private readonly deps: AssetServiceDeps) {
    this.maxBytes = deps.maxBytes;
  }

  async save(input: SaveAssetInput): Promise<AssetRecord> {
    if (input.body.length === 0) {
      throw new ValidationError('Asset body is empty');
    }
    if (input.body.length > this.deps.maxBytes) {
      throw new ValidationError(
        `Asset is ${input.body.length} bytes, over the ${this.deps.maxBytes}-byte limit`,
        { size: input.body.length, maxBytes: this.deps.maxBytes },
      );
    }

    const key = assetKey(input.tenantId, input.kind, input.mimeType);
    const stored = await this.deps.storage.put({
      key,
      body: input.body,
      mimeType: input.mimeType,
      // Assets are immutable — the key carries a UUID, so a changed image is a
      // new asset. A year is safe and keeps them out of the render path.
      cacheMaxAge: 31_536_000,
    });

    const [row] = await this.deps.db
      .insert(assets)
      .values({
        tenantId: input.tenantId,
        subTenantId: input.subTenantId ?? null,
        kind: input.kind,
        url: stored.url,
        mimeType: input.mimeType ?? null,
        size: stored.size,
        metadata: {
          ...(input.metadata ?? {}),
          storageKey: key,
          storageProvider: this.deps.storage.name,
          filename: input.filename ?? null,
          uploadedBy: input.uploadedBy ?? null,
        },
      })
      .returning();

    this.deps.logger.info('asset saved', {
      tenantId: input.tenantId,
      assetId: row?.id,
      kind: input.kind,
      bytes: stored.size,
    });

    return toRecord(row);
  }

  async get(tenantId: string, id: string): Promise<AssetRecord | null> {
    const [row] = await this.deps.db
      .select()
      .from(assets)
      .where(and(eq(assets.tenantId, tenantId), eq(assets.id, id)))
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async list(
    tenantId: string,
    filter: { kind?: string; limit?: number; offset?: number } = {},
  ): Promise<AssetRecord[]> {
    const conditions = [eq(assets.tenantId, tenantId)];
    if (filter.kind) conditions.push(eq(assets.kind, filter.kind));

    const rows = await this.deps.db
      .select()
      .from(assets)
      .where(and(...conditions))
      .orderBy(desc(assets.createdAt))
      .limit(filter.limit ?? 100)
      .offset(filter.offset ?? 0);

    return rows.map(toRecord);
  }

  /**
   * Delete the row, then the object.
   *
   * That order on purpose: an orphaned object costs storage, an orphaned row
   * costs a broken image in a template that renders as if it were fine. If the
   * storage delete fails the row is already gone, which is the recoverable half.
   */
  async delete(tenantId: string, id: string): Promise<boolean> {
    const record = await this.get(tenantId, id);
    if (!record) return false;

    await this.deps.db
      .delete(assets)
      .where(and(eq(assets.tenantId, tenantId), eq(assets.id, id)));

    const key = (record.metadata as { storageKey?: string } | null)?.storageKey;
    if (key) {
      try {
        await this.deps.storage.delete(key);
      } catch (error) {
        this.deps.logger.error('asset row deleted but object remains', {
          tenantId,
          assetId: id,
          key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return true;
  }
}

/** `<tenantId>/<kind>/<uuid>.<ext>` — never built from caller input. */
export function assetKey(tenantId: string, kind: AssetKind, mimeType?: string): string {
  // A tenant id is a text column and could in principle hold a slash; the port's
  // `assertSafeKey` would reject the result, so normalise rather than trip it.
  const safeTenant = tenantId.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${safeTenant}/${kind}/${crypto.randomUUID()}.${extensionFor(mimeType)}`;
}

function toRecord(row: typeof assets.$inferSelect | undefined): AssetRecord {
  if (!row) throw new Error('insert returned no row');
  return {
    id: row.id,
    tenantId: row.tenantId,
    subTenantId: row.subTenantId,
    kind: row.kind,
    url: row.url,
    mimeType: row.mimeType,
    size: row.size,
    metadata: row.metadata as Record<string, unknown> | null,
    createdAt: row.createdAt,
  };
}
