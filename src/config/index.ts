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
  /**
   * The worker's throughput cap: `SEND_MAX_PER_INTERVAL` jobs started per
   * `SEND_LIMITER_INTERVAL_MS`.
   *
   * Without it one tenant's 50,000-recipient campaign fills the queue and every
   * other tenant's appointment reminder waits behind it. It also keeps the
   * service inside Twilio's and SendGrid's own rate limits, which is where an
   * uncapped burst turns into retries that make the burst worse.
   *
   * 100/second is well above any real steady-state volume here and well below
   * the providers' limits.
   */
  SEND_MAX_PER_INTERVAL: int(100),
  SEND_LIMITER_INTERVAL_MS: int(1_000),
  RETRY_LIMIT: int(5),
  URGENT_RETRY_LIMIT: int(10),

  // --- auth ---
  AUTH_MODE: z.enum(['gateway', 'apikey', 'jwt']).default('gateway'),
  /** `apikey` mode: requests per key per minute. 0 disables the limit. */
  API_KEY_RATE_LIMIT_PER_MINUTE: int(600),
  GATEWAY_ONLY: bool(true),

  // --- llm ---
  // `stub` is local-testing only: synthetic, deterministic content, no AWS
  // account. Enumerated rather than free text so a typo is a boot error
  // instead of a silent fall-through to Bedrock.
  LLM_PROVIDER: z.enum(['bedrock', 'stub']).default('bedrock'),
  /** `stub` only: make every call throw, to exercise the model-outage paths. */
  STUB_LLM_FAIL: bool(false),
  /** `stub` only: artificial latency in ms. */
  STUB_LLM_LATENCY_MS: int(0),
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

  // Inbound webhook verification (P8b). Distinct from the sending credentials
  // above: a provider signs its callbacks with a different secret than the one
  // it accepts sends on, and SendGrid's is a public key, not a shared secret.
  SENDGRID_WEBHOOK_PUBLIC_KEY: optionalString,
  SLACK_SIGNING_SECRET: optionalString,
  /**
   * The public origin the providers call back on, e.g.
   * `https://api.example.com/api/communication`. Twilio signs the **full URL**
   * it requested, so the value reconstructed behind a gateway and a load
   * balancer will not match unless it is stated. Leave unset to build it from
   * the request, which works only when nothing rewrites the path.
   */
  WEBHOOK_PUBLIC_URL: optionalString,
  /** Reject an unsigned callback. Default true — see webhooks/signature.ts. */
  WEBHOOK_REQUIRE_SIGNATURE: bool(true),

  // --- context (read only by adapters/context/mentera.provider.ts, P5) ---
  PATIENT_SERVICE_URL: optionalString,
  PROVIDER_SERVICE_URL: optionalString,
  CONTEXT_CACHE_TTL_S: int(300),

  // --- storage ---
  S3_MEMORY_BUCKET: optionalString,
  USE_LOCAL_STORAGE: bool(true),
  LOCAL_STORAGE_PATH: str('./memory-store'),
  /**
   * Origin the local adapter builds asset URLs from. The S3 adapter ignores it
   * unless `S3_PUBLIC_BASE_URL` is unset and the bucket is behind a CDN, in
   * which case set that instead. An asset URL is stored on the row, so changing
   * either value does not rewrite URLs already handed out.
   */
  ASSET_PUBLIC_BASE_URL: str('http://localhost:5007/assets'),
  S3_PUBLIC_BASE_URL: optionalString,
  S3_REGION: optionalString,
  /** Bytes. Rejected before the body is read into memory. */
  ASSET_MAX_BYTES: int(10 * 1024 * 1024),

  // --- credential encryption (P12) ---
  /**
   * `<keyId>:<base64 32 bytes>[,<keyId>:<...>]`. Unset means credentials stay
   * in the flat plaintext columns, which is the behaviour every phase before
   * P12 had — deliberately the default, because turning this on has to be
   * sequenced with `scripts/encrypt-credentials.mjs` and the parallel run.
   *
   *   openssl rand -base64 32
   */
  CREDENTIAL_ENCRYPTION_KEYS: optionalString,
  /** Which key new values seal under. Defaults to the only one when there is one. */
  CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: optionalString,

  // --- compliance ---
  UNSUBSCRIBE_BASE_URL: str('http://localhost:5007/unsubscribe'),
  DEFAULT_TIMEZONE: str('America/Los_Angeles'),
  /**
   * Who may scrape `/metrics`. A comma-separated list of CIDR-less IPs or
   * `*` for everyone.
   *
   * `/metrics` is mounted before auth — Prometheus carries no gateway headers —
   * and eight metric families carry a `tenant` label, so one unauthenticated
   * GET returns the tenant roster plus each one's send volume and model spend.
   * Defaulting to loopback means a pod scraped by a sidecar keeps working and
   * an internet-exposed one stops leaking; `*` restores the old behaviour for
   * a deployment whose network perimeter already handles it.
   */
  /**
   * How many reverse proxies sit in front of this service.
   *
   * Express `trust proxy` as a hop count rather than `true`: believing the
   * whole `X-Forwarded-For` chain lets any client prepend an address and defeat
   * every per-IP limit. 1 is a single load balancer, which is the deployment
   * this has; 0 disables the header entirely for a direct-to-pod setup.
   */
  /**
   * Origins allowed to call this service from a browser. Comma-separated, or
   * `*` for the old wide-open behaviour.
   *
   * `app.use(cors())` with no argument reflects any origin and was shipped that
   * way. Every route here is behind gateway auth, so this is defence in depth
   * rather than the only control — but the default should not be "any website
   * may make credentialed cross-origin calls to the outreach engine".
   *
   * Empty (the default) disables CORS headers entirely, which is right for a
   * service reached only through the gateway and never from a browser.
   */
  CORS_ALLOWED_ORIGINS: str(''),
  TRUST_PROXY_HOPS: int(1),
  METRICS_ALLOWED_IPS: str('127.0.0.1,::1'),
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
      trustProxyHops: env.TRUST_PROXY_HOPS,
      corsAllowedOrigins: env.CORS_ALLOWED_ORIGINS.split(',')
        .map((v) => v.trim())
        .filter(Boolean),
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
      sendMaxPerInterval: env.SEND_MAX_PER_INTERVAL,
      sendLimiterIntervalMs: env.SEND_LIMITER_INTERVAL_MS,
      maxConcurrency: env.MAX_CONCURRENCY,
      defaultAttempts: env.RETRY_LIMIT,
      urgentAttempts: env.URGENT_RETRY_LIMIT,
    },
    auth: {
      mode: env.AUTH_MODE,
      gatewayOnly: env.GATEWAY_ONLY,
      apiKeyRateLimitPerMinute: env.API_KEY_RATE_LIMIT_PER_MINUTE,
    },
    llm: {
      provider: env.LLM_PROVIDER,
      region: env.AWS_BEDROCK_REGION ?? env.AWS_REGION,
      defaultModel: env.AWS_BEDROCK_MODEL_ID,
      agentId: env.AWS_BEDROCK_AGENT_ID,
      agentAliasId: env.AWS_BEDROCK_AGENT_ALIAS_ID,
      timeoutMs: env.AI_REQUEST_TIMEOUT,
      maxRetries: env.AI_MAX_RETRIES,
      stubFail: env.STUB_LLM_FAIL,
      stubLatencyMs: env.STUB_LLM_LATENCY_MS,
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
    webhooks: {
      requireSignature: env.WEBHOOK_REQUIRE_SIGNATURE,
      publicUrl: env.WEBHOOK_PUBLIC_URL,
      sendgridPublicKey: env.SENDGRID_WEBHOOK_PUBLIC_KEY,
      slackSigningSecret: env.SLACK_SIGNING_SECRET,
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
      publicBaseUrl: env.ASSET_PUBLIC_BASE_URL,
      s3PublicBaseUrl: env.S3_PUBLIC_BASE_URL,
      s3Region: env.S3_REGION ?? env.AWS_REGION,
      maxBytes: env.ASSET_MAX_BYTES,
    },
    credentialEncryption: {
      keys: env.CREDENTIAL_ENCRYPTION_KEYS,
      activeKeyId: env.CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID,
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
      metricsAllowedIps: env.METRICS_ALLOWED_IPS.split(',')
        .map((v) => v.trim())
        .filter(Boolean),
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
