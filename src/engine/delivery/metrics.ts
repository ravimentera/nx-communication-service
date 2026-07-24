/** Delivery-plane instruments, registered against the shared registry. */
import { metricsRegistry, promClient } from '../../platform/observability/metrics.js';

export const messagesSentTotal = new promClient.Counter({
  name: 'outreach_message_sent_total',
  help: 'Messages leaving the delivery plane by channel/tenant/status',
  labelNames: ['channel', 'tenant', 'status'] as const,
  registers: [metricsRegistry],
});

export const messageLatencySeconds = new promClient.Histogram({
  name: 'outreach_message_latency_seconds',
  help: 'Time from job pickup to provider acknowledgement',
  labelNames: ['channel', 'status'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [metricsRegistry],
});

export const queueDepth = new promClient.Gauge({
  name: 'outreach_queue_depth',
  help: 'Jobs waiting in a queue',
  labelNames: ['queue', 'state'] as const,
  registers: [metricsRegistry],
});
