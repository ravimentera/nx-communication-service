/**
 * Who the message is from — the tenant and the sender, as the renderer and the
 * prompt assembler need them.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A FILE RATHER THAN FOUR LINES IN THE RUNTIME
 *
 * `emptyContext()` builds a `RenderContext` with every namespace present so a
 * template lookup never hits undefined. It is a SHAPE guarantee, and five
 * separate call sites read it as a POPULATED one: the playbook runtime, the
 * draft service, `/v1/content`, and the two compat routers all spread it and
 * filled in `recipient` and `context`, leaving `tenant: {id}` and `sender: {}`
 * exactly as they came.
 *
 * The consequences were not subtle. 23 of 27 medspa templates and all five
 * lead-gen templates interpolate `{{tenant.name}}`, so every SMS ended `— ` and
 * every email footer named nobody. The prompt packs embed "writing on behalf of
 * {{sender.displayName}} at {{tenant.name}}", so the model was told it was
 * writing on behalf of nobody at nowhere — and then asked not to invent facts.
 *
 * It also silently broke timezones. `{{formatDate}}` resolves zone and locale
 * from the recipient first and the tenant second (docs/PACKS.md); with the
 * tenant half never populated, the fallback was the server's clock — the exact
 * defect D34 introduced the helper to prevent.
 *
 * One resolver, used by all five, so the next call site cannot reintroduce it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SENDER IS THE AGENT CONFIG, AND THAT IS NOT AN ACCIDENT
 *
 * The engine does not own identity. What it has is `agent_channel_configs`,
 * which is where a sender's display name and from-address already live because
 * the delivery plane needs them. Reading identity from the same row the mail is
 * actually sent as means the name in the body and the name in the envelope
 * cannot drift apart.
 *
 * A sender with no config row is normal — a system-to-staff message has no
 * agent at all — and produces `sender: {}` rather than a failure.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { and, eq } from 'drizzle-orm';
import type { Logger } from 'winston';

import type { Db } from '../../db/index.js';
import { agentChannelConfigs, tenants } from '../../db/schema.js';
import type { TenantScope } from '../../platform/db/tenant-scope.js';
import { emptyContext, type RenderContext } from './render-context.js';

export interface IdentityResolverDeps {
  db: Db;
  logger: Logger;
}

export class IdentityResolver {
  constructor(private readonly deps: IdentityResolverDeps) {}

  /**
   * A `RenderContext` whose `tenant` and `sender` namespaces are filled in.
   * Spread it and add `recipient`, `context` and `message`.
   *
   * Never throws. A tenant row that is missing — which happens in tests and in
   * the window before a tenant is provisioned — degrades to the id alone, which
   * is what the caller had before this existed. Refusing to render a message
   * because its tenant's display name could not be read would be a worse
   * failure than the one this fixes.
   */
  async baseContext(scope: TenantScope, senderId?: string): Promise<RenderContext> {
    const base = emptyContext(scope.tenantId);

    const [tenant, sender] = await Promise.all([
      this.tenant(scope.tenantId),
      senderId ? this.sender(scope, senderId) : Promise.resolve(null),
    ]);

    return {
      ...base,
      tenant: { ...base.tenant, ...(tenant ?? {}) },
      sender: { ...base.sender, ...(sender ?? {}) },
    };
  }

  private async tenant(
    tenantId: string,
  ): Promise<{ name: string; timezone: string; locale: string } | null> {
    try {
      const [row] = await this.deps.db
        .select({ name: tenants.name, timezone: tenants.timezone, locale: tenants.locale })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      return row ?? null;
    } catch (error) {
      this.deps.logger.warn('could not load the tenant for the render context', {
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async sender(
    scope: TenantScope,
    senderId: string,
  ): Promise<{ id: string; displayName?: string; email?: string; timezone?: string } | null> {
    try {
      const [row] = await this.deps.db
        .select({
          name: agentChannelConfigs.name,
          emailFromName: agentChannelConfigs.emailFromName,
          emailFromAddress: agentChannelConfigs.emailFromAddress,
          timezone: agentChannelConfigs.timezone,
        })
        .from(agentChannelConfigs)
        .where(
          and(
            eq(agentChannelConfigs.tenantId, scope.tenantId),
            eq(agentChannelConfigs.senderId, senderId),
          ),
        )
        .limit(1);

      // The id is worth carrying even with no row: a template that addresses
      // the sender by id still resolves, and it distinguishes "no agent" from
      // "an agent we know nothing about".
      if (!row) return { id: senderId };

      return {
        id: senderId,
        // The from-name is what the recipient will see in their client, so it
        // wins over the internal config name when both are set.
        ...(row.emailFromName || row.name
          ? { displayName: row.emailFromName ?? row.name }
          : {}),
        ...(row.emailFromAddress ? { email: row.emailFromAddress } : {}),
        ...(row.timezone ? { timezone: row.timezone } : {}),
      };
    } catch (error) {
      this.deps.logger.warn('could not load the sender for the render context', {
        tenantId: scope.tenantId,
        senderId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { id: senderId };
    }
  }
}
