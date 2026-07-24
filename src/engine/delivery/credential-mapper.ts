/**
 * How one channel reads its credentials out of a config row.
 *
 * This exists so `CredentialResolver` contains no per-channel branching. An
 * earlier draft switched on `ChannelType` three times inside the resolver,
 * which reproduces exactly the coupling P3 exists to remove: adding a `voice`
 * channel in a later phase would mean editing a central file rather than adding
 * one. Each channel now owns its own mapping, registered alongside its adapter.
 *
 * A mapper returns `null` when it cannot produce a COMPLETE credential at that
 * level. Half a credential is worse than none — it fails at send time, far from
 * the cause.
 */
import type { AgentChannelConfig, TenantChannelConfig } from './channel-config.service.js';

export interface MappedCredential {
  values: Record<string, string>;
  from?: string;
}

/** Env-level fallback, injected from config — never read from process.env here. */
export interface EnvChannelCredentials {
  sendgrid: { apiKey?: string; fromEmail?: string; fromName?: string };
  smtp: { host?: string; port: number; user?: string; pass?: string; secure: boolean };
  twilio: { accountSid?: string; authToken?: string; phoneNumber?: string };
  slack: { botToken?: string; defaultChannel?: string };
}

export interface CredentialMapper {
  /**
   * Level 1: the agent supplies the `from`, the tenant supplies the secrets.
   * Both rows are passed because an agent has a phone number, not a Twilio
   * account — the exact split at `twilio.ts:44-56`.
   */
  fromAgent(
    agent: AgentChannelConfig,
    tenant: TenantChannelConfig | null,
  ): MappedCredential | null;

  /** Level 2: full credentials from the tenant row. */
  fromTenant(tenant: TenantChannelConfig): MappedCredential | null;

  /** Level 3: last-resort global fallback. */
  fromEnv(env: EnvChannelCredentials): MappedCredential | null;
}

export type CredentialMappers = ReadonlyMap<string, CredentialMapper>;
