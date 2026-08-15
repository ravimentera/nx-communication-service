/**
 * Local-filesystem storage. The developer default, and what the source did for
 * every deployment — `template-engine.ts:1014` writes with `fs.writeFileSync`
 * under a path built in the constructor.
 *
 * Two deliberate differences from the source:
 *
 *  1. **Writes are async.** `writeFileSync` blocks the event loop for the
 *     duration of the write, on the request path, in a service that also runs
 *     two BullMQ workers in-process.
 *
 *  2. **The resolved path is checked against the root.** The source joins the
 *     storage root with a caller-supplied `filename` and writes there, so
 *     `filename: '../../../app/dist/index.js'` overwrites the running service.
 *     Keys are service-assigned here, `assertSafeKey` rejects traversal
 *     segments, and this still re-checks the resolved path — three layers,
 *     because the failure mode is arbitrary file write.
 *
 * Not suitable for more than one replica: a file written by one pod cannot be
 * served by another. Use the S3 adapter wherever that is true.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Logger } from 'winston';

import {
  assertSafeKey,
  StorageError,
  type PutObjectInput,
  type StorageProvider,
  type StoredObject,
} from '../../ports/storage.js';

export interface LocalStorageConfig {
  /** Directory everything is written under. Created on first write. */
  root: string;
  /** Origin asset URLs are built from, e.g. `https://api.example.com/assets`. */
  publicBaseUrl: string;
}

export interface LocalStorageDeps {
  config: LocalStorageConfig;
  logger: Logger;
}

export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local';

  private readonly root: string;

  constructor(private readonly deps: LocalStorageDeps) {
    this.root = resolve(deps.config.root);
  }

  /**
   * Resolve a key under the root and refuse anything that lands outside it.
   * `assertSafeKey` should already have made this impossible; a symlinked root
   * or a future caller that skips the port's helper should not turn that into a
   * write to an arbitrary path.
   */
  private pathFor(key: string): string {
    assertSafeKey(key);
    const full = resolve(join(this.root, key));
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new StorageError(`Storage key escapes the root: '${key}'`, 'INVALID_KEY', false);
    }
    return full;
  }

  url(key: string): string {
    assertSafeKey(key);
    return `${this.deps.config.publicBaseUrl.replace(/\/+$/, '')}/${key}`;
  }

  async put(input: PutObjectInput): Promise<StoredObject> {
    const path = this.pathFor(input.key);

    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, input.body);
    } catch (error) {
      throw new StorageError(
        `Failed to write '${input.key}' to local storage`,
        'WRITE_FAILED',
        true,
        error,
      );
    }

    this.deps.logger.info('asset stored', {
      provider: this.name,
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
    try {
      return await readFile(this.pathFor(key));
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw new StorageError(`Failed to read '${key}'`, 'READ_FAILED', true, error);
    }
  }

  async delete(key: string): Promise<boolean> {
    try {
      await rm(this.pathFor(key));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw new StorageError(`Failed to delete '${key}'`, 'DELETE_FAILED', true, error);
    }
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}
