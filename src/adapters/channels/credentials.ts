/**
 * Per-channel credential mappers. Each one lives with its adapter's knowledge
 * of what that provider needs, so the resolver stays generic.
 */
import type {
  CredentialMapper,
  CredentialMappers,
  MappedCredential,
} from '../../engine/delivery/credential-mapper.js';
import type { ChannelType } from '../../ports/channel.js';

const twilioMapper: CredentialMapper = {
  fromAgent(agent, tenant) {
    if (!agent.twilioEnabled || !agent.twilioPhoneNumber) return null;
    // The agent owns the number; the account still belongs to the tenant.
    if (!tenant?.twilioAccountSid || !tenant.twilioAuthToken) return null;
    return {
      values: { accountSid: tenant.twilioAccountSid, authToken: tenant.twilioAuthToken },
      from: agent.twilioPhoneNumber,
    };
  },
  fromTenant(tenant) {
    if (!tenant.twilioEnabled || !tenant.twilioAccountSid || !tenant.twilioAuthToken) return null;
    return {
      values: { accountSid: tenant.twilioAccountSid, authToken: tenant.twilioAuthToken },
      from: tenant.twilioPhoneNumber ?? undefined,
    };
  },
  fromEnv(env) {
    const { accountSid, authToken, phoneNumber } = env.twilio;
    if (!accountSid || !authToken) return null;
    return { values: { accountSid, authToken }, from: phoneNumber };
  },
};

const emailMapper: CredentialMapper = {
  fromAgent(agent, tenant) {
    if (!agent.emailEnabled || !agent.emailFromAddress) return null;
    if (!tenant?.sendgridApiKey) return null;
    return {
      values: {
        apiKey: tenant.sendgridApiKey,
        fromName: agent.emailFromName ?? tenant.sendgridFromName ?? '',
      },
      from: agent.emailFromAddress,
    };
  },
  fromTenant(tenant) {
    if (!tenant.sendgridEnabled || !tenant.sendgridApiKey) return null;
    return {
      values: { apiKey: tenant.sendgridApiKey, fromName: tenant.sendgridFromName ?? '' },
      from: tenant.sendgridFromEmail ?? undefined,
    };
  },
  fromEnv(env): MappedCredential | null {
    const { apiKey, fromEmail, fromName } = env.sendgrid;
    if (apiKey) return { values: { apiKey, fromName: fromName ?? '' }, from: fromEmail };

    // SMTP is the documented fallback when SendGrid is absent.
    const { host, port, user, pass, secure } = env.smtp;
    if (!host) return null;
    return {
      values: {
        transport: 'smtp',
        host,
        port: String(port),
        user: user ?? '',
        pass: pass ?? '',
        secure: String(secure),
      },
      from: fromEmail,
    };
  },
};

const slackMapper: CredentialMapper = {
  fromAgent(agent, tenant) {
    if (!agent.slackEnabled || !agent.slackUserId) return null;
    if (!tenant?.slackBotToken) return null;
    return { values: { botToken: tenant.slackBotToken }, from: agent.slackUserId };
  },
  fromTenant(tenant) {
    if (!tenant.slackEnabled || !tenant.slackBotToken) return null;
    return {
      values: { botToken: tenant.slackBotToken },
      from: tenant.slackDefaultChannel ?? undefined,
    };
  },
  fromEnv(env) {
    const { botToken, defaultChannel } = env.slack;
    if (!botToken) return null;
    return { values: { botToken }, from: defaultChannel };
  },
};

/**
 * push / in_app carry no shared secret: push targets a device token, in_app
 * writes to our own table. They resolve trivially so the dispatcher can treat
 * every channel alike.
 */
const secretlessMapper: CredentialMapper = {
  fromAgent: () => null,
  fromTenant: () => null,
  fromEnv: () => ({ values: {} }),
};

/**
 * Webhook. It was in the secretless group, which is how its signing secret came
 * to ride on `msg.metadata.secret` — in the message, therefore in the BullMQ job
 * payload, therefore in Redis in plaintext for the queue's retention window.
 *
 * There is no env-level fallback and no agent level. A signing key is a
 * statement about one tenant's relationship with one endpoint; a global one
 * would let every tenant forge every other tenant's signatures.
 *
 * `values` also carries the allow-list, because the resolver is the one thing
 * the adapter is already handed and threading a second lookup through the
 * dispatcher for it would be a second way to reach the same row.
 */
const webhookMapper: CredentialMapper = {
  fromAgent: () => null,
  fromTenant: (tenant) => ({
    values: {
      ...(tenant.webhookSigningSecret ? { signingSecret: tenant.webhookSigningSecret } : {}),
      ...(tenant.webhookAllowedHosts?.length
        ? { allowedHosts: tenant.webhookAllowedHosts.join(',') }
        : {}),
    },
  }),
  // An unconfigured tenant still sends webhooks; they are simply unsigned, and
  // the URL guard's default rules apply. Returning null here would make the
  // dispatcher refuse the channel outright, which is a bigger change than the
  // defect being fixed.
  fromEnv: () => ({ values: {} }),
};

export function createCredentialMappers(): CredentialMappers {
  return new Map<ChannelType, CredentialMapper>([
    ['sms', twilioMapper],
    ['email', emailMapper],
    ['slack', slackMapper],
    ['push', secretlessMapper],
    ['webhook', webhookMapper],
    ['in_app', secretlessMapper],
  ]);
}
