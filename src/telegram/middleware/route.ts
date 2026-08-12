import type { MiddlewareFn } from 'grammy';
import type { AppContext } from '../bot.js';

export function createRoute(
  handleUpdate: (ctx: AppContext) => Promise<void>,
): MiddlewareFn<AppContext> {
  return async (ctx) => {
    await handleUpdate(ctx);
  };
}
