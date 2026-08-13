import { describe, expect, it, vi } from 'vitest';
import type { SessionCommands } from '../../src/sessions/index.js';
import {
  COMMAND_NOT_ENABLED_REPLY,
  UNKNOWN_COMMAND_REPLY,
} from '../../src/telegram/commands/index.js';
import { createBot, type AppContext } from '../../src/telegram/index.js';
import {
  ALLOWED_USER_ID,
  commandUpdate,
  fakeConfig,
  fakeLogger,
  stubBotApi,
  textUpdate,
} from './helpers.js';

function setup() {
  const logger = fakeLogger();
  const handleUpdate = vi
    .fn<(ctx: AppContext) => Promise<void>>()
    .mockResolvedValue(undefined);
  const recordUpdate = vi
    .fn<(id: number, payload: unknown) => Promise<boolean>>()
    .mockResolvedValue(true);
  const commands: SessionCommands = {
    switchToConversation: vi.fn().mockResolvedValue('R_TALK'),
    switchToCoach: vi.fn().mockResolvedValue('R_COACH'),
    switchToChallenge: vi.fn().mockResolvedValue('R_CHALLENGE'),
    endSession: vi.fn().mockResolvedValue('R_END'),
  };
  const bot = createBot({
    config: fakeConfig(),
    logger,
    handleUpdate,
    recordUpdate,
    commands,
  });
  const apiCalls = stubBotApi(bot);
  return { bot, logger, handleUpdate, recordUpdate, commands, apiCalls };
}

function sentTexts(apiCalls: { method: string; payload: unknown }[]): string[] {
  return apiCalls
    .filter((call) => call.method === 'sendMessage')
    .map((call) => (call.payload as { text?: string }).text ?? '');
}

describe('command routing', () => {
  it('routes /talk to switchToConversation and replies with its result', async () => {
    const { bot, commands, handleUpdate, apiCalls } = setup();

    await bot.handleUpdate(
      commandUpdate({
        updateId: 3001,
        userId: ALLOWED_USER_ID,
        messageId: 101,
        command: 'talk',
      }),
    );

    expect(commands.switchToConversation).toHaveBeenCalledTimes(1);
    expect(commands.switchToConversation).toHaveBeenCalledWith(ALLOWED_USER_ID);
    expect(sentTexts(apiCalls)).toEqual(['R_TALK']);
    expect(handleUpdate).not.toHaveBeenCalled();
  });

  it('routes /coach to switchToCoach with user and message id', async () => {
    const { bot, commands, handleUpdate, apiCalls } = setup();

    await bot.handleUpdate(
      commandUpdate({
        updateId: 3002,
        userId: ALLOWED_USER_ID,
        messageId: 102,
        command: 'coach',
      }),
    );

    expect(commands.switchToCoach).toHaveBeenCalledTimes(1);
    expect(commands.switchToCoach).toHaveBeenCalledWith(ALLOWED_USER_ID, 102);
    expect(sentTexts(apiCalls)).toEqual(['R_COACH']);
    expect(handleUpdate).not.toHaveBeenCalled();
  });

  it('routes /correct to the same handler as /coach', async () => {
    const { bot, commands } = setup();

    await bot.handleUpdate(
      commandUpdate({
        updateId: 3003,
        userId: ALLOWED_USER_ID,
        messageId: 103,
        command: 'correct',
      }),
    );

    expect(commands.switchToCoach).toHaveBeenCalledTimes(1);
    expect(commands.switchToCoach).toHaveBeenCalledWith(ALLOWED_USER_ID, 103);
  });

  it('routes /challenge to switchToChallenge', async () => {
    const { bot, commands, apiCalls } = setup();

    await bot.handleUpdate(
      commandUpdate({
        updateId: 3004,
        userId: ALLOWED_USER_ID,
        messageId: 104,
        command: 'challenge',
      }),
    );

    expect(commands.switchToChallenge).toHaveBeenCalledTimes(1);
    expect(commands.switchToChallenge).toHaveBeenCalledWith(ALLOWED_USER_ID);
    expect(sentTexts(apiCalls)).toEqual(['R_CHALLENGE']);
  });

  it('routes /end to endSession with user and message id', async () => {
    const { bot, commands, apiCalls } = setup();

    await bot.handleUpdate(
      commandUpdate({
        updateId: 3005,
        userId: ALLOWED_USER_ID,
        messageId: 105,
        command: 'end',
      }),
    );

    expect(commands.endSession).toHaveBeenCalledTimes(1);
    expect(commands.endSession).toHaveBeenCalledWith(ALLOWED_USER_ID, 105);
    expect(sentTexts(apiCalls)).toEqual(['R_END']);
  });

  it('silently drops /coach from an unauthorized user: no handler, no API call, no telegram_updates write', async () => {
    const { bot, commands, handleUpdate, recordUpdate, apiCalls } = setup();

    await bot.handleUpdate(
      commandUpdate({
        updateId: 3006,
        userId: ALLOWED_USER_ID + 1,
        messageId: 106,
        command: 'coach',
      }),
    );

    expect(commands.switchToCoach).not.toHaveBeenCalled();
    expect(handleUpdate).not.toHaveBeenCalled();
    expect(recordUpdate).not.toHaveBeenCalled();
    expect(apiCalls).toHaveLength(0);
  });

  it.each([
    'roleplay',
    'review',
    'vocab',
    'grammar',
    'listening',
    'progress',
    'cost',
  ])('replies "not enabled" for reserved command /%s without touching the business layer', async (name) => {
    const { bot, commands, handleUpdate, apiCalls } = setup();

    await bot.handleUpdate(
      commandUpdate({
        updateId: 3100,
        userId: ALLOWED_USER_ID,
        messageId: 200,
        command: name,
      }),
    );

    expect(sentTexts(apiCalls)).toEqual([COMMAND_NOT_ENABLED_REPLY]);
    expect(commands.switchToConversation).not.toHaveBeenCalled();
    expect(commands.switchToCoach).not.toHaveBeenCalled();
    expect(commands.switchToChallenge).not.toHaveBeenCalled();
    expect(commands.endSession).not.toHaveBeenCalled();
    expect(handleUpdate).not.toHaveBeenCalled();
  });

  it('replies with the fallback for an unknown command', async () => {
    const { bot, commands, handleUpdate, apiCalls } = setup();

    await bot.handleUpdate(
      commandUpdate({
        updateId: 3200,
        userId: ALLOWED_USER_ID,
        messageId: 300,
        command: 'dance',
      }),
    );

    expect(sentTexts(apiCalls)).toEqual([UNKNOWN_COMMAND_REPLY]);
    expect(commands.switchToCoach).not.toHaveBeenCalled();
    expect(handleUpdate).not.toHaveBeenCalled();
  });

  it('does not treat command-looking text without bot_command entities as a command', async () => {
    const { bot, commands, handleUpdate, apiCalls } = setup();

    await bot.handleUpdate(
      textUpdate({
        updateId: 3201,
        userId: ALLOWED_USER_ID,
        messageId: 301,
        text: '/coach',
      }),
    );

    // 没有 entities 时命令处理器不会触发（grammY 依赖 bot_command entity），
    // 消息落入未知命令兜底而不是会话路由——这正是必须用 commandUpdate 造命令消息的原因。
    expect(commands.switchToCoach).not.toHaveBeenCalled();
    expect(handleUpdate).not.toHaveBeenCalled();
    expect(sentTexts(apiCalls)).toEqual([UNKNOWN_COMMAND_REPLY]);
  });
});
