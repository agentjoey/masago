import { randomUUID } from 'node:crypto';
import type { MiddlewareFn } from 'grammy';
import type { Logger } from '../../observability/index.js';
import { withCorrelationId } from '../../observability/index.js';
import type { AppContext } from '../bot.js';

export function createCorrelationId(logger: Logger): MiddlewareFn<AppContext> {
  return async (ctx, next) => {
    const id = randomUUID();
    ctx.correlationId = id;
    ctx.logger = logger.child({ correlationId: id });
    await withCorrelationId(id, next);
  };
}
