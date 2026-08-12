import { config } from './config/index.js';
import { createLogger } from './observability/index.js';
import pkg from '../package.json' with { type: 'json' };

const logger = createLogger({ level: config.logging.level });

logger.info('jp-coach started', { version: pkg.version });

const keepAlive = setInterval(() => undefined, 2_147_483_647);

export type ShutdownHook = () => void | Promise<void>;

const shutdownHooks: ShutdownHook[] = [];

export function onShutdown(hook: ShutdownHook): void {
  shutdownHooks.push(hook);
}

async function shutdown(signal: string): Promise<void> {
  logger.info('jp-coach shutting down', { signal });
  clearInterval(keepAlive);
  for (const hook of shutdownHooks) {
    try {
      await hook();
    } catch (error) {
      logger.error('shutdown hook failed', { error });
    }
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
