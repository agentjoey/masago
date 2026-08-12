import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { withCorrelationId } from '../../src/observability/correlation.js';
import { createLogger } from '../../src/observability/logger.js';

function collectLogs(): { destination: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return {
    destination,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('logger with correlation id', () => {
  it('attaches the current correlation id to log entries', async () => {
    const { destination, lines } = collectLogs();
    const logger = createLogger({ level: 'info', destination });

    await withCorrelationId('corr-test-123', async () => {
      logger.info('inside correlation scope');
    });

    const entries = lines();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.['correlationId']).toBe('corr-test-123');
    expect(entries[0]?.['msg']).toBe('inside correlation scope');
  });

  it('omits correlation id outside of a scope', () => {
    const { destination, lines } = collectLogs();
    const logger = createLogger({ level: 'info', destination });

    logger.info('outside correlation scope');

    const entries = lines();
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toHaveProperty('correlationId');
  });

  it('redacts sensitive fields before writing', () => {
    const { destination, lines } = collectLogs();
    const logger = createLogger({ level: 'info', destination });

    logger.info('sensitive', { apiKey: 'sk-secret', note: 'fine' });

    const entries = lines();
    expect(entries[0]?.['apiKey']).toBe('<redacted>');
    expect(entries[0]?.['note']).toBe('fine');
  });
});
