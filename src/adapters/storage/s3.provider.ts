/**
 * S3 storage — the deployed adapter.
 *
 * `@aws-sdk/client-s3` has been a declared dependency since P0 and nothing has
 * imported it until now. The source never had this path at all: it wrote assets
 * to a container filesystem, so an asset uploaded through one replica 404'd from
 * every other one and vanished on the next deploy.
 *
 * **Objects are private.** No ACL is set, so the bucket's own policy decides
 * whether the URL resolves for an anonymous reader. A template's image usually
 * has to be publicly fetchable — by a mail client, from an arbitrary network —
 * and that is a deployment decision (bucket policy, or a CDN in front via
 * `S3_PUBLIC_BASE_URL`), not something to bake in by stamping `public-read` on
 * every object an authenticated caller can upload.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import type { Logger } from 'winston';

import {
  assertSafeKey,
  StorageError,
  type PutObjectInput,
  type StorageProvider,
  type StoredObject,
} from '../../ports/storage.js';

export interface S3StorageConfig {
  bucket: string;
  region: string;
  /** A CDN origin in front of the bucket. Falls back to the S3 virtual host. */
  publicBaseUrl?: string;
}

export interface S3StorageDeps {
  config: S3StorageConfig;
  logger: Logger;
  /** Injected so tests do not have to mock the AWS SDK module. */
  client?: S3Client;
}

export class S3StorageProvider implements StorageProvider {
  readonly name = 's3';

  private readonly client: S3Client;

  constructor(private readonly deps: S3StorageDeps) {
    const clientConfig: S3ClientConfig = { region: deps.config.region };
    this.client = deps.client ?? new S3Client(clientConfig);
  }

  url(key: string): string {
    assertSafeKey(key);
    const base =
      this.deps.config.publicBaseUrl?.replace(/\/+$/, '') ??
      `https://${this.deps.config.bucket}.s3.${this.deps.config.region}.amazonaws.com`;
    return `${base}/${key}`;
  }

  async put(input: PutObjectInput): Promise<StoredObject> {
    assertSafeKey(input.key);

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.deps.config.bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.mimeType,
          ContentLength: input.body.length,
          CacheControl:
            input.cacheMaxAge === undefined ? undefined : `public, max-age=${input.cacheMaxAge}`,
        }),
      );
    } catch (error) {
      throw new StorageError(
        `Failed to put '${input.key}' into s3://${this.deps.config.bucket}`,
        'WRITE_FAILED',
        true,
        error,
      );
    }

    this.deps.logger.info('asset stored', {
      provider: this.name,
      bucket: this.deps.config.bucket,
      key: input.key,
      bytes: input.body.length,
    });

    return {
      key: input.key,
      url: this.url(input.key),
      size: input.body.length,
      mimeType: input.mimeType,
    };
  }

  async get(key: string): Promise<Buffer | undefined> {
    assertSafeKey(key);
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.deps.config.bucket, Key: key }),
      );
      if (!response.Body) return undefined;
      return Buffer.from(await response.Body.transformToByteArray());
    } catch (error) {
      if (isNoSuchKey(error)) return undefined;
      throw new StorageError(`Failed to get '${key}'`, 'READ_FAILED', true, error);
    }
  }

  async delete(key: string): Promise<boolean> {
    assertSafeKey(key);
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.deps.config.bucket, Key: key }),
      );
      return true;
    } catch (error) {
      if (isNoSuchKey(error)) return false;
      throw new StorageError(`Failed to delete '${key}'`, 'DELETE_FAILED', true, error);
    }
  }
}

/**
 * S3 reports a missing object as `NoSuchKey` on GET but as a 404 `NotFound` on
 * HEAD, and `DeleteObject` succeeds on a key that was never there. Matching both
 * names keeps "absent" distinguishable from "the bucket is unreachable" — the
 * difference between returning `undefined` and retrying.
 */
function isNoSuchKey(error: unknown): boolean {
  const name = (error as { name?: string } | undefined)?.name;
  return name === 'NoSuchKey' || name === 'NotFound';
}
