/**
 * The context port.
 *
 * `services/data/context-fetcher.service.ts` (733L) builds
 * `${PATIENT_SERVICE_URL}/api/patients` and `${PROVIDER_SERVICE_URL}/api/providers`
 * in its constructor (`:70-71`) and makes eight HTTP calls into other Mentera
 * services to assemble the data a message is written from. That is the single
 * hardest coupling in the service: a vendor with no patient-service cannot draft
 * a message at all.
 *
 * Here context is a port with three implementations, and the **inline** one —
 * the caller already sent the data — is the default and the documented happy
 * path. Mentera access becomes one adapter that only the medspa pack registers.
 */
import type { TenantScope } from '../platform/db/tenant-scope.js';

export interface ContextRef {
  /** 'inline' | 'mentera-patient' | 'crm' | 'csv' | … */
  kind: string;
  id?: string;
  params?: Record<string, unknown>;
}

export type ContextObject = Record<string, unknown>;

export interface ResolvedRecipient {
  displayName?: string;
  firstName?: string;
  lastName?: string;
  timezone?: string;
  locale?: string;
  contactPoints?: Array<{ type: string; value: string; verified?: boolean; primary?: boolean }>;
  externalRef?: { system: string; id: string };
  attributes?: Record<string, unknown>;
}

export interface ContextProvider {
  readonly kind: string;
  fetch(ref: ContextRef, scope: TenantScope): Promise<ContextObject>;
  /** Resolve or refresh recipient identity — display name, contact points, timezone. */
  resolveRecipient?(ref: ContextRef, scope: TenantScope): Promise<ResolvedRecipient>;
}
