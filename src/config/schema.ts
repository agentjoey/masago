import { z } from 'zod';

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function envBoolean(defaultValue?: boolean) {
  const schema = z.string().transform((raw, ctx) => {
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
    ctx.addIssue({ code: 'custom', message: 'must be a boolean (true or false)' });
    return z.NEVER;
  });
  return defaultValue === undefined ? schema : schema.default(defaultValue);
}

const envSchema = z.object({
  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  ALLOWED_TELEGRAM_USER_ID: z.coerce.number().int().positive(),

  // Database
  DATABASE_URL: z.string().min(1),
  DATABASE_URL_DIRECT: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().min(1).default(2),
  DB_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),

  // LLM
  LLM_PROVIDER: z.string().min(1),
  LLM_BASE_URL: z.string().min(1).default('https://api.anthropic.com'),
  LLM_MODEL: z.string().min(1),
  LLM_API_KEY: z.string().min(1),
  LLM_MAX_CONTEXT_TURNS: z.coerce.number().int().min(1).default(12),
  LLM_PROMPT_CACHE_ENABLED: envBoolean(true),

  // STT
  // Railway が注入する。Mini App と健康確認を出すサーバが使う。
  PORT: z.coerce.number().int().positive().default(3000),
  /**
   * Mini App の公開 URL（V3）。未設定ならメニューボタンを出さない
   * ——開けない入口を置いても混乱するだけ。
   */
  MINIAPP_URL: z.string().url().optional(),

  /**
   * MCP 第二界面の鍵（docs/mcp.md 方案 A）。URL 自体が凭据になる。
   *
   * 未設定なら MCP は無効——開けない入口を置いても混乱するだけで、
   * 空文字を鍵として受け入れると誰でも読めてしまう。
   * 64 文字以上を要求する：短い鍵は総当たりで通る。
   */
  MCP_ACCESS_TOKEN: z.string().min(64).optional(),
  /** MCP の毎分呼び出し上限。呼ぶのは人ではなく模型なので絞る（§9.1）。 */
  MCP_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(30),

  // V2 は文字入力が主で、音声入力は範囲外（C4）。既定で無効。
  // 有効にするときは ffmpeg が要る——OGG/opus を STT が読める形に直すため。
  VOICE_INPUT_ENABLED: envBoolean(false),
  STT_PROVIDER: z.string().min(1).default('openai'),
  STT_MODEL: z.string().min(1).default('gpt-transcribe'),
  STT_CONTEXT_HINTS_ENABLED: envBoolean(false),
  OPENAI_API_KEY: z.string().min(1),

  // Audio
  AUDIO_TARGET_CONTAINER: z.string().min(1).default('webm'),
  AUDIO_REMUX_COPY_CODEC: envBoolean(true),
  AUDIO_MAX_DURATION_SECONDS: z.coerce.number().int().positive().default(120),
  AUDIO_MAX_SIZE_MB: z.coerce.number().int().positive().default(20),

  // TTS
  TTS_PROVIDER: z.string().min(1).default('minimax'),
  TTS_MODEL_CONVERSATION: z.string().min(1).default('speech-2.8-turbo'),
  TTS_MODEL_TEACHING: z.string().min(1).default('speech-2.8-hd'),
  TTS_MAX_CHARACTERS: z.coerce.number().int().positive().default(400),
  // MiniMax の TTS は Token Plan の同じ鍵で通る（2026-08-14 実測）。
  // 同じ秘密を .env に二度書くと必ずずれるため、未設定なら LLM_API_KEY を使う。
  MINIMAX_API_KEY: z.string().min(1).optional(),
  MINIMAX_VOICE_ID: z.string().min(1),

  // Correction rhythm
  SURFACE_AFTER_TURNS_CONVERSATION: z.coerce.number().int().min(1).default(4),
  SURFACE_AFTER_TURNS_COACH: z.coerce.number().int().min(1).default(1),
  SURFACE_MAX_ITEMS: z.coerce.number().int().min(1).default(3),
  SURFACE_HIGH_IMPORTANCE_THRESHOLD: z.coerce.number().int().min(1).default(2),

  // 仮名音声ライブラリ（事前生成済み、実行時に TTS を呼ばない）
  KANA_AUDIO_DIR: z.string().min(1).default('assets/kana-audio'),
  KANA_OPTION_COUNT: z.coerce.number().int().min(2).max(8).default(4),
  KANA_NEW_PER_DAY: z.coerce.number().int().min(0).max(20).default(5),
  KANA_MAX_REVIEWS: z.coerce.number().int().min(1).default(20),
  KANA_BACKLOG_THRESHOLD: z.coerce.number().int().min(1).default(20),

  // Review scheduling (FSRS)
  // 目標保持率。0.9 なら復習時点で 90% 思い出せる想定で間隔を引く。
  // 上げるほど復習は増えて忘れにくく、下げるほど楽になるが取りこぼす。
  FSRS_REQUEST_RETENTION: z.coerce.number().gt(0).lt(1).default(0.9),

  // Session & scheduling
  USER_TIMEZONE: z
    .string()
    .min(1)
    .refine(isValidTimeZone, { message: 'must be a valid IANA time zone' })
    .default('Asia/Singapore'),
  SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(30),
  DAILY_REMINDER_LOCAL_TIME: z
    .string()
    .regex(TIME_PATTERN, 'must be HH:MM in 24-hour format')
    .default('20:30'),
  WEEKLY_REPORT_LOCAL_TIME: z
    .string()
    .regex(TIME_PATTERN, 'must be HH:MM in 24-hour format')
    .default('20:00'),
  /** 0 = 周日。默认周日晚上——一周结束时回顾，第二天正好接着做。 */
  WEEKLY_REPORT_WEEKDAY: z.coerce.number().int().min(0).max(6).default(0),
  NIGHTLY_BACKUP_LOCAL_TIME: z
    .string()
    .regex(TIME_PATTERN, 'must be HH:MM in 24-hour format')
    .default('03:00'),

  // Budget & logging
  DAILY_COST_SOFT_LIMIT_USD: z.coerce.number().positive(),
  MONTHLY_COST_SOFT_LIMIT_USD: z.coerce.number().positive(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export const configSchema = envSchema.transform((env) => ({
  telegram: {
    botToken: env.TELEGRAM_BOT_TOKEN,
    allowedUserId: env.ALLOWED_TELEGRAM_USER_ID,
  },
  db: {
    url: env.DATABASE_URL,
    urlDirect: env.DATABASE_URL_DIRECT,
    poolMax: env.DB_POOL_MAX,
    poolIdleTimeoutMs: env.DB_POOL_IDLE_TIMEOUT_MS,
    connectionTimeoutMs: env.DB_CONNECTION_TIMEOUT_MS,
  },
  llm: {
    provider: env.LLM_PROVIDER,
    baseUrl: env.LLM_BASE_URL,
    model: env.LLM_MODEL,
    apiKey: env.LLM_API_KEY,
    maxContextTurns: env.LLM_MAX_CONTEXT_TURNS,
    promptCacheEnabled: env.LLM_PROMPT_CACHE_ENABLED,
  },
  stt: {
    inputEnabled: env.VOICE_INPUT_ENABLED,
    provider: env.STT_PROVIDER,
    model: env.STT_MODEL,
    contextHintsEnabled: env.STT_CONTEXT_HINTS_ENABLED,
    openaiApiKey: env.OPENAI_API_KEY,
  },
  audio: {
    targetContainer: env.AUDIO_TARGET_CONTAINER,
    remuxCopyCodec: env.AUDIO_REMUX_COPY_CODEC,
    maxDurationSeconds: env.AUDIO_MAX_DURATION_SECONDS,
    maxSizeMb: env.AUDIO_MAX_SIZE_MB,
  },
  tts: {
    provider: env.TTS_PROVIDER,
    modelConversation: env.TTS_MODEL_CONVERSATION,
    modelTeaching: env.TTS_MODEL_TEACHING,
    maxCharacters: env.TTS_MAX_CHARACTERS,
    minimaxApiKey: env.MINIMAX_API_KEY ?? env.LLM_API_KEY,
    minimaxVoiceId: env.MINIMAX_VOICE_ID,
  },
  correction: {
    surfaceAfterTurnsConversation: env.SURFACE_AFTER_TURNS_CONVERSATION,
    surfaceAfterTurnsCoach: env.SURFACE_AFTER_TURNS_COACH,
    surfaceMaxItems: env.SURFACE_MAX_ITEMS,
    highImportanceThreshold: env.SURFACE_HIGH_IMPORTANCE_THRESHOLD,
  },
  review: {
    requestRetention: env.FSRS_REQUEST_RETENTION,
  },
  kana: {
    audioDir: env.KANA_AUDIO_DIR,
    optionCount: env.KANA_OPTION_COUNT,
    newPerDay: env.KANA_NEW_PER_DAY,
    maxReviews: env.KANA_MAX_REVIEWS,
    backlogThreshold: env.KANA_BACKLOG_THRESHOLD,
  },
  session: {
    userTimezone: env.USER_TIMEZONE,
    idleMinutes: env.SESSION_IDLE_MINUTES,
    dailyReminderLocalTime: env.DAILY_REMINDER_LOCAL_TIME,
    weeklyReportLocalTime: env.WEEKLY_REPORT_LOCAL_TIME,
    weeklyReportWeekday: env.WEEKLY_REPORT_WEEKDAY,
    nightlyBackupLocalTime: env.NIGHTLY_BACKUP_LOCAL_TIME,
  },
  budget: {
    dailyCostSoftLimitUsd: env.DAILY_COST_SOFT_LIMIT_USD,
    monthlyCostSoftLimitUsd: env.MONTHLY_COST_SOFT_LIMIT_USD,
  },
  logging: {
    level: env.LOG_LEVEL,
  },
  server: {
    port: env.PORT,
    miniAppUrl: env.MINIAPP_URL,
  },
  mcp: {
    accessToken: env.MCP_ACCESS_TOKEN,
    ratePerMinute: env.MCP_RATE_LIMIT_PER_MINUTE,
  },
}));

export type AppConfig = z.infer<typeof configSchema>;

export interface ConfigIssue {
  field: string;
  message: string;
}

export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: ConfigIssue[]) {
    super('Invalid configuration');
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}
