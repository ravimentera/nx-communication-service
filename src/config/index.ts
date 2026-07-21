/**
 * The ONLY module permitted to read `process.env` (enforced by .eslintrc.cjs).
 * Everything downstream takes configuration by injection from the composition
 * root, which is what makes the adapters testable and per-tenant-credential
 * capable in P3.
 *
 * Validated with zod and fail-fast: a missing DATABASE_URL kills the process at
 * boot with a readable message rather than at the first query.
 */
import 'dotenv/config';
import { z } from 'zod';

/** '', undefined and whitespace all mean "not set". */
const optionalString = z
  .string()
  .transform((v) => v.trim())
  .transform((v) => (v === '' ? undefined : v))
  .optional();

const bool = (defaultValue: boolean) =>
  optionalString.transform((v) => (v === undefined ? defaultValue : v.toLowerCase() === 'true'));

const int = (defaultValue: number) =>
  optionalString.transform((v, ctx) => {
    if (v === undefined) return defaultValue;
    const parsed = Number(v);
    if (!Number.isFinite(parsed)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `expected a number, got "${v}"` });
      return z.NEVER;
    }
    return parsed;
  });

const str = (defaultValue: string) =>
  optionalString.transform((v) => (v === undefined ? defaultValue : v));

const envSchema = z.object({
  // --- server (required: PORT, NODE_ENV) ---
  PORT: int(5007),
  HOST: str('0.0.0.0'),
  NODE_ENV: str('development'),
  SERVICE_NAME: str('outreach-server'),

  // --- db (required: DATABASE_URL) ---
  DATABASE_URL: z
    .string({ required_error: 'DATABASE_URL is required' })
    .min(1, 'DATABASE_URL is required'),
  DB_SSL: bool(false),
  PG_POOL_MAX: int(20),
  PG_POOL_MIN: int(2),
  PG_IDLE_TIMEOUT: int(30_000),
  PG_CONNECTION_TIMEOUT: int(5_000),

  // --- redis ---
  REDIS_URL: optionalString,
  REDIS_HOST: optionalString,
  REDIS_PORT: int(6379),
  REDIS_USERNAME: optionalString,
  REDIS_PASSWORD: optionalString,
  REDIS_DB: int(0),
  REDIS_KEY_PREFIX: str('outreach:'),
  SKIP_REDIS: bool(false),

  // --- queue ---
  SKIP_QUEUE: bool(false),
  DISABLE_NOTIFICATION_QUEUE: bool(false),
  EVENT_QUEUE_NAME: str('outreach-events'),
  EVENT_PROCESSING_CONCURRENCY: int(3),
  NOTIFICATION_CONCURRENCY: int(5),
  MAX_CONCURRENCY: int(10),
  RETRY_LIMIT: int(5),
  URGENT_RETRY_LIMIT: int(10),

  // --- auth ---
  AUTH_MODE: z.enum(['gateway', 'apikey', 'jwt']).default('gateway'),
  GATEWAY_ONLY: bool(true),

  // --- llm ---
  LLM_PROVIDER: str('bedrock'),
  AWS_REGION: str('us-east-1'),
  AWS_BEDROCK_REGION: optionalString,
  AWS_BEDROCK_MODEL_ID: str('amazon.nova-pro-v1:0'),
  AWS_BEDROCK_AGENT_ID: optionalString,
  AWS_BEDROCK_AGENT_ALIAS_ID: optionalString,
  AI_REQUEST_TIMEOUT: int(30_000),
  AI_MAX_RETRIES: int(2),

  // --- channels ---
  // Env credentials are the LAST-RESORT fallback; per-tenant credentials come
  // from the database (P3).
  CHANNEL_DRY_RUN: bool(true),
  SENDGRID_API_KEY: optionalString,
  DEFAULT_EMAIL_SENDER: optionalString,
  SENDGRID_FROM_NAME: optionalString,
  SMTP_HOST: optionalString,
  SMTP_PORT: int(587),
  SMTP_USER: optionalString,
  SMTP_PASS: optionalString,
  SMTP_SECURE: bool(false),
  TWILIO_ACCOUNT_SID: optionalString,
  TWILIO_AUTH_TOKEN: optionalString,
  TWILIO_PHONE_NUMBER: optionalString,
  SLACK_BOT_TOKEN: optionalString,
  SLACK_DEFAULT_CHANNEL: optionalString,

  // --- context (read only by adapters/context/mentera.provider.ts, P5) ---
  PATIENT_SERVICE_URL: optionalString,
  PROVIDER_SERVICE_URL: optionalString,
  CONTEXT_CACHE_TTL_S: int(300),

  // --- storage ---
  S3_MEMORY_BUCKET: optionalString,
  USE_LOCAL_STORAGE: bool(true),
  LOCAL_STORAGE_PATH: str('./memory-store'),

  // --- compliance ---
  UNSUBSCRIBE_BASE_URL: str('http://localhost:5007/unsubscribe'),
  DEFAULT_TIMEZONE: str('America/Los_Angeles'),
  ENFORCE_QUIET_HOURS: bool(true),
  RETENTION_DRY_RUN: bool(true),
  COMPLIANCE_SHADOW_MODE: bool(true),

  // --- observability ---
  LOG_LEVEL: str('info'),
  LOG_DIR: str('./logs'),
  LOG_TO_FILE: bool(false),

  // --- campaigns ---
  CAMPAIGN_GENERATE_CONCURRENCY: int(5),
});

