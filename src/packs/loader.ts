/**
 * Loads pack **content** from disk at boot.
 *
 * §0.10: a pack is data, not code and not tables. This reads a directory of
 * JSON and Handlebars files. Nothing here knows what any particular pack
 * contains — no branch on `packId`, no medspa-shaped field anywhere.
 *
 * ```
 * packs/<id>/
 * ├── manifest.json      identity, version, unlocked context providers
 * ├── aliases.json       legacy template variable names  (P4)
 * ├── compliance.json    lint rules                      (P5, wired P6)
 * ├── event-types.json   accepted trigger names + aliases
 * ├── policies/*.json    approval policies
 * ├── prompts/*.json     prompt packs                    (P4)
 * ├── templates/*.json   template bodies
 * └── playbooks/*.json   the playbooks themselves
 * ```
 *
 * **Everything is validated against Zod at load** (`packs/schema.ts`) with
 * `.strict()`, so a misspelled key is a startup error naming the file and the
 * path — not a playbook that silently never matches. A malformed file is
 * skipped and reported; it never takes the process down, because one bad pack
 * must not stop a tenant that does not use it from being served.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';
import type { Logger } from 'winston';

import type { LintRules } from '../engine/compliance/lint.js';
import type { AliasMap } from '../engine/content/render-context.js';
import type { PromptPack } from '../engine/content/prompt-assembler.js';
import {
  describeIssues,
  manifestSchema,
  playbookDefinitionSchema,
  policyDefinitionSchema,
  templateDefinitionSchema,
  type PackManifest,
  type PlaybookDefinition,
  type PolicyDefinition,
  type TemplateDefinition,
} from './schema.js';

/** `packs/<id>/event-types.json` — accepted trigger names and their aliases. */
export interface EventTypeCatalogue {
  /** Canonical name → other spellings that must keep working. */
  aliases?: Record<string, string[]>;
  known?: string[];
}

export interface LoadedPack {
  id: string;
  manifest?: PackManifest;
  aliases: AliasMap;
  prompts: Map<string, PromptPack>;
  /** From `packs/<id>/compliance.json`. Merged over the engine defaults at use. */
  compliance?: LintRules;
  policies?: PolicyDefinition[];
  templates?: TemplateDefinition[];
  playbooks?: PlaybookDefinition[];
  eventTypes?: EventTypeCatalogue;
  /** Files that failed validation, with the reason. Surfaced at boot. */
  errors: string[];
}

export interface PackRegistry {
  get(packId: string): LoadedPack | undefined;
  prompt(key: string): PromptPack | undefined;
  aliasMaps(): Record<string, AliasMap>;
  /** Lint rules for one pack, or every pack's rules when no id is given. */
  compliance(packId?: string): LintRules[];
  list(): string[];
  /** Every validation failure across every pack. Empty means all packs are clean. */
  errors(): string[];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** Keys beginning with `$` are comments, not aliases. */
function stripComments(raw: Record<string, string>): AliasMap {
  return Object.fromEntries(Object.entries(raw).filter(([key]) => !key.startsWith('$')));
}

/** Same `$comment` convention, for the rules file. */
function stripRuleComments(raw: Record<string, unknown>): LintRules {
  return Object.fromEntries(
    Object.entries(raw).filter(([key]) => !key.startsWith('$')),
  ) as LintRules;
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

    // Lint rules. A pack that ships none simply inherits the engine defaults;
    // a malformed file is logged and skipped rather than failing boot, because
    // the consequence of missing rules is "fewer warnings", not "wrong sends".
    let compliance: LintRules | undefined;
    const compliancePath = join(packPath, 'compliance.json');
    if (existsSync(compliancePath)) {
      try {
        compliance = stripRuleComments(readJson<Record<string, unknown>>(compliancePath));
      } catch (error) {
        logger.error('failed to load pack compliance rules', {
          packId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const errors: string[] = [];

    const manifest = readValidated(
      join(packPath, 'manifest.json'),
      manifestSchema,
      packId,
      errors,
    );
    const eventTypes = existsSync(join(packPath, 'event-types.json'))
      ? safeRead<EventTypeCatalogue>(join(packPath, 'event-types.json'), packId, errors)
      : undefined;

    const policies = readDirectory(join(packPath, 'policies'), policyDefinitionSchema, packId, errors);
    const templateDefs = readDirectory(
      join(packPath, 'templates'),
      templateDefinitionSchema,
      packId,
      errors,
    );
    const playbookDefs = readDirectory(
      join(packPath, 'playbooks'),
      playbookDefinitionSchema,
      packId,
      errors,
    );

    packs.set(packId, {
      id: packId,
      manifest,
      aliases,
      prompts,
      compliance,
      policies,
      templates: templateDefs,
      playbooks: playbookDefs,
      eventTypes,
      errors,
    });

    const summary = {
      packId,
      version: manifest?.version,
      aliases: Object.keys(aliases).length,
      prompts: prompts.size,
      complianceRules: compliance ? Object.keys(compliance).length : 0,
      policies: policies.length,
      templates: templateDefs.length,
      playbooks: playbookDefs.length,
    };

    if (errors.length > 0) {
      // Loud, and named. A pack file that failed validation is a config error
      // someone can fix in seconds if they are told which file and which field.
      logger.error('pack loaded WITH ERRORS — the affected content is not available', {
        ...summary,
        errors,
      });
    } else {
      logger.info('pack loaded', summary);
    }
  }

  return registry(packs, promptsByKey);
}

/**
 * Read and validate one file. Returns undefined and records why on failure.
 *
 * Generic over the SCHEMA, not over its type parameter: a schema with a
 * `.default()` has different input and output types, and inferring from the
 * input would leave defaulted fields optional downstream.
 */
function readValidated<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  packId: string,
  errors: string[],
): z.output<S> | undefined {
  if (!existsSync(path)) return undefined;

  const raw = safeRead<unknown>(path, packId, errors);
  if (raw === undefined) return undefined;

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    errors.push(`${path}: ${describeIssues(parsed.error)}`);
    return undefined;
  }
  return parsed.data;
}

function safeRead<T>(path: string, packId: string, errors: string[]): T | undefined {
  try {
    return readJson<T>(path);
  } catch (error) {
    errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    void packId;
    return undefined;
  }
}

/**
 * Every `*.json` in a directory, validated.
 *
 * One bad file does not discard its siblings — a typo in a single playbook
 * should cost that playbook, not the whole pack.
 */
function readDirectory<S extends z.ZodTypeAny>(
  dir: string,
  schema: S,
  packId: string,
  errors: string[],
): z.output<S>[] {
  if (!existsSync(dir)) return [];

  const items: z.output<S>[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const parsed = readValidated(join(dir, file), schema, packId, errors);
    if (parsed !== undefined) items.push(parsed);
  }
  return items;
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
    // With no pack id, every installed pack's rules — the composition root does
    // not know which pack a given draft belongs to, and a lint warning from the
    // wrong pack costs a human glance, not a blocked send.
    compliance: (packId) =>
      (packId ? [packs.get(packId)] : [...packs.values()])
        .map((pack) => pack?.compliance)
        .filter((rules): rules is LintRules => Boolean(rules)),
    list: () => [...packs.keys()].sort(),
    errors: () => [...packs.values()].flatMap((pack) => pack.errors),
  };
}
