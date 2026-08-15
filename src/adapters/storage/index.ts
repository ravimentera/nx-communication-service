/**
 * Storage adapter selection.
 *
 * S3 whenever a bucket is named and `USE_LOCAL_STORAGE` is not forced on;
 * otherwise the local filesystem. The bucket being the deciding input rather
 * than `NODE_ENV` is the same rule as D23 for channel dry-run: configuration
 * says what to do, not an inference from the environment name.
 */
import type { Logger } from 'winston';

import type { StorageProvider } from '../../ports/storage.js';
import { LocalStorageProvider } from './local.provider.js';
import { S3StorageProvider } from './s3.provider.js';

export interface StorageSelection {
  s3Bucket?: string;
  useLocal: boolean;
  localPath: string;
  publicBaseUrl: string;
  s3PublicBaseUrl?: string;
  s3Region: string;
}

export function createStorageProvider(
  config: StorageSelection,
  logger: Logger,
): StorageProvider {
  if (config.s3Bucket && !config.useLocal) {
    return new S3StorageProvider({
      config: {
        bucket: config.s3Bucket,
        region: config.s3Region,
        publicBaseUrl: config.s3PublicBaseUrl,
      },
      logger,
    });
  }

  if (config.s3Bucket && config.useLocal) {
    // Both configured is a mistake worth naming: it usually means someone set
    // the bucket and forgot USE_LOCAL_STORAGE=false, and then wondered why
    // production assets disappeared on the next deploy.
    logger.warn(
      'S3_MEMORY_BUCKET is set but USE_LOCAL_STORAGE=true — using local storage, which does not survive a deploy or work across replicas',
      { bucket: config.s3Bucket },
    );
  }

  return new LocalStorageProvider({
    config: { root: config.localPath, publicBaseUrl: config.publicBaseUrl },
    logger,
  });
}

export { LocalStorageProvider } from './local.provider.js';
export { S3StorageProvider } from './s3.provider.js';
