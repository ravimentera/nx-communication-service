/**
 * The ONLY module permitted to read `process.env` (enforced by .eslintrc.cjs).
 *
 * P0 placeholder: just enough to boot the health endpoint. P1 replaces this with
 * the full zod-validated config object (server/db/redis/queue/auth/llm/channels/
 * storage/compliance/observability) that fails fast at boot on missing vars.
 */
export interface Config {
  server: {
    port: number;
    host: string;
    env: string;
    serviceName: string;
  };
}

export function loadConfig(): Config {
  return {
    server: {
      port: Number(process.env.PORT ?? 5007),
      host: process.env.HOST ?? '0.0.0.0',
      env: process.env.NODE_ENV ?? 'development',
      serviceName: process.env.SERVICE_NAME ?? 'outreach-server',
    },
  };
}
