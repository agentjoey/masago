import { describe, expect, it, vi } from 'vitest';
import { createBot, type AppContext } from '../../src/telegram/index.js';
import {
  ALLOWED_USER_ID,
  fakeConfig,
  fakeLogger,
  stubBotApi,
  textUpdate,
} from './helpers.js';

function setup(overrides: { userId?: number } = {}) {
  const logger = fakeLogger();
  const handleUpdate = vi.fn<(ctx: AppContext) => Promise<void>>().mockResolvedValue(undefined);
  const recordUpdate = vi.fn<(id: number, payload: unknown) => Promise<boolean>>().mockResolvedValue(true);
  const bot = createBot({
    config: fakeConfig(),
    logger,
    handleUpdate,
    recordUpdate,
  });
  const apiCalls = stubBotApi(bot);
  return { bot, logger, handleUpdate, recordUpdate, apiCalls, userId: overrides.userId ?? ALLOWED_USER_ID };
}

describe('auth middleware', () => {
  it('silently drops unauthorized updates before any downstream middleware or external call', async () => {
    const { bot, logger, handleUpdate, recordUpdate, apiCalls } = setup();

    await bot.handleUpdate(
      textUpdate({ updateId: 1001, userId: ALLOWED_USER_ID + 1, messageId: 1, text: 'こんにちは' }),
    );

    expect(handleUpdate).not.toHaveBeenCalled();
    expect(recordUpdate).not.toHaveBeenCalled();
    expect(apiCalls).toHaveLength(0);

    const warns = logger.records.filter((r) => r.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]?.msg).toBe('unauthorized update ignored');
    expect(warns[0]?.fields?.['telegramUserId']).toBe(ALLOWED_USER_ID + 1);
    expect(warns[0]?.fields?.['correlationId']).toBeTypeOf('string');
    expect(JSON.stringify(warns[0]?.fields)).not.toContain('こんにちは');
  });

  it('does not write telegram_updates for unauthorized updates', async () => {
    const { bot, recordUpdate } = setup();

    await bot.handleUpdate(
      textUpdate({ updateId: 1002, userId: ALLOWED_USER_ID + 1, messageId: 2, text: 'spy' }),
    );

    expect(recordUpdate).not.toHaveBeenCalled();
  });

  it('lets authorized updates through the full chain', async () => {
    const { bot, handleUpdate, recordUpdate } = setup();

    await bot.handleUpdate(
      textUpdate({ updateId: 1003, userId: ALLOWED_USER_ID, messageId: 3, text: 'hello' }),
    );

    expect(recordUpdate).toHaveBeenCalledTimes(1);
    expect(recordUpdate).toHaveBeenCalledWith(1003, expect.objectContaining({ update_id: 1003 }));
    expect(handleUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('dedupe middleware', () => {
  it('blocks a repeated update_id so business handling runs exactly once', async () => {
    const logger = fakeLogger();
    const seen = new Set<number>();
    const recordUpdate = (id: number): Promise<boolean> => {
      if (seen.has(id)) return Promise.resolve(false);
      seen.add(id);
      return Promise.resolve(true);
    };
    const handleUpdate = vi.fn<(ctx: AppContext) => Promise<void>>(async (ctx) => {
      await ctx.reply(`echo: ${ctx.message?.text ?? ''}`);
    });
    const bot = createBot({ config: fakeConfig(), logger, handleUpdate, recordUpdate });
    const apiCalls = stubBotApi(bot);

    const update = textUpdate({ updateId: 2001, userId: ALLOWED_USER_ID, messageId: 10, text: '重复测试' });
    await bot.handleUpdate(update);
    await bot.handleUpdate(update);

    expect(handleUpdate).toHaveBeenCalledTimes(1);
    const sendMessages = apiCalls.filter((c) => c.method === 'sendMessage');
    expect(sendMessages).toHaveLength(1);
    expect((sendMessages[0]?.payload as { text?: string }).text).toBe('echo: 重复测试');
  });

  it('fails closed when the dedupe record cannot be written', async () => {
    const logger = fakeLogger();
    const handleUpdate = vi.fn<(ctx: AppContext) => Promise<void>>().mockResolvedValue(undefined);
    const recordUpdate = (): Promise<boolean> => Promise.reject(new Error('db down'));
    const bot = createBot({ config: fakeConfig(), logger, handleUpdate, recordUpdate });
    stubBotApi(bot);

    await bot.handleUpdate(
      textUpdate({ updateId: 2002, userId: ALLOWED_USER_ID, messageId: 11, text: 'x' }),
    );

    expect(handleUpdate).not.toHaveBeenCalled();
    expect(logger.records.some((r) => r.level === 'error')).toBe(true);
  });
});
