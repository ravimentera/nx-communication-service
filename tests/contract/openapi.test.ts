/**
 * `docs/api/openapi.yaml` describes the routes the service actually registers.
 *
 * An API document that drifts is worse than none: a consumer generates a client
 * from it and gets 404s for endpoints that were renamed, or misses ones that
 * were added. This walks the live Express router stack and compares.
 *
 * **The comparison is deliberately one-directional on `/v1`.** Every registered
 * `/v1` route must be documented, because an undocumented endpoint is invisible
 * to a consumer. The reverse — a documented path with no route — is also caught,
 * because that is the shape a rename leaves behind.
 *
 * The legacy compat surface is excluded by design: it is inventoried in the
 * extraction plan's Appendix A and deleted in P12, and documenting it would give
 * it a life it is not meant to have.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { startHarness, type Harness } from './legacy/harness.js';

let h: Harness;

/** Paths the document covers on purpose, outside `/v1`. */
const NON_V1_DOCUMENTED = new Set([
  '/mcp/tools',
  '/mcp/tools/{toolName}',
  '/mcp/bedrock',
  '/mcp/health',
  '/unsubscribe/{token}',
  '/health',
  '/health/detailed',
]);

/** Express `:param` → OpenAPI `{param}`. */
function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/**
 * Walk the router stack. Express does not expose a route table, so this reads
 * the layer regexes — brittle in general, but pinned to one Express major and
 * asserted by this suite's own results.
 */
function registeredRoutes(app: Harness['app']): Set<string> {
  const found = new Set<string>();

  const walk = (stack: unknown[], prefix: string): void => {
    for (const raw of stack) {
      const layer = raw as {
        route?: { path: string; methods: Record<string, boolean> };
        name?: string;
        handle?: { stack?: unknown[] };
        regexp?: RegExp;
      };

      if (layer.route) {
        // A router's own `/` is the mount point itself, not `/health/`.
        const routePath =
          layer.route.path === '/' && prefix ? prefix : prefix + layer.route.path;
        for (const method of Object.keys(layer.route.methods)) {
          if (method === '_all') continue;
          found.add(`${method.toUpperCase()} ${toOpenApiPath(routePath)}`);
        }
        continue;
      }

      if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack, prefix + mountPath(layer.regexp));
      }
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  walk(((app as any)._router ?? (app as any).router).stack as unknown[], '');
  return found;
}

/** Recover a mount prefix from the layer regexp Express compiles it into. */
function mountPath(regexp: RegExp | undefined): string {
  if (!regexp) return '';
  const source = regexp.source;
  if (source === '^\\/?(?=\\/|$)') return '';
  const match = /^\^\\\/(.*?)\\\/\?\(\?=\\\/\|\$\)$/.exec(source);
  if (!match) return '';
  return `/${match[1]!.replace(/\\\//g, '/').replace(/\\\./g, '.')}`;
}

beforeAll(async () => {
  h = await startHarness();
}, 300_000);

afterAll(async () => {
  await h?.stop();
});

describe('openapi.yaml', () => {
  const spec = readFileSync(join(process.cwd(), 'docs/api/openapi.yaml'), 'utf8');

  /** Path keys, read out of the YAML without pulling in a parser. */
  const documentedPaths = new Set(
    [...spec.matchAll(/^ {2}(\/[^\s:]*):\s*$/gm)].map((m) => m[1]!),
  );

  it('documents every registered /v1 route', () => {
    const registered = [...registeredRoutes(h.app)]
      .filter((r) => r.includes(' /v1/'))
      .map((r) => r.split(' ')[1]!);

    const missing = [...new Set(registered)].filter((p) => !documentedPaths.has(p)).sort();
    expect(missing).toEqual([]);
  });

  it('documents no /v1 path the service does not serve', () => {
    // The shape a rename leaves behind: the document keeps the old path and a
    // generated client 404s on it.
    const registered = new Set(
      [...registeredRoutes(h.app)].map((r) => r.split(' ')[1]!),
    );
    const phantom = [...documentedPaths]
      .filter((p) => p.startsWith('/v1/'))
      .filter((p) => !registered.has(p))
      .sort();
    expect(phantom).toEqual([]);
  });

  it('documents the non-/v1 paths it claims to', () => {
    const registered = new Set(
      [...registeredRoutes(h.app)].map((r) => r.split(' ')[1]!),
    );
    for (const path of NON_V1_DOCUMENTED) {
      expect({ path, registered: registered.has(path) }).toEqual({ path, registered: true });
    }
  });

  it('does not document the compat surface', () => {
    // Appendix A inventories it; P12 deletes it. A consumer finding it here
    // would reasonably build against it.
    const legacyPrefixes = ['/email', '/sms', '/slack', '/config', '/approvals/', '/communications'];
    for (const prefix of legacyPrefixes) {
      const leaked = [...documentedPaths].filter((p) => p.startsWith(prefix));
      expect({ prefix, leaked }).toEqual({ prefix, leaked: [] });
    }
  });

  it('gives every operation a unique operationId', () => {
    const ids = [...spec.matchAll(/^\s+operationId: (\S+)$/gm)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThan(50);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
