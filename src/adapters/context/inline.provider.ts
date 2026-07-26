/**
 * The default context provider: the caller already supplied the data.
 *
 * This is the happy path, not a fallback. A consumer sends
 * `{ kind: 'inline', params: { … } }` with the event, the playbook validates it
 * against its `data_contract`, and the engine never calls anything. It is also
 * §0.10 tier 1 in code form — the mechanism by which a vertical's data reaches
 * a generic engine without the engine knowing anything about that vertical.
 */
import type {
  ContextObject,
  ContextProvider,
  ContextRef,
  ResolvedRecipient,
} from '../../ports/context-provider.js';

export class InlineContextProvider implements ContextProvider {
  readonly kind = 'inline';

  async fetch(ref: ContextRef): Promise<ContextObject> {
    return ref.params ?? {};
  }

  /**
   * Identity comes from the payload too. A caller that knows its own recipients
   * — which is most of them — never needs a lookup service.
   */
  async resolveRecipient(ref: ContextRef): Promise<ResolvedRecipient> {
    const params = ref.params ?? {};
    const recipient = (params.recipient ?? params) as Record<string, unknown>;

    return {
      displayName: asString(recipient.displayName ?? recipient.name),
      firstName: asString(recipient.firstName),
      lastName: asString(recipient.lastName),
      timezone: asString(recipient.timezone),
      locale: asString(recipient.locale),
      contactPoints: Array.isArray(recipient.contactPoints)
        ? (recipient.contactPoints as ResolvedRecipient['contactPoints'])
        : buildContactPoints(recipient),
      ...(ref.id ? { externalRef: { system: 'inline', id: ref.id } } : {}),
    };
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Accept the common shorthand of a bare `email` / `phone` on the object. */
function buildContactPoints(recipient: Record<string, unknown>): ResolvedRecipient['contactPoints'] {
  const points: NonNullable<ResolvedRecipient['contactPoints']> = [];
  const email = asString(recipient.email);
  const phone = asString(recipient.phone);
  if (email) points.push({ type: 'email', value: email, primary: true });
  if (phone) points.push({ type: 'phone', value: phone, primary: !email });
  return points.length > 0 ? points : undefined;
}
