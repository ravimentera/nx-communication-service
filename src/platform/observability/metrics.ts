/**
 * Prometheus registry + core HTTP instruments.
 * Vendored from `@mentera/shared-libs/observability/metrics.ts`.
 *
 * NOTE ON METRIC NAMES. EXTRACTION_PLAN P1 says to rename the prefix
 * `tera_*` -> `outreach_*`. There is no `tera_` prefix in the source: the
 * instruments are the OpenMetrics-standard `http_request_duration_seconds`,
 * `http_requests_total`, `http_requests_in_flight`, and service identity is
 * carried by an explicit `service` label. Renaming standard names would break
 * every shared dashboard and recording rule for no gain, so the names are kept
 * and the `service` label is `outreach-server`. What P10 actually needs is a new
 * SCRAPE JOB in observability/prometheus/prometheus.yml, not a metric rename.
 */
import client from 'prom-client';

export const metricsRegistry = new client.Registry();

/** Re-exported so consumers define custom instruments against the same lib. */
export { client as promClient };

let defaultMetricsStarted = false;

/**
 * Start process-level collection (CPU, memory, event loop lag, GC).
 * Safe to call more than once — only the first call takes effect.
 */
export function initMetrics(): void {
  if (defaultMetricsStarted) return;
  defaultMetricsStarted = true;
  client.collectDefaultMetrics({ register: metricsRegistry });
}

const durationBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency by service/method/route/status',
  labelNames: ['service', 'method', 'route', 'status_code'] as const,
  buckets: durationBuckets,
  registers: [metricsRegistry],
});

export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests by service/method/route/status',
  labelNames: ['service', 'method', 'route', 'status_code'] as const,
  registers: [metricsRegistry],
});

export const httpRequestsInFlight = new client.Gauge({
  name: 'http_requests_in_flight',
  help: 'HTTP requests currently being handled',
  labelNames: ['service'] as const,
  registers: [metricsRegistry],
});

/**
 * Minimal structural response type: importing express's Response here would
 * make this handler nominally incompatible with consumers pinning a different
 * @types/express (ParsedQs/ParamsDictionary drift). Kept from the source.
 */
interface MetricsHandlerResponse {
  set(field: string, value: string): unknown;
  status(code: number): { end(body?: string): unknown };
  end(body?: string): unknown;
}

/** Express handler for GET /metrics (Prometheus exposition format). */
export async function metricsHandler(
  _req: unknown,
  res: MetricsHandlerResponse,
): Promise<void> {
  try {
    res.set('Content-Type', metricsRegistry.contentType);
    res.end(await metricsRegistry.metrics());
  } catch (err) {
    res.status(500).end(err instanceof Error ? err.message : 'metrics collection failed');
  }
}
