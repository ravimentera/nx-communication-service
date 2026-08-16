/**
 * Everything Mentera-specific from `context-fetcher.service.ts`, in one file,
 * behind the port.
 *
 * **This is the only module in the engine that may read PATIENT_SERVICE_URL or
 * PROVIDER_SERVICE_URL** (they arrive as injected config; §0.9 forbids reading
 * env anywhere but `src/config/`). The P5 exit criterion greps for exactly that.
 *
 * It is registered by the **medspa pack**, not by the composition root — see
 * `engine/context/registry.ts`. A tenant without that pack installed cannot
 * reach patient-service even by crafting a ContextRef.
 *
 * PARTIAL FAILURE IS THE POINT. The source fires three requests with
 * `Promise.allSettled` and reads `.value?.data?.data` only from the fulfilled
 * ones (`context-fetcher.service.ts:393-400`), so a missing health-insight
 * degrades the draft instead of failing it. That behaviour is preserved exactly:
 * demographics missing is a real problem, but an absent visit history must never
 * stop a message going out.
 */
import axios, { type AxiosRequestConfig } from 'axios';
import type { Logger } from 'winston';

import type { TenantScope } from '../../platform/db/tenant-scope.js';
import type {
  ContextObject,
  ContextProvider,
  ContextRef,
  ResolvedRecipient,
} from '../../ports/context-provider.js';

const REQUEST_TIMEOUT_MS = 5_000;

export interface MenteraContextConfig {
  patientServiceUrl?: string;
  providerServiceUrl?: string;
}

export interface MenteraContextDeps {
  config: MenteraContextConfig;
  logger: Logger;
  /** Injected for tests; defaults to axios.get. */
  get?: (url: string, config: AxiosRequestConfig) => Promise<{ data?: unknown }>;
}

export class MenteraContextProvider implements ContextProvider {
  readonly kind = 'mentera-patient';

  private readonly get: NonNullable<MenteraContextDeps['get']>;

  constructor(private readonly deps: MenteraContextDeps) {
    this.get = deps.get ?? ((url, config) => axios.get(url, config));
  }

  private get patients(): string | undefined {
    return this.deps.config.patientServiceUrl
      ? `${this.deps.config.patientServiceUrl}/api/patients`
      : undefined;
  }

  private get providers(): string | undefined {
    return this.deps.config.providerServiceUrl
      ? `${this.deps.config.providerServiceUrl}/api/providers`
      : undefined;
  }

  /**
   * Header forwarding. The source sends `x-medspa-id` and `Authorization`
   * (`:387-390`); `x-gateway-request` is added because the receiving services
   * gate on it, and relying on a bearer token alone is what makes this call
   * fragile when it is made from a worker rather than a request.
   *
   * **`x-medspa-id` and `x-location-id` stay here, and are not the aliases P12
   * dropped (D106).** These are *outbound*, to patient-service and
   * providers-service, whose own auth middleware reads the medspa spelling and
   * only that. Removing them to match this service's inbound protocol would
   * break every context lookup. The generic names go too, so the day those
   * services generalize, this needs no change.
   */
  private headers(scope: TenantScope, ref: ContextRef): Record<string, string> {
    const bearer = ref.params?.bearerToken;
    return {
      'x-gateway-request': 'true',
      'x-tenant-id': scope.tenantId,
      'x-medspa-id': scope.tenantId,
      ...(scope.subTenantId
        ? { 'x-sub-tenant-id': scope.subTenantId, 'x-location-id': scope.subTenantId }
        : {}),
      ...(typeof bearer === 'string' ? { Authorization: bearer } : {}),
    };
  }

  /** Mentera services wrap payloads as `{ data: { … } }`. */
  private unwrap(settled: PromiseSettledResult<{ data?: unknown }>): unknown {
    if (settled.status !== 'fulfilled') return null;
    const body = settled.value?.data as { data?: unknown } | undefined;
    return body?.data ?? null;
  }

  async fetch(ref: ContextRef, scope: TenantScope): Promise<ContextObject> {
    const patientId = ref.id;
    if (!patientId) return {};

    const base = this.patients;
    if (!base) {
      this.deps.logger.warn('mentera context provider has no PATIENT_SERVICE_URL configured');
      return {};
    }

    const headers = this.headers(scope, ref);
    const options = { headers, timeout: REQUEST_TIMEOUT_MS };

    const [demographics, visits, insights] = await Promise.allSettled([
      this.get(`${base}/${patientId}`, options),
      this.get(`${base}/medical/patients/${patientId}/visits`, options),
      this.get(`${base}/intelligence/patients/${patientId}/health-insights/latest`, options),
    ]);

    for (const [name, result] of [
      ['demographics', demographics],
      ['visits', visits],
      ['healthInsights', insights],
    ] as const) {
      if (result.status === 'rejected') {
        // Degrade, do not fail. A draft without visit history is still a draft.
        this.deps.logger.warn('mentera context call failed — continuing without it', {
          part: name,
          patientId,
          tenantId: scope.tenantId,
        });
      }
    }

    const senderId = ref.params?.senderId;
    const providerContext =
      typeof senderId === 'string' ? await this.fetchProvider(senderId, scope, ref) : {};

    return {
      recipient: this.unwrap(demographics),
      visits: this.unwrap(visits),
      healthInsights: this.unwrap(insights),
      ...providerContext,
    };
  }

  private async fetchProvider(
    providerId: string,
    scope: TenantScope,
    ref: ContextRef,
  ): Promise<ContextObject> {
    const base = this.providers;
    if (!base) return {};

    const options = { headers: this.headers(scope, ref), timeout: REQUEST_TIMEOUT_MS };
    const [profile, preferences] = await Promise.allSettled([
      this.get(`${base}/${providerId}`, options),
      this.get(`${base}/${providerId}/preferences/communication`, options),
    ]);

    return {
      sender: this.unwrap(profile),
      senderCommunicationPreferences: this.unwrap(preferences),
    };
  }

  /** Maps a patient record onto the engine's own recipient shape. */
  async resolveRecipient(ref: ContextRef, scope: TenantScope): Promise<ResolvedRecipient> {
    const patientId = ref.id;
    const base = this.patients;
    if (!patientId || !base) return {};

    const settled = await Promise.allSettled([
      this.get(`${base}/${patientId}`, {
        headers: this.headers(scope, ref),
        timeout: REQUEST_TIMEOUT_MS,
      }),
    ]);

    const record = this.unwrap(settled[0]) as Record<string, unknown> | null;
    if (!record) return {};

    const first = typeof record.firstName === 'string' ? record.firstName : undefined;
    const last = typeof record.lastName === 'string' ? record.lastName : undefined;
    const contactPoints: ResolvedRecipient['contactPoints'] = [];
    if (typeof record.email === 'string' && record.email) {
      contactPoints.push({ type: 'email', value: record.email, primary: true });
    }
    if (typeof record.phone === 'string' && record.phone) {
      contactPoints.push({ type: 'phone', value: record.phone, primary: contactPoints.length === 0 });
    }

    return {
      displayName: [first, last].filter(Boolean).join(' ') || undefined,
      firstName: first,
      lastName: last,
      timezone: typeof record.timezone === 'string' ? record.timezone : undefined,
      contactPoints: contactPoints.length > 0 ? contactPoints : undefined,
      externalRef: { system: 'mentera-patient', id: patientId },
    };
  }
}
