/**
 * Which URLs an outbound webhook may be sent to.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE WEBHOOK ADAPTER IS AN SSRF PRIMITIVE WITHOUT THIS
 *
 * `WebhookChannel.validate` accepted any `http:` or `https:` URL, and
 * `POST /v1/channels/test` lets an authenticated tenant user name one. That is a
 * request-forgery gadget with the service's own network position: cloud instance
 * metadata at `169.254.169.254`, anything on `localhost`, and every internal
 * service reachable from the pod are all one call away — and the response status
 * comes back to the caller, which is enough to enumerate.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE LAYERS, AND THE THIRD IS THE ONLY COMPLETE ONE
 *
 *  1. An optional per-tenant allow-list. When a tenant configures one, nothing
 *     outside it is reachable and the other two checks never matter.
 *  2. A literal-address check on the URL's host, which catches the direct cases.
 *  3. **Resolving the hostname and checking every address it resolves to.**
 *     This is the one that matters. A name under an attacker's control can
 *     point at `127.0.0.1`, and neither of the checks above would see it —
 *     `evil.test` is a perfectly ordinary hostname until it is resolved.
 *
 * REDIRECTS ARE DISABLED AT THE CALL SITE for the same reason: a public URL
 * that 302s to `169.254.169.254` defeats every pre-flight check, because the
 * check ran against the URL we were given and the request went somewhere else.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES NOT CLOSE
 *
 * DNS rebinding — a name that resolves to a public address here and a private
 * one when the HTTP client resolves it again moments later. Closing that means
 * pinning the resolved address into the connection, which is an agent-level
 * change to the HTTP stack. The allow-list is the answer for a tenant that
 * needs the guarantee, and this is recorded rather than papered over.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

export interface UrlGuardVerdict {
  ok: boolean;
  reason?: string;
}

/**
 * Ranges no outbound webhook may reach. Loopback, link-local (which is where
 * every major cloud puts its instance metadata), the RFC1918 private space,
 * carrier-grade NAT, and the IPv6 equivalents.
 */
function isBlockedV4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts as [number, number, number, number];

  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local — cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function isBlockedV6(address: string): boolean {
  const lower = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === '::1' || lower === '::') return true; // loopback, unspecified
  if (lower.startsWith('fe80')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
  if (lower.startsWith('ff')) return true; // multicast
  // IPv4-mapped (::ffff:127.0.0.1) — decide on the embedded address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1]) return isBlockedV4(mapped[1]);
  return false;
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedV4(address);
  if (family === 6) return isBlockedV6(address);
  return true; // not an address at all — refuse rather than guess
}

export interface UrlGuardOptions {
  /**
   * When set, the ONLY hosts this tenant may reach. A suffix match, so
   * `example.com` admits `hooks.example.com`; an exact host admits only itself.
   */
  allowedHosts?: string[];
  /**
   * Skip DNS resolution. For local development against `localhost`, and for
   * tests. Never true in a deployed configuration — the composition root
   * derives it from `NODE_ENV`.
   */
  allowPrivateAddresses?: boolean;
}

function hostAllowed(host: string, allowed: string[]): boolean {
  const lower = host.toLowerCase();
  return allowed.some((entry) => {
    const target = entry.toLowerCase().replace(/^\./, '');
    return lower === target || lower.endsWith(`.${target}`);
  });
}

/**
 * Is this URL safe to send a tenant's webhook to?
 *
 * Async because the honest answer needs DNS. A synchronous version could only
 * check literal addresses, which is the check an attacker skips by using a name.
 */
export async function assertSafeWebhookUrl(
  raw: string,
  options: UrlGuardOptions = {},
): Promise<UrlGuardVerdict> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `'${raw}' is not a valid url` };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: `unsupported webhook protocol '${url.protocol}'` };
  }

  // A tenant allow-list is absolute: inside it, nothing else is checked, because
  // an operator who named an internal host meant it.
  if (options.allowedHosts?.length) {
    return hostAllowed(url.hostname, options.allowedHosts)
      ? { ok: true }
      : {
          ok: false,
          reason: `'${url.hostname}' is not in this tenant's webhook allow-list`,
        };
  }

  if (options.allowPrivateAddresses) return { ok: true };

  // A literal address in the URL needs no lookup.
  if (isIP(url.hostname)) {
    return isBlockedAddress(url.hostname)
      ? { ok: false, reason: `'${url.hostname}' is a private or reserved address` }
      : { ok: true };
  }

  // The check that actually matters: what does this name resolve to?
  try {
    const resolved = await lookup(url.hostname, { all: true });
    if (resolved.length === 0) {
      return { ok: false, reason: `'${url.hostname}' does not resolve` };
    }
    // EVERY address, not the first. A name with one public and one private
    // record would otherwise be reachable half the time, and which half is the
    // resolver's choice.
    const blocked = resolved.find((r) => isBlockedAddress(r.address));
    if (blocked) {
      return {
        ok: false,
        reason: `'${url.hostname}' resolves to the private or reserved address ${blocked.address}`,
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: `'${url.hostname}' could not be resolved` };
  }
}
