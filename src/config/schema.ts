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
  MINIMAX_API_KEY: z.string().min(1),
  MINIMAX_VOICE_ID: z.string().min(1),

  // Correction rhythm
  SURFACE_AFTER_TURNS_CONVERSATION: z.coerce.number().int().min(1).default(4),
  SURFACE_AFTER_TURNS_COACH: z.coerce.number().int().min(1).default(1),
  SURFACE_MAX_ITEMS: z.coerce.number().int().min(1).default(3),
  SURFACE_HIGH_IMPORTANCE_THRESHOLD: z.coerce.number().int().min(1).default(2),

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
    minimaxApiKey: env.MINIMAX_API_KEY,
    minimaxVoiceId: env.MINIMAX_VOICE_ID,
  },
  correction: {
    surfaceAfterTurnsConversation: env.SURFACE_AFTER_TURNS_CONVERSATION,
    surfaceAfterTurnsCoach: env.SURFACE_AFTER_TURNS_COACH,
    surfaceMaxItems: env.SURFACE_MAX_ITEMS,
    highImportanceThreshold: env.SURFACE_HIGH_IMPORTANCE_THRESHOLD,
  },
  session: {
    userTimezone: env.USER_TIMEZONE,
    idleMinutes: env.SESSION_IDLE_MINUTES,
    dailyReminderLocalTime: env.DAILY_REMINDER_LOCAL_TIME,
    nightlyBackupLocalTime: env.NIGHTLY_BACKUP_LOCAL_TIME,
  },
  budget: {
    dailyCostSoftLimitUsd: env.DAILY_COST_SOFT_LIMIT_USD,
    monthlyCostSoftLimitUsd: env.MONTHLY_COST_SOFT_LIMIT_USD,
  },
  logging: {
    level: env.LOG_LEVEL,
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
