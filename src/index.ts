import { createApp } from './app.js';
import { loadConfig } from './config/index.js';

const config = loadConfig();
const app = createApp(config);

const server = app.listen(config.server.port, config.server.host, () => {
  // eslint-disable-next-line no-console -- P1 replaces this with the winston service logger.
  console.warn(
    `[${config.server.serviceName}] listening on ${config.server.host}:${config.server.port} (${config.server.env})`,
  );
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
