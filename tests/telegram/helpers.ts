import type { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { parseConfig, type AppConfig } from '../../src/config/schema.js';
import type { Logger } from '../../src/observability/index.js';
import type { AppContext } from '../../src/telegram/index.js';

export const ALLOWED_USER_ID = 424_242;

export function fakeConfig(): AppConfig {
  return parseConfig({
    TELEGRAM_BOT_TOKEN: 'ci-fake-token',
    ALLOWED_TELEGRAM_USER_ID: String(ALLOWED_USER_ID),
    DATABASE_URL: 'postgres://ci:ci@localhost:5432/ci',
    DATABASE_URL_DIRECT: 'postgres://ci:ci@localhost:5432/ci',
    LLM_PROVIDER: 'fake',
    LLM_MODEL: 'fake',
    LLM_API_KEY: 'fake',
    OPENAI_API_KEY: 'fake',
    MINIMAX_API_KEY: 'fake',
    MINIMAX_VOICE_ID: 'fake',
    DAILY_COST_SOFT_LIMIT_USD: '5',
    MONTHLY_COST_SOFT_LIMIT_USD: '50',
  });
}

export interface LogRecord {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  fields?: Record<string, unknown>;
}

export interface FakeLogger extends Logger {
  records: LogRecord[];
}

export function fakeLogger(): FakeLogger {
  const records: LogRecord[] = [];
  const make = (bindings?: Record<string, unknown>): FakeLogger => {
    const logger: FakeLogger = {
      records,
      debug: (msg, fields) => records.push({ level: 'debug', msg, fields: { ...bindings, ...fields } }),
      info: (msg, fields) => records.push({ level: 'info', msg, fields: { ...bindings, ...fields } }),
      warn: (msg, fields) => records.push({ level: 'warn', msg, fields: { ...bindings, ...fields } }),
      error: (msg, fields) => records.push({ level: 'error', msg, fields: { ...bindings, ...fields } }),
      child: (childBindings) => make({ ...bindings, ...childBindings }),
    };
    return logger;
  };
  return make();
}

const FAKE_ME: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: 'ci-bot',
  username: 'ci_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

export interface ApiCall {
  method: string;
  payload: unknown;
}

export function stubBotApi(bot: Bot<AppContext>): ApiCall[] {
  bot.botInfo = FAKE_ME;
  const calls: ApiCall[] = [];
  bot.api.config.use((prev, method, payload) => {
    calls.push({ method, payload });
    return Promise.resolve({ ok: true, result: true } as { ok: true; result: never });
  });
  return calls;
}

export function textUpdate(options: {
  updateId: number;
  userId: number;
  messageId: number;
  text: string;
}): Update {
  return {
    update_id: options.updateId,
    message: {
      message_id: options.messageId,
      date: 1_700_000_000,
      chat: { id: options.userId, type: 'private', first_name: 'CI' },
      from: { id: options.userId, is_bot: false, first_name: 'CI' },
      text: options.text,
    },
  };
}

export function voiceUpdate(options: {
  updateId: number;
  userId: number;
  messageId: number;
}): Update {
  return {
    update_id: options.updateId,
    message: {
      message_id: options.messageId,
      date: 1_700_000_000,
      chat: { id: options.userId, type: 'private', first_name: 'CI' },
      from: { id: options.userId, is_bot: false, first_name: 'CI' },
      voice: {
        file_id: 'ci-file-id',
        file_unique_id: 'ci-file-unique-id',
        duration: 3,
      },
    },
  };
}

// grammY 的 bot.command() 依赖 bot_command entity 识别命令；
// textUpdate() 不带 entities，造命令消息必须用这个构造函数。
export function commandUpdate(options: {
  updateId: number;
  userId: number;
  messageId: number;
  command: string;
}): Update {
  const text = `/${options.command}`;
  return {
    update_id: options.updateId,
    message: {
      message_id: options.messageId,
      date: 1_700_000_000,
      chat: { id: options.userId, type: 'private', first_name: 'CI' },
      from: { id: options.userId, is_bot: false, first_name: 'CI' },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: text.length }],
    },
  };
}
