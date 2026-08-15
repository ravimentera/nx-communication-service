/**
 * The storage port.
 *
 * `config.storage` has been declared since P0 (`S3_MEMORY_BUCKET`,
 * `USE_LOCAL_STORAGE`, `LOCAL_STORAGE_PATH`) and nothing has ever implemented
 * it, which is why `POST /templates/assets/upload` has answered 501 since P8b.
 * This is that implementation's seam.
 *
 * The source has no port: `template-engine.ts:1014` calls `fs.writeFileSync`
 * directly against a path assembled in the constructor, so a deployment on more
 * than one replica writes assets that only one replica can serve. Behind a port,
 * the local adapter stays the developer default and S3 is the deployed one,
 * without the template engine knowing which it got.
 *
 * **Keys are opaque to the caller.** An asset's key is assigned by the service
 * from the tenant id and a UUID, never from a caller-supplied filename — see
 * `assetKey()` in `engine/content/asset.service.ts`. Adapters still defend
 * themselves (`assertSafeKey`) because a port that is only safe when its callers
 * are careful is not a boundary.
 */

export interface StoredObject {
  /** The key it was stored under. Opaque; do not parse it. */
  key: string;
  /** Where the object can be fetched. Adapter-specific in shape. */
  url: string;
  size: number;
  mimeType?: string;
}

export interface PutObjectInput {
  key: string;
  body: Buffer;
  mimeType?: string;
  /** Seconds. Adapters that cannot express it ignore it. */
  cacheMaxAge?: number;
}

export class StorageError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

export interface StorageProvider {
  readonly name: string;
  put(input: PutObjectInput): Promise<StoredObject>;
  get(key: string): Promise<Buffer | undefined>;
  delete(key: string): Promise<boolean>;
  /** The URL `put` would report for this key, without storing anything. */
  url(key: string): string;
}

/**
 * A key must be a plain relative path of safe segments.
 *
 * Every adapter calls this before touching a filesystem or a bucket. The local
 * adapter is the one that would be exploitable — `path.join(root, key)` with a
 * key of `../../etc/whatever` escapes the root, and `saveAsset` in the source
 * does exactly that join with a caller-supplied `filename` and no check at all.
 * S3 does not have the traversal problem, but a key with a leading slash or a
 * `..` segment produces objects nothing can address, so it is rejected there too.
 */
export function assertSafeKey(key: string): void {
  if (!key || key.length > 512) {
    throw new StorageError('Storage key must be 1-512 characters', 'INVALID_KEY', false);
  }
  if (key.startsWith('/') || key.endsWith('/')) {
    throw new StorageError('Storage key must not start or end with "/"', 'INVALID_KEY', false);
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(key)) {
    throw new StorageError(
      'Storage key may contain only letters, digits, dot, underscore, hyphen and "/"',
      'INVALID_KEY',
      false,
    );
  }
  for (const segment of key.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new StorageError(`Storage key has an unsafe segment: '${segment}'`, 'INVALID_KEY', false);
    }
  }
}