export type Env = z.infer<typeof envSchema>;

function shape(env: Env) {
  return {
    server: {
      port: env.PORT,
      host: env.HOST,
      env: env.NODE_ENV,
      isProduction: env.NODE_ENV === 'production',
    },
    db: {
      url: env.DATABASE_URL,
      ssl: env.DB_SSL,
      poolMax: env.PG_POOL_MAX,
      poolMin: env.PG_POOL_MIN,
      idleTimeoutMs: env.PG_IDLE_TIMEOUT,
      connectionTimeoutMs: env.PG_CONNECTION_TIMEOUT,
    },
    redis: {
      url: env.REDIS_URL,
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      username: env.REDIS_USERNAME,
      password: env.REDIS_PASSWORD,
      db: env.REDIS_DB,
      keyPrefix: env.REDIS_KEY_PREFIX,
      skip: env.SKIP_REDIS,
    },
    queue: {
      skip: env.SKIP_QUEUE,
      disableNotificationQueue: env.DISABLE_NOTIFICATION_QUEUE,
      eventQueueName: env.EVENT_QUEUE_NAME,
      eventConcurrency: env.EVENT_PROCESSING_CONCURRENCY,
      notificationConcurrency: env.NOTIFICATION_CONCURRENCY,
      maxConcurrency: env.MAX_CONCURRENCY,
      defaultAttempts: env.RETRY_LIMIT,
      urgentAttempts: env.URGENT_RETRY_LIMIT,
    },
    auth: {
      mode: env.AUTH_MODE,
      gatewayOnly: env.GATEWAY_ONLY,
    },
    llm: {
      provider: env.LLM_PROVIDER,
      region: env.AWS_BEDROCK_REGION ?? env.AWS_REGION,
      defaultModel: env.AWS_BEDROCK_MODEL_ID,
      agentId: env.AWS_BEDROCK_AGENT_ID,
      agentAliasId: env.AWS_BEDROCK_AGENT_ALIAS_ID,
      timeoutMs: env.AI_REQUEST_TIMEOUT,
      maxRetries: env.AI_MAX_RETRIES,
    },
    channels: {
      dryRun: env.CHANNEL_DRY_RUN,
      sendgrid: {
        apiKey: env.SENDGRID_API_KEY,
        fromEmail: env.DEFAULT_EMAIL_SENDER,
        fromName: env.SENDGRID_FROM_NAME,
      },
      smtp: {
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
        secure: env.SMTP_SECURE,
      },
      twilio: {
        accountSid: env.TWILIO_ACCOUNT_SID,
        authToken: env.TWILIO_AUTH_TOKEN,
        phoneNumber: env.TWILIO_PHONE_NUMBER,
      },
      slack: {
        botToken: env.SLACK_BOT_TOKEN,
        defaultChannel: env.SLACK_DEFAULT_CHANNEL,
      },
    },
    context: {
      patientServiceUrl: env.PATIENT_SERVICE_URL,
      providerServiceUrl: env.PROVIDER_SERVICE_URL,
      cacheTtlSeconds: env.CONTEXT_CACHE_TTL_S,
    },
    storage: {
      s3Bucket: env.S3_MEMORY_BUCKET,
      useLocal: env.USE_LOCAL_STORAGE,
      localPath: env.LOCAL_STORAGE_PATH,
    },
    compliance: {
      unsubscribeBaseUrl: env.UNSUBSCRIBE_BASE_URL,
      defaultTimezone: env.DEFAULT_TIMEZONE,
      enforceQuietHours: env.ENFORCE_QUIET_HOURS,
      retentionDryRun: env.RETENTION_DRY_RUN,
      shadowMode: env.COMPLIANCE_SHADOW_MODE,
    },
    observability: {
      serviceName: env.SERVICE_NAME,
      logLevel: env.LOG_LEVEL,
      logDir: env.LOG_DIR,
      logToFile: env.LOG_TO_FILE,
    },
    campaigns: {
      generateConcurrency: env.CAMPAIGN_GENERATE_CONCURRENCY,
    },
  } as const;
}

export type Config = ReturnType<typeof shape>;

export class ConfigError extends Error {}

/**
 * Parse and validate the environment. Throws ConfigError listing every bad or
 * missing variable at once — not one per restart.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Invalid environment configuration:\n${problems}`);
  }
  return shape(parsed.data);
}
