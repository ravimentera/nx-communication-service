/**
 * The Channel port.
 *
 * This interface is the whole point of P3. Today delivery is a 6-case switch at
 * `notification-queue.ts:273-300` with a bespoke payload type per case
 * (`EmailNotificationPayload`, `SMSNotificationPayload`, ... six unions) and no
 * shared abstraction at all. Adding a channel meant editing the switch, the
 * union, and the queue.
 *
 * Here a channel is a thing that can validate and send. The queue calls
 * `registry.get(job.channel).send(...)` and knows nothing else.
 */

export const CHANNEL_TYPES = [
  'email',
  'sms',
  'slack',
  'push',
  'webhook',
  'in_app',
  'voice',
  'letter',
] as const;

export type ChannelType = (typeof CHANNEL_TYPES)[number];

/**
 * The source stores channel as uppercase text (`'EMAIL'`, `'IN_APP'`). Accept
 * either spelling so legacy rows and legacy callers keep working; the compat
 * shim in P8 leans on this.
 */
export function toChannelType(value: string): ChannelType | undefined {
  const normalized = value.trim().toLowerCase().replace(/-/g, '_');
  return (CHANNEL_TYPES as readonly string[]).includes(normalized)
    ? (normalized as ChannelType)
    : undefined;
}

/** One way of reaching a recipient. Mirrors an entry in `recipients.contact_points`. */
export interface ContactPoint {
  type: string;
  value: string;
  verified?: boolean;
  primary?: boolean;
}

export interface Attachment {
  fileName: string;
  url?: string;
  content?: Buffer;
  mimeType: string;
}

/** Content after templating and generation. Channel-agnostic by construction. */
export interface RenderedMessage {
  subject?: string;
  /** Plain text or markdown. Always present — every channel can carry text. */
  body: string;
  html?: string;
  attachments?: Attachment[];
  /** Channel-specific extras, e.g. Slack blocks or webhook method/headers. */
  metadata?: Record<string, unknown>;
}

export interface ChannelCredentials {
  tenantId: string;
  senderId?: string;
  /** Which level of the fallback chain produced this. Logged, and asserted in tests. */
  source: 'agent' | 'tenant' | 'env';
  /** Adapter-specific. The adapter validates what it needs and says so clearly. */
  values: Record<string, string>;
  /** The resolved sender address, number or channel. */
  from?: string;
}

export interface DeliveryError {
  code: string;
  message: string;
  /**
   * False means "do not retry this, ever" — a bad address, an unsubscribed
   * number, a malformed payload. The worker turns this into BullMQ's
   * UnrecoverableError so the job fails once instead of five times.
   */
  retryable: boolean;
}

export interface DeliveryResult {
  success: boolean;
  /**
   * The provider's own id for the message — SendGrid's `x-message-id`, Twilio's
   * `message.sid`. Stored on `messages.provider_message_id`, which is how
   * delivery webhooks find the row again. The source discards these.
   */
  providerMessageId?: string;
  error?: DeliveryError;
  /** Whether the adapter actually called the provider. False in dry-run. */
  dispatched?: boolean;
  raw?: unknown;
}

export interface ChannelCapabilities {
  subject: boolean;
  html: boolean;
  attachments: boolean;
  /** Body length ceiling, if the channel has one. */
  maxLength?: number;
  supportsDeliveryReceipts: boolean;
}

export type ValidationOutcome = { ok: true } | { ok: false; reason: string };

export interface Channel {
  readonly type: ChannelType;
  readonly capabilities: ChannelCapabilities;
  /** Pure, synchronous, no I/O — the dispatcher calls this before enqueueing. */
  validate(msg: RenderedMessage, to: ContactPoint): ValidationOutcome;
  send(
    msg: RenderedMessage,
    to: ContactPoint,
    creds: ChannelCredentials,
  ): Promise<DeliveryResult>;
}

export interface ChannelRegistry {
  register(channel: Channel): void;
  /** Throws NotFoundError for an unregistered channel. */
  get(type: ChannelType): Channel;
  has(type: ChannelType): boolean;
  list(): ChannelType[];
}
