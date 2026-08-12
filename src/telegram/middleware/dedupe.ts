import type { MiddlewareFn } from 'grammy';
import type { AppContext } from '../bot.js';

export type RecordUpdate = (updateId: number, payload: unknown) => Promise<boolean>;

export function createDedupe(recordUpdate: RecordUpdate): MiddlewareFn<AppContext> {
  return async (ctx, next) => {
    let inserted: boolean;
    try {
      inserted = await recordUpdate(ctx.update.update_id, ctx.update);
    } catch (error) {
      ctx.logger.error('update dedupe failed, refusing to process', { error });
      return;
    }
    if (!inserted) {
      ctx.logger.debug('duplicate update ignored', {
        updateId: ctx.update.update_id,
      });
      return;
    }
    await next();
  };
}
