/**
 * Push adapter (FCM). Ports the send path of
 * `services/notification/push-notification.ts` (263L).
 *
 * The device-token registry that file carried (`registerDeviceToken` /
 * `getDeviceTokensForUser` over an in-process Map, plus load/save to disk) is
 * **not** ported. In-memory device tokens are lost on every restart, which makes
 * push delivery quietly unreliable. Tokens are contact points: they live on
 * `recipients.contact_points` with `type: 'push'`, and the dispatcher passes one
 * in like any other address.
 */
import axios from 'axios';

import type {
  Channel,
  ChannelCapabilities,
  ChannelCredentials,
  ChannelType,
  ContactPoint,
  DeliveryResult,
  RenderedMessage,
  ValidationOutcome,
} from '../../ports/channel.js';
import { dryRunResult, failure, retryableForStatus, type ChannelDeps } from './base.js';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS ADAPTER CANNOT WORK, AND SAYS SO RATHER THAN PRETENDING
 *
 * `https://fcm.googleapis.com/fcm/send` is the FCM **legacy** HTTP API, which
 * Google decommissioned in 2024. It is also unreachable: `fcmApiKey` has no
 * entry in the config schema, `secretlessMapper` returned `{}` for this
 * channel, and the composition root never passed one — so the credential this
 * needs has no source anywhere in the service.
 *
 * Every test of it asserts the DRY-RUN path, which is why none of that showed.
 *
 * Two honest options: implement FCM v1 with per-tenant service-account
 * credentials, or say it is not implemented. Ported code that calls a dead
 * endpoint with a credential nobody can supply is the third option, and it is
 * the one that costs somebody an afternoon at 3am.
 *
 * The adapter stays registered so `push` remains a valid channel in the data
 * model — `recipient_preferences.push_opt_in` and the enum both reference it —
 * and returns a permanent, named failure. `voice` and `letter` have never had
 * an adapter at all and now answer the same way through the registry rather
 * than a bare "no channel registered" 404.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const FCM_ENDPOINT = 'https://fcm.googleapis.com/fcm/send';
/** FCM rejects payloads over 4KB. */
const FCM_MAX_PAYLOAD_BYTES = 4096;

export interface PushChannelDeps extends ChannelDeps {
  fcmApiKey?: string;
  endpoint?: string;
}

export class PushChannel implements Channel {
  readonly type: ChannelType = 'push';
  readonly capabilities: ChannelCapabilities = {
    subject: true, // rendered as the notification title
    html: false,
    attachments: false,
    maxLength: FCM_MAX_PAYLOAD_BYTES,
    supportsDeliveryReceipts: false,
  };

  constructor(private readonly deps: PushChannelDeps) {}

  validate(msg: RenderedMessage, to: ContactPoint): ValidationOutcome {
    if (!to.value) return { ok: false, reason: 'no device token' };
    if (!msg.body) return { ok: false, reason: 'push requires a body' };
    const bytes = Buffer.byteLength(JSON.stringify({ ...msg }), 'utf8');
    if (bytes > FCM_MAX_PAYLOAD_BYTES) {
      return { ok: false, reason: `push payload is ${bytes} bytes, max ${FCM_MAX_PAYLOAD_BYTES}` };
    }
    return { ok: true };
  }

  async send(
    msg: RenderedMessage,
    to: ContactPoint,
    creds: ChannelCredentials,
  ): Promise<DeliveryResult> {
    if (this.deps.dryRun) return dryRunResult(this.deps.logger, this.type, to, msg, creds);

    const apiKey = creds.values.fcmApiKey ?? this.deps.fcmApiKey;
    if (!apiKey) {
      // Not retryable and not a configuration prompt a tenant can act on: there
      // is no supported way to configure this today. Naming the reason is the
      // whole value of the branch.
      return failure({
        code: 'PUSH_NOT_IMPLEMENTED',
        message:
          'Push is not implemented: the adapter targets the FCM legacy API, decommissioned in 2024, and no credential path exists. Implement FCM v1 with per-tenant service-account credentials, or send on another channel.',
        retryable: false,
      });
    }

    try {
      const response = await axios.post(
        this.deps.endpoint ?? FCM_ENDPOINT,
        {
          to: to.value,
          notification: {
            title: msg.subject ?? '',
            body: msg.body,
            ...(msg.metadata?.imageUrl ? { image: msg.metadata.imageUrl } : {}),
          },
          data: msg.metadata?.data ?? {},
        },
        {
          headers: { Authorization: `key=${apiKey}`, 'Content-Type': 'application/json' },
          timeout: 10_000,
          validateStatus: () => true,
        },
      );

      if (response.status >= 200 && response.status < 300 && response.data?.success !== 0) {
        return {
          success: true,
          dispatched: true,
          providerMessageId: String(response.data?.multicast_id ?? ''),
        };
      }

      // A dead token must never be retried — it will be dead next time too.
      const fcmError = response.data?.results?.[0]?.error as string | undefined;
      const deadToken =
        fcmError === 'NotRegistered' || fcmError === 'InvalidRegistration';

      return failure({
        code: `FCM_${fcmError ?? response.status}`,
        message: fcmError ?? `FCM returned ${response.status}`,
        retryable: deadToken ? false : retryableForStatus(response.status),
      });
    } catch (error) {
      return failure({
        code: 'FCM_NETWORK_ERROR',
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      });
    }
  }
}
