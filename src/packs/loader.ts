/**
 * Loads pack **content** from disk at boot: alias maps and prompt packs.
 *
 * §0.10: a pack is data, not code and not tables. This reads
 * `packs/<id>/aliases.json` and `packs/<id>/prompts/*.json`. Nothing here knows
 * what any particular pack contains.
 *
 * P7 extends this with playbooks, templates and policies, and adds the
 * `tenant_packs` install path. P4 needs only the two content pieces.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Logger } from 'winston';

import type { AliasMap } from '../engine/content/render-context.js';
import type { PromptPack } from '../engine/content/prompt-assembler.js';

export interface LoadedPack {
  id: string;
  aliases: AliasMap;
  prompts: Map<string, PromptPack>;
}

export interface PackRegistry {
  get(packId: string): LoadedPack | undefined;
  prompt(key: string): PromptPack | undefined;
  aliasMaps(): Record<string, AliasMap>;
  list(): string[];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** Keys beginning with `$` are comments, not aliases. */
function stripComments(raw: Record<string, string>): AliasMap {
  return Object.fromEntries(Object.entries(raw).filter(([key]) => !key.startsWith('$')));
}

export function loadPacks(packsDir: string, logger: Logger): PackRegistry {
  const packs = new Map<string, LoadedPack>();
  const promptsByKey = new Map<string, PromptPack>();

  if (!existsSync(packsDir)) {
    logger.warn('no packs directory — running with no pack content', { packsDir });
    return registry(packs, promptsByKey);
  }

  for (const entry of readdirSync(packsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packId = entry.name;
    const packPath = join(packsDir, packId);

    let aliases: AliasMap = {};
    const aliasPath = join(packPath, 'aliases.json');
    if (existsSync(aliasPath)) {
      try {
        aliases = stripComments(readJson<Record<string, string>>(aliasPath));
      } catch (error) {
        logger.error('failed to load pack aliases', {
          packId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const prompts = new Map<string, PromptPack>();
    const promptsPath = join(packPath, 'prompts');
    if (existsSync(promptsPath)) {
      for (const file of readdirSync(promptsPath).filter((f) => f.endsWith('.json'))) {
        try {
          const pack = readJson<PromptPack>(join(promptsPath, file));
          if (!pack.key) {
            logger.error('prompt pack has no key — skipped', { packId, file });
            continue;
          }
          prompts.set(pack.key, pack);
          promptsByKey.set(pack.key, pack);
        } catch (error) {
          logger.error('failed to load prompt pack', {
            packId,
            file,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    packs.set(packId, { id: packId, aliases, prompts });
    logger.info('pack loaded', {
      packId,
      aliases: Object.keys(aliases).length,
      prompts: prompts.size,
    });
  }

  return registry(packs, promptsByKey);
}

function registry(
  packs: Map<string, LoadedPack>,
  promptsByKey: Map<string, PromptPack>,
): PackRegistry {
  return {
    get: (packId) => packs.get(packId),
    prompt: (key) => promptsByKey.get(key),
    aliasMaps: () =>
      Object.fromEntries([...packs.entries()].map(([id, pack]) => [id, pack.aliases])),
    list: () => [...packs.keys()].sort(),
  };
}
