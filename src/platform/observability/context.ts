/**
 * Request-scoped context propagation via AsyncLocalStorage.
 * Vendored from `@mentera/shared-libs/observability/context.ts`; medspaId is now
 * tenantId (§0.7).
 *
 * Every inbound HTTP request runs inside a context carrying the correlation id
 * plus tenant/user identity. The logger reads this store, so every line emitted
 * anywhere in the call tree is tagged without threading arguments through.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestContext {
  /** Correlation id — minted at the edge and forwarded as x-request-id. */
  requestId: string;
  tenantId?: string;
  subTenantId?: string;
  userId?: string;
  [key: string]: unknown;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with the given context active for its entire async call tree. */
export function runWithContext<T>(context: Partial<RequestContext>, fn: () => T): T {
  const ctx: RequestContext = { ...context, requestId: context.requestId || randomUUID() };
  return storage.run(ctx, fn);
}

/** The active request context, or undefined outside a request. */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/** Attach a value to the active context. No-op outside a request. */
export function setContextValue(key: string, value: unknown): void {
  const store = storage.getStore();
  if (store) store[key] = value;
}
