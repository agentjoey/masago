import type { MiddlewareFn } from 'grammy';
import type { AppConfig } from '../../config/index.js';
import type { AppContext } from '../bot.js';

export function createAuth(config: AppConfig): MiddlewareFn<AppContext> {
  return async (ctx, next) => {
    const telegramUserId = ctx.from?.id;
    if (telegramUserId !== config.telegram.allowedUserId) {
      ctx.logger.warn('unauthorized update ignored', {
        telegramUserId: telegramUserId ?? null,
      });
      return;
    }
    await next();
  };
}
