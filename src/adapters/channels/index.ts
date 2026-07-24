/**
 * Channel registry factory. The composition root calls this once.
 *
 * §0.9: no module-scope singleton exports. The source has
 * `export const twilioSMSService = new TwilioSMSService()` and three more like
 * it, each reading `process.env` in its constructor at import time — which is
 * what makes per-tenant credentials impossible and the adapters untestable.
 */
import type { Logger } from 'winston';

import type { Db } from '../../db/index.js';
import { InMemoryChannelRegistry } from '../../engine/delivery/registry.js';
import type { ChannelRegistry } from '../../ports/channel.js';
import { InAppChannel } from './in-app.channel.js';
import { PushChannel } from './push.channel.js';
import { SendGridChannel } from './sendgrid.channel.js';
import { SlackChannel } from './slack.channel.js';
import { SmtpChannel } from './smtp.channel.js';
import { TwilioChannel } from './twilio.channel.js';
import { WebhookChannel } from './webhook.channel.js';

export interface ChannelRegistryOptions {
  logger: Logger;
  db: Db;
  dryRun: boolean;
  /**
   * Use SMTP for `email` instead of SendGrid. SendGrid is the default because
   * it is what the medspa tenant runs; SMTP is the documented fallback.
   */
  preferSmtp?: boolean;
  fcmApiKey?: string;
}

export function createChannelRegistry(options: ChannelRegistryOptions): ChannelRegistry {
  const { logger, db, dryRun } = options;
  const deps = { logger, dryRun };

  const registry = new InMemoryChannelRegistry();

  // Both claim type 'email'; whichever registers last wins, so register only one.
  registry.register(options.preferSmtp ? new SmtpChannel(deps) : new SendGridChannel(deps));
  registry.register(new TwilioChannel(deps));
  registry.register(new SlackChannel(deps));
  registry.register(new PushChannel({ ...deps, fcmApiKey: options.fcmApiKey }));
  registry.register(new WebhookChannel(deps));
  registry.register(new InAppChannel({ ...deps, db }));

  logger.info('channel registry built', { channels: registry.list(), dryRun });
  return registry;
}

export { InAppChannel } from './in-app.channel.js';
export { PushChannel } from './push.channel.js';
export { SendGridChannel } from './sendgrid.channel.js';
export { SlackChannel } from './slack.channel.js';
export { SmtpChannel } from './smtp.channel.js';
export { TwilioChannel } from './twilio.channel.js';
export { WebhookChannel } from './webhook.channel.js';
export type { ChannelDeps } from './base.js';
