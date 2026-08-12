import { Bot, type Context } from 'grammy';
import type { AppConfig } from '../config/index.js';
import type { Logger } from '../observability/index.js';
import { createAuth } from './middleware/auth.js';
import { createCorrelationId } from './middleware/correlationId.js';
import { createDedupe } from './middleware/dedupe.js';
import { createRoute } from './middleware/route.js';

export interface AppContext extends Context {
  correlationId: string;
  logger: Logger;
}

export interface BotDeps {
  config: AppConfig;
  logger: Logger;
  handleUpdate(ctx: AppContext): Promise<void>;
  recordUpdate(updateId: number, payload: unknown): Promise<boolean>;
}

export function createBot(deps: BotDeps): Bot<AppContext> {
  const bot = new Bot<AppContext>(deps.config.telegram.botToken);

  bot.catch((error) => {
    const ctx = error.ctx as Partial<AppContext>;
    const log = ctx.logger ?? deps.logger;
    log.error('update handling failed', {
      updateId: error.ctx.update?.update_id,
      error: error.error,
    });
  });

  bot.use(createCorrelationId(deps.logger));
  bot.use(createAuth(deps.config));
  bot.use(createDedupe(deps.recordUpdate));
  bot.use(createRoute(deps.handleUpdate));

  return bot;
}
