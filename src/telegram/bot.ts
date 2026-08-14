import { Bot, type Context } from 'grammy';
import type { AppConfig } from '../config/index.js';
import type { Logger } from '../observability/index.js';
import type { SessionCommands } from '../sessions/index.js';
import {
  registerCommands,
  registerKanaCommands,
  type KanaHandlerDeps,
} from './commands/index.js';
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
  commands?: SessionCommands;
  kana?: KanaHandlerDeps;
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
  // 仮名コマンドを先に登録する。registerCommands の末尾には
  // 「/で始まる未知の語」を拾う catch-all があり、後から登録すると
  // /today も /kana も黙ってそちらに食われる。
  if (deps.kana !== undefined) {
    registerKanaCommands(bot, deps.kana);
  }
  if (deps.commands !== undefined) {
    registerCommands(bot, deps.commands);
  }
  bot.use(createRoute(deps.handleUpdate));

  return bot;
}

/**
 * Telegram のコマンド一覧。入力欄に候補が出るようになる。
 *
 * 説明は中国語。読むのは日本語をまだ知らない人。
 * 失敗しても起動は続ける——一覧が出ないだけで、コマンド自体は打てる。
 */
export const BOT_COMMANDS = [
  { command: 'today', description: '今天学什么' },
  { command: 'kana', description: '练五十音' },
  { command: 'vocab', description: '练 N5 单词' },
  { command: 'write', description: '练写句子（助词与语序）' },
  { command: 'review', description: '只复习到期的' },
  { command: 'progress', description: '学习进度' },
  { command: 'explain', description: '讲解刚才那一项' },
  { command: 'cost', description: '用量与成本' },
  { command: 'help', description: '使用说明' },
] as const;

/**
 * 入力欄の横に Mini App を開くボタンを置く（V3）。
 *
 * URL が無ければ既定のメニューに戻す。開けない入口を残すより、
 * 無いほうがよい。
 */
export async function publishMenuButton(
  bot: Bot<AppContext>,
  logger: Logger,
  miniAppUrl: string | undefined,
): Promise<void> {
  try {
    await bot.api.setChatMenuButton({
      menu_button:
        miniAppUrl === undefined
          ? { type: 'commands' }
          : { type: 'web_app', text: '进度', web_app: { url: miniAppUrl } },
    });
  } catch (error) {
    logger.warn('could not set the menu button', { error });
  }
}

export async function publishCommandList(
  bot: Bot<AppContext>,
  logger: Logger,
): Promise<void> {
  try {
    await bot.api.setMyCommands([...BOT_COMMANDS]);
  } catch (error) {
    logger.warn('could not publish the command list', { error });
  }
}
