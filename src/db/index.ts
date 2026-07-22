/**
 * The database handle, narrowed to this service's schema.
 *
 * P1 left `Db` generic because the schema did not exist yet. It does now.
 */
import type { Db as PlatformDb, DbConfig, DbHandle } from '../platform/db/client.js';
import { createDb as createPlatformDb } from '../platform/db/client.js';
import type { Logger } from 'winston';

import * as schema from './schema.js';

export type Schema = typeof schema;
export type Db = PlatformDb<Schema>;

export function createDb(cfg: DbConfig, logger?: Logger): DbHandle<Schema> {
  return createPlatformDb<Schema>(cfg, { schema, logger });
}

export { schema };
export type { DbConfig };
