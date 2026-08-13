import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../../src/config/schema.js';

const REQUIRED_ENV: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: 'test-bot-token',
  ALLOWED_TELEGRAM_USER_ID: '123456789',
  DATABASE_URL: 'postgres://user:pass@host:5432/db',
  DATABASE_URL_DIRECT: 'postgres://user:pass@host:5432/db',
  LLM_PROVIDER: 'openai',
  LLM_MODEL: 'gpt-test',
  LLM_API_KEY: 'test-llm-key',
  OPENAI_API_KEY: 'test-openai-key',
  MINIMAX_VOICE_ID: 'test-voice-id',
  DAILY_COST_SOFT_LIMIT_USD: '1.5',
  MONTHLY_COST_SOFT_LIMIT_USD: '20',
};

function makeEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return { ...REQUIRED_ENV, LOG_LEVEL: 'info', ...overrides };
}

function expectConfigError(env: Record<string, string>): ConfigError {
  try {
    parseConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error('expected parseConfig to throw ConfigError');
}

describe('parseConfig', () => {
  it('fails fast and reports every missing required field', () => {
    const error = expectConfigError({});
    const fields = error.issues.map((issue) => issue.field);
    for (const name of Object.keys(REQUIRED_ENV)) {
      expect(fields).toContain(name);
    }
  });

  it('never echoes the offending value in error output', () => {
    const secretValue = 'super-sensitive-value-987654';
    const error = expectConfigError(
      makeEnv({ DAILY_COST_SOFT_LIMIT_USD: secretValue, USER_TIMEZONE: secretValue }),
    );
    const serialized = JSON.stringify(error.issues);
    expect(serialized).not.toContain(secretValue);
  });

  it('applies documented numeric and string defaults', () => {
    const config = parseConfig(makeEnv());
    expect(config.db.poolMax).toBe(2);
    expect(config.db.poolIdleTimeoutMs).toBe(15000);
    expect(config.db.connectionTimeoutMs).toBe(10000);
    expect(config.session.idleMinutes).toBe(30);
    expect(config.llm.maxContextTurns).toBe(12);
    expect(config.correction.surfaceAfterTurnsConversation).toBe(4);
    expect(config.correction.surfaceAfterTurnsCoach).toBe(1);
    expect(config.correction.surfaceMaxItems).toBe(3);
    expect(config.audio.targetContainer).toBe('webm');
    expect(config.tts.maxCharacters).toBe(400);
  });

  it('parses the string "false" as boolean false', () => {
    const config = parseConfig(makeEnv({ STT_CONTEXT_HINTS_ENABLED: 'false' }));
    expect(config.stt.contextHintsEnabled).toBe(false);
  });

  it('parses the string "true" as boolean true', () => {
    const config = parseConfig(makeEnv({ STT_CONTEXT_HINTS_ENABLED: 'true' }));
    expect(config.stt.contextHintsEnabled).toBe(true);
  });

  it('rejects an invalid USER_TIMEZONE', () => {
    const error = expectConfigError(makeEnv({ USER_TIMEZONE: 'Not/AZone' }));
    expect(error.issues.map((issue) => issue.field)).toContain('USER_TIMEZONE');
  });

  it('rejects an invalid HH:MM time', () => {
    const invalidDaily = expectConfigError(makeEnv({ DAILY_REMINDER_LOCAL_TIME: '25:00' }));
    expect(invalidDaily.issues.map((issue) => issue.field)).toContain(
      'DAILY_REMINDER_LOCAL_TIME',
    );

    const invalidNightly = expectConfigError(makeEnv({ NIGHTLY_BACKUP_LOCAL_TIME: '3am' }));
    expect(invalidNightly.issues.map((issue) => issue.field)).toContain(
      'NIGHTLY_BACKUP_LOCAL_TIME',
    );
  });

  it('groups values into the nested config structure', () => {
    const config = parseConfig(makeEnv());
    expect(config.telegram.botToken).toBe('test-bot-token');
    expect(config.telegram.allowedUserId).toBe(123456789);
    expect(config.db.url).toBe('postgres://user:pass@host:5432/db');
    expect(config.stt.model).toBe('gpt-transcribe');
    expect(config.session.userTimezone).toBe('Asia/Singapore');
    expect(config.budget.dailyCostSoftLimitUsd).toBe(1.5);
  });
});

describe('minimax key fallback', () => {
  // MiniMax の TTS は Token Plan の同じ鍵で通る（2026-08-14 実測）。
  // 同じ秘密を .env に二度書かせないため、未設定なら LLM_API_KEY を使う。
  it('falls back to LLM_API_KEY when MINIMAX_API_KEY is absent', () => {
    const config = parseConfig(makeEnv());
    expect(config.tts.minimaxApiKey).toBe('test-llm-key');
  });

  it('prefers an explicit MINIMAX_API_KEY when provided', () => {
    const config = parseConfig(makeEnv({ MINIMAX_API_KEY: 'explicit-minimax' }));
    expect(config.tts.minimaxApiKey).toBe('explicit-minimax');
  });
});
