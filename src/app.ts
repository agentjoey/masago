import { config } from './config/index.js';
import { closeDb, db, telegramUpdatesRepo } from './db/index.js';
import { createLogger } from './observability/index.js';
import { createHandleUpdate } from './sessions/index.js';
import { createBot } from './telegram/index.js';
import pkg from '../package.json' with { type: 'json' };

const logger = createLogger({ level: config.logging.level });

export type ShutdownHook = () => void | Promise<void>;

const shutdownHooks: ShutdownHook[] = [];

export function onShutdown(hook: ShutdownHook): void {
  shutdownHooks.push(hook);
}

async function shutdown(signal: string): Promise<void> {
  logger.info('jp-coach shutting down', { signal });
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

const handleUpdate = createHandleUpdate({ config, executor: db, logger });

const bot = createBot({
  config,
  logger,
  handleUpdate,
  recordUpdate: async (updateId, payload) => {
    const result = await telegramUpdatesRepo.insertIfAbsent(db, updateId, payload);
    return result.inserted;
  },
});

onShutdown(() => bot.stop());
onShutdown(closeDb);

logger.info('jp-coach started', { version: pkg.version });

void bot.start({
  onStart: (me) => {
    logger.info('telegram bot connected', { username: me.username });
  },
});
