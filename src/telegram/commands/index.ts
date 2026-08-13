import type { Bot } from 'grammy';
import type { SessionCommands } from '../../sessions/index.js';
import type { AppContext } from '../bot.js';
import { registerKanaCommands, type KanaHandlerDeps } from './kana.js';

export { registerKanaCommands };
export type { KanaHandlerDeps };

export const COMMAND_NOT_ENABLED_REPLY = '该命令尚未启用。';
export const UNKNOWN_COMMAND_REPLY =
  '未知命令。可用命令：/today /kana /review /progress /talk /coach /challenge /end';

// /review /progress は kana.ts が実装済みなので予約から外す。
// 両方に登録すると、先に当たったほうが黙って勝つ。
const RESERVED_COMMANDS = [
  'roleplay',
  'vocab',
  'grammar',
  'listening',
  'cost',
] as const;

function telegramUserIdOf(ctx: AppContext): number | undefined {
  return ctx.from?.id;
}

function messageIdOf(ctx: AppContext): number | undefined {
  return ctx.message?.message_id;
}

export function registerCommands(
  bot: Bot<AppContext>,
  commands: SessionCommands,
): void {
  bot.command('talk', async (ctx) => {
    const userId = telegramUserIdOf(ctx);
    if (userId === undefined) return;
    await ctx.reply(await commands.switchToConversation(userId));
  });

  const switchToCoach = async (ctx: AppContext): Promise<void> => {
    const userId = telegramUserIdOf(ctx);
    const messageId = messageIdOf(ctx);
    if (userId === undefined || messageId === undefined) return;
    await ctx.reply(await commands.switchToCoach(userId, messageId));
  };
  bot.command('coach', switchToCoach);
  bot.command('correct', switchToCoach);

  bot.command('challenge', async (ctx) => {
    const userId = telegramUserIdOf(ctx);
    if (userId === undefined) return;
    await ctx.reply(await commands.switchToChallenge(userId));
  });

  bot.command('end', async (ctx) => {
    const userId = telegramUserIdOf(ctx);
    const messageId = messageIdOf(ctx);
    if (userId === undefined || messageId === undefined) return;
    await ctx.reply(await commands.endSession(userId, messageId));
  });

  for (const name of RESERVED_COMMANDS) {
    bot.command(name, async (ctx) => {
      await ctx.reply(COMMAND_NOT_ENABLED_REPLY);
    });
  }

  bot.hears(/^\/\S+/, async (ctx) => {
    await ctx.reply(UNKNOWN_COMMAND_REPLY);
  });
}
