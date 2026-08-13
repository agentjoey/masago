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
  replyUpdate,
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

  // /review と /progress は仮名コマンドが実装済みなので、ここには居ない。
  // 予約のまま残すと catch-all に食われて「未実装」と答えてしまう。
  it.each([
    'roleplay',
    'grammar',
    'listening',
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

describe('kana command routing', () => {
  function setupKana() {
    const kanaCommands = {
      today: vi.fn().mockResolvedValue([{ text: 'R_TODAY' }]),
      drill: vi.fn().mockResolvedValue([{ text: 'R_KANA' }]),
      review: vi.fn().mockResolvedValue([{ text: 'R_REVIEW' }]),
      progress: vi.fn().mockResolvedValue([{ text: 'R_PROGRESS' }]),
      answer: vi.fn().mockResolvedValue([{ text: 'R_ANSWER' }]),
      answerTyped: vi.fn().mockResolvedValue(undefined),
      vocab: vi.fn().mockResolvedValue([{ text: 'R_VOCAB' }]),
      cost: vi.fn().mockResolvedValue([{ text: 'R_COST' }]),
      explain: vi.fn().mockResolvedValue([{ text: 'R_EXPLAIN' }]),
    };
    const bot = createBot({
      config: fakeConfig(),
      logger: fakeLogger(),
      handleUpdate: vi.fn().mockResolvedValue(undefined),
      recordUpdate: vi.fn().mockResolvedValue(true),
      commands: {
        switchToConversation: vi.fn().mockResolvedValue('R_TALK'),
        switchToCoach: vi.fn().mockResolvedValue('R_COACH'),
        switchToChallenge: vi.fn().mockResolvedValue('R_CHALLENGE'),
        endSession: vi.fn().mockResolvedValue('R_END'),
      },
      kana: { commands: kanaCommands, audioDir: 'assets/kana-audio' },
    });
    const apiCalls = stubBotApi(bot);
    return { bot, kanaCommands, apiCalls };
  }

  // registerCommands の末尾には「/で始まる未知の語」を拾う catch-all がある。
  // 仮名コマンドを後から登録すると、全部そこに食われて「未知命令」になる。
  // 登録順の事故は動かすまで気づけないので、ここで固定する。
  it.each([
    ['today', 'R_TODAY'],
    ['kana', 'R_KANA'],
    ['review', 'R_REVIEW'],
    ['progress', 'R_PROGRESS'],
    ['vocab', 'R_VOCAB'],
    ['cost', 'R_COST'],
    ['explain', 'R_EXPLAIN'],
  ])('routes /%s to the kana layer, not the catch-all', async (name, reply) => {
    const { bot, apiCalls } = setupKana();

    await bot.handleUpdate(
      commandUpdate({
        updateId: 4000 + name.length,
        userId: ALLOWED_USER_ID,
        messageId: 300,
        command: name,
      }),
    );

    const texts = sentTexts(apiCalls);
    expect(texts).toEqual([reply]);
    expect(texts).not.toContain(UNKNOWN_COMMAND_REPLY);
    expect(texts).not.toContain(COMMAND_NOT_ENABLED_REPLY);
  });

  it('still reports genuinely unknown commands', async () => {
    const { bot, apiCalls } = setupKana();
    await bot.handleUpdate(
      commandUpdate({
        updateId: 4100,
        userId: ALLOWED_USER_ID,
        messageId: 301,
        command: 'nonsense',
      }),
    );
    expect(sentTexts(apiCalls)).toEqual([UNKNOWN_COMMAND_REPLY]);
  });
});

describe('typed quiz answers', () => {
  function setupTyped(answerTypedResult: unknown) {
    const kanaCommands = {
      today: vi.fn().mockResolvedValue([{ text: 'R_TODAY' }]),
      drill: vi.fn().mockResolvedValue([{ text: 'R_KANA' }]),
      review: vi.fn().mockResolvedValue([{ text: 'R_REVIEW' }]),
      progress: vi.fn().mockResolvedValue([{ text: 'R_PROGRESS' }]),
      answer: vi.fn().mockResolvedValue([{ text: 'R_ANSWER' }]),
      answerTyped: vi.fn().mockResolvedValue(answerTypedResult),
      vocab: vi.fn().mockResolvedValue([{ text: 'R_VOCAB' }]),
      cost: vi.fn().mockResolvedValue([{ text: 'R_COST' }]),
      explain: vi.fn().mockResolvedValue([{ text: 'R_EXPLAIN' }]),
    };
    const handleUpdate = vi.fn().mockResolvedValue(undefined);
    const bot = createBot({
      config: fakeConfig(),
      logger: fakeLogger(),
      handleUpdate,
      recordUpdate: vi.fn().mockResolvedValue(true),
      commands: {
        switchToConversation: vi.fn().mockResolvedValue('R_TALK'),
        switchToCoach: vi.fn().mockResolvedValue('R_COACH'),
        switchToChallenge: vi.fn().mockResolvedValue('R_CHALLENGE'),
        endSession: vi.fn().mockResolvedValue('R_END'),
      },
      kana: { commands: kanaCommands, audioDir: 'assets/kana-audio' },
    });
    const apiCalls = stubBotApi(bot);
    return { bot, kanaCommands, handleUpdate, apiCalls };
  }

  it('grades a reply to a quiz question without reaching the tutor', async () => {
    const { bot, kanaCommands, handleUpdate, apiCalls } = setupTyped([
      { text: 'R_GRADED' },
    ]);

    await bot.handleUpdate(
      replyUpdate({
        updateId: 4200,
        userId: ALLOWED_USER_ID,
        messageId: 400,
        text: 'ka',
        repliedText: '这个假名怎么读？\n\nか\n\n直接回复罗马字（例：ka）',
      }),
    );

    expect(kanaCommands.answerTyped).toHaveBeenCalledOnce();
    expect(sentTexts(apiCalls)).toEqual(['R_GRADED']);
    expect(handleUpdate).not.toHaveBeenCalled();
  });

  // 会話への返信まで採点したら、話しかけただけで不正解が積まれる。
  it('passes a reply to an ordinary message through to the tutor', async () => {
    const { bot, kanaCommands, handleUpdate, apiCalls } = setupTyped(undefined);

    await bot.handleUpdate(
      replyUpdate({
        updateId: 4201,
        userId: ALLOWED_USER_ID,
        messageId: 402,
        text: 'げんきです',
        repliedText: 'こんにちは！今日はどうでしたか？',
      }),
    );

    expect(kanaCommands.answerTyped).toHaveBeenCalledOnce();
    expect(handleUpdate).toHaveBeenCalledOnce();
    expect(sentTexts(apiCalls)).toEqual([]);
  });

  it('leaves a plain message alone entirely', async () => {
    const { bot, kanaCommands, handleUpdate } = setupTyped(undefined);

    await bot.handleUpdate(
      textUpdate({
        updateId: 4202,
        userId: ALLOWED_USER_ID,
        messageId: 404,
        text: 'こんにちは',
      }),
    );

    expect(kanaCommands.answerTyped).not.toHaveBeenCalled();
    expect(handleUpdate).toHaveBeenCalledOnce();
  });
});

describe('kana command failures', () => {
  function setupFailing() {
    const boom = () => Promise.reject(new Error('db down'));
    const kanaCommands = {
      today: vi.fn(boom),
      drill: vi.fn(boom),
      review: vi.fn(boom),
      progress: vi.fn(boom),
      answer: vi.fn(boom),
      answerTyped: vi.fn(boom),
      vocab: vi.fn(boom),
      cost: vi.fn(boom),
      explain: vi.fn(boom),
    };
    const handleUpdate = vi.fn().mockResolvedValue(undefined);
    const bot = createBot({
      config: fakeConfig(),
      logger: fakeLogger(),
      handleUpdate,
      recordUpdate: vi.fn().mockResolvedValue(true),
      commands: {
        switchToConversation: vi.fn().mockResolvedValue('R_TALK'),
        switchToCoach: vi.fn().mockResolvedValue('R_COACH'),
        switchToChallenge: vi.fn().mockResolvedValue('R_CHALLENGE'),
        endSession: vi.fn().mockResolvedValue('R_END'),
      },
      kana: { commands: kanaCommands, audioDir: 'assets/kana-audio' },
    });
    return { bot, apiCalls: stubBotApi(bot), handleUpdate };
  }

  // 叩いたのに何も返らないのは、壊れていることすら分からない壊れ方。
  it('answers even when the command throws', async () => {
    const { bot, apiCalls } = setupFailing();
    await bot.handleUpdate(
      commandUpdate({
        updateId: 4300,
        userId: ALLOWED_USER_ID,
        messageId: 500,
        command: 'today',
      }),
    );
    expect(sentTexts(apiCalls)).toEqual(['刚才没能处理，请再试一次。']);
  });

  it('answers when grading a typed reply throws', async () => {
    const { bot, apiCalls, handleUpdate } = setupFailing();
    await bot.handleUpdate(
      replyUpdate({
        updateId: 4301,
        userId: ALLOWED_USER_ID,
        messageId: 502,
        text: 'ka',
        repliedText: '这个假名怎么读？\n\nか\n\n直接回复罗马字（例：ka）',
      }),
    );
    expect(sentTexts(apiCalls)).toEqual(['刚才没能处理，请再试一次。']);
    // 失敗をチューターに流して二重に応答しない
    expect(handleUpdate).not.toHaveBeenCalled();
  });
});
