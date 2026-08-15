/**
 * Playbook CRUD, and installing a pack's content into a tenant.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * INSTALLING A PACK IS A DATA OPERATION, NOT A MIGRATION
 *
 * §0.10: the *mechanism* is generic and the *content* is not. Installing the
 * medspa pack writes rows — playbooks, triggers, templates, prompt packs,
 * approval policies — into tables that know nothing about medspas. It creates no
 * table and runs no DDL. That is the whole reason a gym can adopt this engine
 * without a schema change.
 *
 * IDEMPOTENT BY KEY, AND NON-DESTRUCTIVE BY DEFAULT
 *
 * Re-installing upserts on `(tenant_id, key)`. It does **not** clobber a
 * tenant's edits unless asked: a clinic that reworded its appointment reminder
 * must not lose that wording because someone redeployed. `overwriteCustomized`
 * is the explicit opt-out, and it says what it does.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Logger } from 'winston';

import type { Db } from '../../db/index.js';
import {
  approvalPolicies,
  packs as packsTable,
  playbooks,
  playbookTriggers,
  promptPacks,
  templates,
  tenantPacks,
} from '../../db/schema.js';
import type { TenantScope } from '../../platform/db/tenant-scope.js';
import { NotFoundError, ValidationError } from '../../platform/http/errors.js';
import type { LoadedPack, PackRegistry } from '../../packs/loader.js';
import type { PlaybookDefinition } from '../../packs/schema.js';

export interface InstallResult {
  packId: string;
  playbooks: number;
  triggers: number;
  templates: number;
  prompts: number;
  policies: number;
  skipped: string[];
}

export interface PlaybookRegistryDeps {
  db: Db;
  logger: Logger;
  packs: PackRegistry;
}

export class PlaybookRegistry {
  constructor(private readonly deps: PlaybookRegistryDeps) {}

  /**
   * Install (or re-install) a pack for one tenant.
   *
   * Order matters: policies and templates first, because playbooks reference
   * them by key and the reference has to resolve to something.
   */
  async installPack(
    scope: TenantScope,
    packId: string,
    options: { config?: Record<string, unknown>; overwriteCustomized?: boolean } = {},
  ): Promise<InstallResult> {
    const pack = this.deps.packs.get(packId);
    if (!pack) {
      throw new NotFoundError(`Pack '${packId}' is not loaded`, {
        available: this.deps.packs.list(),
      });
    }

    const result: InstallResult = {
      packId,
      playbooks: 0,
      triggers: 0,
      templates: 0,
      prompts: 0,
      policies: 0,
      skipped: [],
    };

    /**
     * The config the tenant will end up with — existing values with this call's
     * on top. Read before anything is written, because `requiredConfig` is
     * checked against the *result* of the install, not against this call's body:
     * an operator adding one setting to a pack that is already configured should
     * not have to resend all of them.
     */
    const existingConfig = await this.currentPackConfig(scope, packId);
    const mergedConfig = options.config
      ? deepMerge(existingConfig, options.config)
      : existingConfig;

    this.assertRequiredConfig(pack, mergedConfig);

    // The global catalogue row. Not tenant-owned — `packs` is one of the two
    // documented tables with no tenant_id (D19).
    await this.deps.db
      .insert(packsTable)
      .values({
        id: pack.id,
        name: pack.manifest?.name ?? pack.id,
        version: pack.manifest?.version ?? '0.0.0',
        description: pack.manifest?.description,
        manifest: (pack.manifest ?? {}) as Record<string, unknown>,
      })
      .onConflictDoUpdate({
        target: packsTable.id,
        set: {
          name: pack.manifest?.name ?? pack.id,
          version: pack.manifest?.version ?? '0.0.0',
          manifest: (pack.manifest ?? {}) as Record<string, unknown>,
          updatedAt: new Date(),
        },
      });

    result.policies = await this.installPolicies(scope, pack, options.overwriteCustomized);
    result.templates = await this.installTemplates(scope, pack, options.overwriteCustomized, result);
    result.prompts = await this.installPrompts(scope, pack);

    const counts = await this.installPlaybooks(scope, pack, options.overwriteCustomized, result);
    result.playbooks = counts.playbooks;
    result.triggers = counts.triggers;

    // Last: the install record. If anything above threw, the tenant is not
    // marked as having the pack, and a retry is a clean re-run.
    await this.deps.db
      .insert(tenantPacks)
      .values({
        tenantId: scope.tenantId,
        packId,
        config: mergedConfig,
        isActive: true,
      })
      .onConflictDoUpdate({
        target: [tenantPacks.tenantId, tenantPacks.packId],
        set: {
          isActive: true,
          // Merge, do not replace. This said so before P12 and did the opposite:
          // it assigned `options.config` wholesale, so re-installing with one
          // setting dropped every other one the operator had set. `config` holds
          // `emergencyContacts` and `slackChannels.staffAlerts`, and a playbook
          // whose `$config.` reference is unset produces a SKIPPED run — so the
          // symptom was a staff alert that silently stopped arriving, at the
          // next deploy rather than at the edit. See D95.
          config: mergedConfig,
          updatedAt: new Date(),
        },
      });

    this.deps.logger.info('pack installed', { tenantId: scope.tenantId, ...result });
    return result;
  }

  /** The config already recorded for this tenant and pack, or `{}`. */
  private async currentPackConfig(
    scope: TenantScope,
    packId: string,
  ): Promise<Record<string, unknown>> {
    const [row] = await this.deps.db
      .select({ config: tenantPacks.config })
      .from(tenantPacks)
      .where(and(eq(tenantPacks.tenantId, scope.tenantId), eq(tenantPacks.packId, packId)))
      .limit(1);
    return (row?.config ?? {}) as Record<string, unknown>;
  }

  /**
   * Every key in the manifest's `requiredConfig` must resolve to a value.
   *
   * `requiredConfig` has been in the pack schema and in the medspa manifest
   * since P7 and nothing has ever read it. Without this, installing the medspa
   * pack with no `emergencyContacts` succeeds, and the first sign of trouble is
   * an emergency notification producing a SKIPPED run — the failure mode
   * docs/PACKS.md says the mechanism exists to prevent, discovered at 3am rather
   * than at install.
   *
   * Refusing the install is the right end of that trade: a pack installed
   * without its destinations is not "partly working", it is a pack whose alerts
   * go nowhere.
   */
  private assertRequiredConfig(
    pack: { id: string; manifest?: { requiredConfig?: string[] } | null },
    config: Record<string, unknown>,
  ): void {
    const required = pack.manifest?.requiredConfig ?? [];
    if (required.length === 0) return;

    const missing = required.filter((path) => {
      const value = readPath(config, path);
      return value === undefined || value === null || value === '';
    });

    if (missing.length > 0) {
      throw new ValidationError(
        `Pack '${pack.id}' requires configuration that was not supplied: ${missing.join(', ')}`,
        { packId: pack.id, missing, required },
      );
    }
  }

  /**
   * Deactivate a pack for a tenant. **Content rows are left in place** — a
   * message sent last week references a playbook by id, and deleting it would
   * break every historical row's provenance. `is_active = false` is enough to
   * stop matching (the matcher joins on installed packs).
   */
  async uninstallPack(scope: TenantScope, packId: string): Promise<void> {
    await this.deps.db
      .update(tenantPacks)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(tenantPacks.tenantId, scope.tenantId), eq(tenantPacks.packId, packId)));

    await this.deps.db
      .update(playbooks)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(playbooks.tenantId, scope.tenantId), eq(playbooks.packId, packId)));

    this.deps.logger.info('pack deactivated', { tenantId: scope.tenantId, packId });
  }

  async listPlaybooks(scope: TenantScope, filter: { packId?: string; active?: boolean } = {}) {
    const clauses = [eq(playbooks.tenantId, scope.tenantId)];
    if (filter.packId) clauses.push(eq(playbooks.packId, filter.packId));
    if (filter.active !== undefined) clauses.push(eq(playbooks.isActive, filter.active));

    return this.deps.db
      .select()
      .from(playbooks)
      .where(and(...clauses));
  }

  async setActive(scope: TenantScope, key: string, isActive: boolean) {
    const [row] = await this.deps.db
      .update(playbooks)
      .set({ isActive, updatedAt: new Date() })
      .where(and(eq(playbooks.tenantId, scope.tenantId), eq(playbooks.key, key)))
      .returning();

    if (!row) throw new NotFoundError(`Playbook '${key}' not found for this tenant`);
    return row;
  }

  /** Author or edit a playbook directly. Pack-authored rows may be edited too. */
  async upsertPlaybook(scope: TenantScope, definition: PlaybookDefinition, packId?: string) {
    if (!definition.key) throw new ValidationError('A playbook needs a key');

    const policyId = definition.approvalPolicyKey
      ? await this.policyIdFor(scope, definition.approvalPolicyKey)
      : null;

    const [row] = await this.deps.db
      .insert(playbooks)
      .values({
        tenantId: scope.tenantId,
        subTenantId: scope.subTenantId,
        packId: packId ?? null,
        key: definition.key,
        name: definition.name,
        description: definition.description,
        isActive: definition.isActive ?? true,
        priority: definition.priority ?? 100,
        dataContract: definition.dataContract ?? {},
        contentSource: definition.contentSource,
        channelPlan: definition.channelPlan,
        approvalPolicyId: policyId,
        throttle: definition.throttle ?? {},
        metadata: definition.metadata ?? null,
      })
      .onConflictDoUpdate({
        target: [playbooks.tenantId, playbooks.key],
        set: {
          name: definition.name,
          description: definition.description,
          priority: definition.priority ?? 100,
          dataContract: definition.dataContract ?? {},
          contentSource: definition.contentSource,
          channelPlan: definition.channelPlan,
          approvalPolicyId: policyId,
          throttle: definition.throttle ?? {},
          updatedAt: new Date(),
        },
      })
      .returning();

    if (!row) throw new Error(`failed to upsert playbook '${definition.key}'`);
    await this.syncTriggers(scope, row.id, definition);
    return row;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async installPolicies(
    scope: TenantScope,
    pack: LoadedPack,
    overwrite = false,
  ): Promise<number> {
    let count = 0;
    for (const policy of pack.policies ?? []) {
      const existing = await this.deps.db
        .select({ id: approvalPolicies.id })
        .from(approvalPolicies)
        .where(
          and(eq(approvalPolicies.tenantId, scope.tenantId), eq(approvalPolicies.key, policy.key)),
        )
        .limit(1);

      if (existing.length > 0 && !overwrite) continue;

      await this.deps.db
        .insert(approvalPolicies)
        .values({
          tenantId: scope.tenantId,
          packId: pack.id,
          key: policy.key,
          name: policy.name,
          mode: policy.mode,
          confidenceThreshold:
            policy.confidenceThreshold === undefined ? null : String(policy.confidenceThreshold),
          sampleRate: policy.sampleRate === undefined ? null : String(policy.sampleRate),
          approverResolution: policy.approverResolution ?? { kind: 'agent' },
          rights: policy.rights ?? {},
          sla: policy.sla ?? {},
        })
        .onConflictDoNothing();
      count += 1;
    }
    return count;
  }

  private async installTemplates(
    scope: TenantScope,
    pack: LoadedPack,
    overwrite = false,
    result?: InstallResult,
  ): Promise<number> {
    let count = 0;
    for (const template of pack.templates ?? []) {
      const [existing] = await this.deps.db
        .select({ id: templates.id, packId: templates.packId })
        .from(templates)
        .where(and(eq(templates.tenantId, scope.tenantId), eq(templates.key, template.key)))
        .limit(1);

      if (existing && !overwrite) {
        // A tenant reworded this. Leave it alone and say so, rather than
        // reverting their copy on the next deploy.
        result?.skipped.push(`template:${template.key}`);
        continue;
      }

      if (existing) {
        await this.deps.db
          .update(templates)
          .set({
            name: template.name,
            subject: template.subject,
            content: template.content,
            format: template.format,
            channel: template.channel,
            category: template.category,
            updatedAt: new Date(),
          })
          .where(and(eq(templates.tenantId, scope.tenantId), eq(templates.id, existing.id)));
      } else {
        await this.deps.db.insert(templates).values({
          tenantId: scope.tenantId,
          subTenantId: scope.subTenantId,
          packId: pack.id,
          key: template.key,
          name: template.name,
          description: template.description,
          channel: template.channel,
          subject: template.subject,
          content: template.content,
          format: template.format,
          category: template.category,
        });
      }
      count += 1;
    }
    return count;
  }

  private async installPrompts(scope: TenantScope, pack: LoadedPack): Promise<number> {
    let count = 0;
    for (const [, prompt] of pack.prompts) {
      // `tenant_id` NULL means "pack default, shared by every tenant that
      // installed the pack" (D19) — prompts are not per-tenant edited, so the
      // shared row is written once and every tenant reads it.
      const existing = await this.deps.db
        .select({ id: promptPacks.id })
        .from(promptPacks)
        .where(and(isNull(promptPacks.tenantId), eq(promptPacks.key, prompt.key)))
        .limit(1);

      if (existing.length > 0) continue;

      await this.deps.db
        .insert(promptPacks)
        .values({
          tenantId: null,
          packId: pack.id,
          key: prompt.key,
          version: prompt.version,
          persona: prompt.persona,
          goal: prompt.goal,
          // `constraints` is a text column, not an array — the assembler joins
          // them into the system prompt, so one newline-delimited block is the
          // shape it reads back.
          constraints: prompt.constraints?.join('\n'),
          channelRules: prompt.channelRules ?? null,
          modelHints: prompt.modelHints ?? null,
        })
        .onConflictDoNothing();
      count += 1;
    }
    return count;
  }

  private async installPlaybooks(
    scope: TenantScope,
    pack: LoadedPack,
    overwrite = false,
    result?: InstallResult,
  ): Promise<{ playbooks: number; triggers: number }> {
    let playbookCount = 0;
    let triggerCount = 0;

    for (const definition of pack.playbooks ?? []) {
      const [existing] = await this.deps.db
        .select({ id: playbooks.id })
        .from(playbooks)
        .where(and(eq(playbooks.tenantId, scope.tenantId), eq(playbooks.key, definition.key)))
        .limit(1);

      if (existing && !overwrite) {
        result?.skipped.push(`playbook:${definition.key}`);
        continue;
      }

      const row = await this.upsertPlaybook(scope, definition, pack.id);
      playbookCount += 1;
      triggerCount += definition.triggers?.length ?? 0;
      void row;
    }

    return { playbooks: playbookCount, triggers: triggerCount };
  }

  /**
   * Triggers are replaced wholesale, not merged. A trigger is a matching rule
   * with no independent identity — merging would leave an old rule matching
   * events the pack no longer claims, which is worse than a brief window with
   * none.
   */
  private async syncTriggers(
    scope: TenantScope,
    playbookId: string,
    definition: PlaybookDefinition,
  ): Promise<void> {
    await this.deps.db
      .delete(playbookTriggers)
      .where(
        and(
          eq(playbookTriggers.tenantId, scope.tenantId),
          eq(playbookTriggers.playbookId, playbookId),
        ),
      );

    if (!definition.triggers?.length) return;

    await this.deps.db.insert(playbookTriggers).values(
      definition.triggers.map((trigger) => ({
        tenantId: scope.tenantId,
        playbookId,
        triggerType: trigger.type,
        matchRules: {
          ...(trigger.eventType ? { eventType: trigger.eventType } : {}),
          ...(trigger.eventTypeAliases?.length
            ? { eventTypeAliases: trigger.eventTypeAliases }
            : {}),
          ...(trigger.where ? { where: trigger.where } : {}),
        },
        scheduleCron: trigger.cron ?? null,
        isActive: true,
      })),
    );
  }

  /** Tenant policy first, then the pack default — same precedence as `load()`. */
  private async policyIdFor(scope: TenantScope, key: string): Promise<string | null> {
    const rows = await this.deps.db
      .select({ id: approvalPolicies.id, tenantId: approvalPolicies.tenantId })
      .from(approvalPolicies)
      .where(
        and(
          eq(approvalPolicies.key, key),
          or(eq(approvalPolicies.tenantId, scope.tenantId), isNull(approvalPolicies.tenantId)),
        ),
      );

    const chosen = rows.find((r) => r.tenantId === scope.tenantId) ?? rows[0];

    if (!chosen) {
      // A playbook naming a policy that does not exist would silently become
      // "no approval required", which for an AI-written message is the wrong
      // way to fail.
      throw new ValidationError(
        `Playbook references approval policy '${key}', which does not exist. Apply migration 0006, or install the pack that ships it, first.`,
      );
    }
    return chosen.id;
  }
}

/** Read a dotted path, e.g. `slackChannels.staffAlerts`. */
function readPath(source: Record<string, unknown>, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Recursive merge for plain objects; anything else replaces.
 *
 * Deep rather than shallow because pack config nests — `slackChannels` holds
 * `staffAlerts`, `emergencyAlerts` and `systemAlerts`, and a shallow merge of
 * `{slackChannels: {staffAlerts: '#new'}}` would drop the other two, which is
 * the same bug as the one being fixed, one level down.
 *
 * An array replaces rather than concatenating: `emergencyContacts` is a list of
 * who to wake up, and an operator sending a shorter list means to shorten it.
 */
function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = merged[key];
    merged[key] =
      isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Used by the v1 router to widen a bulk lookup. */
export async function playbooksByKeys(db: Db, scope: TenantScope, keys: string[]) {
  if (keys.length === 0) return [];
  return db
    .select()
    .from(playbooks)
    .where(and(eq(playbooks.tenantId, scope.tenantId), inArray(playbooks.key, keys)));
}
