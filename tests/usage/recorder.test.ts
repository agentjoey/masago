import { describe, expect, it, vi } from 'vitest';
import type { NewUsageRecord } from '../../src/db/schema/ops.js';
import type { Logger } from '../../src/observability/index.js';
import { recordUsage, type RecorderDeps } from '../../src/usage/recorder.js';
import { PRICING_VERSION } from '../../src/usage/pricingTable.js';

interface LogRecord {
  level: string;
  msg: string;
  fields?: Record<string, unknown>;
}

function fakeLogger(): Logger & { records: LogRecord[] } {
  const records: LogRecord[] = [];
  const make =
    (level: string) =>
    (msg: string, fields?: Record<string, unknown>) => {
      records.push({ level, msg, fields });
    };
  const logger: Logger & { records: LogRecord[] } = {
    records,
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    child() {
      return logger;
    },
  };
  return logger;
}

function fakeDeps(): {
  deps: RecorderDeps;
  inserted: NewUsageRecord[];
  logger: Logger & { records: LogRecord[] };
} {
  const inserted: NewUsageRecord[] = [];
  const logger = fakeLogger();
  return {
    deps: {
      logger,
      insertRecord: (record) => {
        inserted.push(record);
        return Promise.resolve(record);
      },
    },
    inserted,
    logger,
  };
}

describe('recordUsage', () => {
  it('writes a fully populated record with computed cost', async () => {
    const { deps, inserted } = fakeDeps();

    await recordUsage(deps, {
      turnId: 'turn-1',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      operation: 'llm',
      inputTokens: 4000,
      outputTokens: 600,
      cacheReadTokens: 2000,
      latencyMs: 1200,
      success: true,
      requestId: 'req-1',
      at: new Date('2026-08-20T12:00:00Z'),
    });

    expect(inserted).toHaveLength(1);
    const record = inserted[0];
    expect(record?.provider).toBe('anthropic');
    expect(record?.model).toBe('claude-sonnet-5');
    expect(record?.operation).toBe('llm');
    expect(record?.inputTokens).toBe(4000);
    expect(record?.outputTokens).toBe(600);
    expect(record?.cachedInputTokens).toBe(2000);
    expect(record?.latencyMs).toBe(1200);
    expect(record?.success).toBe(true);
    expect(record?.requestId).toBe('req-1');
    expect(record?.currency).toBe('USD');
    expect(record?.pricingVersion).toBe(PRICING_VERSION);
    expect(record?.estimatedCost).toBe('0.014400');
  });

  it('records failed calls with success=false and error_code', async () => {
    const { deps, inserted } = fakeDeps();

    await recordUsage(deps, {
      provider: 'openai',
      model: 'gpt-transcribe',
      operation: 'stt',
      success: false,
      errorCode: 'TIMEOUT',
      latencyMs: 30_000,
      at: new Date('2026-08-20T12:00:00Z'),
    });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.success).toBe(false);
    expect(inserted[0]?.errorCode).toBe('TIMEOUT');
    expect(inserted[0]?.estimatedCost).toBe('0.000000');
  });

  it('sets estimatedCost to null (not zero) and warns on unknown pricing', async () => {
    const { deps, inserted, logger } = fakeDeps();

    await recordUsage(deps, {
      provider: 'unknown-provider',
      model: 'unknown-model',
      operation: 'llm',
      inputTokens: 100,
      success: true,
      at: new Date('2026-08-20T12:00:00Z'),
    });

    expect(inserted[0]?.estimatedCost).toBeNull();
    expect(
      logger.records.some(
        (record) => record.level === 'warn' && record.msg.includes('unknown pricing'),
      ),
    ).toBe(true);
  });

  it('uses the call time price, not the current price', async () => {
    const { deps, inserted } = fakeDeps();

    await recordUsage(deps, {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      operation: 'llm',
      inputTokens: 1_000_000,
      success: true,
      at: new Date('2026-08-20T12:00:00Z'),
    });

    expect(inserted[0]?.estimatedCost).toBe('2.000000');
  });

  it('does not throw when the insert fails; logs an error instead', async () => {
    const logger = fakeLogger();
    const insertRecord = vi.fn(() => Promise.reject(new Error('db down')));

    await expect(
      recordUsage(
        { logger, insertRecord },
        {
          provider: 'minimax',
          model: 'speech-2.8-turbo',
          operation: 'tts',
          ttsCharacters: 10,
          success: true,
          at: new Date('2026-08-20T12:00:00Z'),
        },
      ),
    ).resolves.toBeUndefined();

    expect(
      logger.records.some(
        (record) => record.level === 'error' && record.msg.includes('failed to record usage'),
      ),
    ).toBe(true);
  });
});
