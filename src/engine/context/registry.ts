/**
 * Context provider registry, **scoped by the tenant's installed packs**.
 *
 * This is a security boundary, not a lookup table. `mentera.provider.ts` can
 * reach patient-service, so a tenant that has not installed the medspa pack must
 * not be able to resolve `kind: 'mentera-patient'` — otherwise any tenant could
 * craft a ContextRef and have the engine fetch another vertical's records on its
 * behalf, using the engine's own gateway credentials.
 *
 * Providers are therefore registered *against a pack id*, and resolution takes
 * the set of packs that tenant has installed. An unknown or unauthorised kind is
 * a `ValidationError` — never a silent fallback to Mentera.
 */
import type { TenantScope } from '../../platform/db/tenant-scope.js';
import { ForbiddenError, ValidationError } from '../../platform/http/errors.js';
import type {
  ContextObject,
  ContextProvider,
  ContextRef,
  ResolvedRecipient,
} from '../../ports/context-provider.js';

/** Providers registered under this id are available to every tenant. */
export const CORE_PACK = '__core__';

export interface TenantPackReader {
  /** Pack ids the tenant has installed. */
  installedPacks(tenantId: string): Promise<string[]>;
}

export class ContextRegistry {
  private readonly byKind = new Map<string, { provider: ContextProvider; packId: string }>();

  constructor(private readonly packs: TenantPackReader) {}

  /**
   * @param packId `CORE_PACK` for providers every tenant may use (inline), or a
   *               pack id for ones only its installers may use.
   */
  register(provider: ContextProvider, packId: string = CORE_PACK): void {
    this.byKind.set(provider.kind, { provider, packId });
  }

  list(): Array<{ kind: string; packId: string }> {
    return [...this.byKind.entries()].map(([kind, entry]) => ({ kind, packId: entry.packId }));
  }

  private async authorize(kind: string, tenantId: string): Promise<ContextProvider> {
    const entry = this.byKind.get(kind);
    if (!entry) {
      throw new ValidationError(`Unknown context provider '${kind}'`, {
        registered: [...this.byKind.keys()],
      });
    }
    if (entry.packId === CORE_PACK) return entry.provider;

    const installed = await this.packs.installedPacks(tenantId);
    if (!installed.includes(entry.packId)) {
      // Deliberately 403, not 404: the caller asked for something real that
      // they are not entitled to, and saying so is more useful than pretending
      // it does not exist to someone who can read the source anyway.
      throw new ForbiddenError(
        `Context provider '${kind}' requires the '${entry.packId}' pack, which this tenant has not installed`,
        { kind, requiredPack: entry.packId },
      );
    }
    return entry.provider;
  }

  async fetch(ref: ContextRef, scope: TenantScope): Promise<ContextObject> {
    const provider = await this.authorize(ref.kind, scope.tenantId);
    return provider.fetch(ref, scope);
  }

  async resolveRecipient(ref: ContextRef, scope: TenantScope): Promise<ResolvedRecipient> {
    const provider = await this.authorize(ref.kind, scope.tenantId);
    return provider.resolveRecipient ? provider.resolveRecipient(ref, scope) : {};
  }
}
