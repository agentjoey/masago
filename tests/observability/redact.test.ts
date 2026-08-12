import { describe, expect, it } from 'vitest';
import { redact } from '../../src/observability/redact.js';

describe('redact', () => {
  it('redacts sensitive keys in nested objects', () => {
    const input = {
      user: {
        profile: {
          apiKey: 'sk-live-123',
          name: 'kenji',
        },
      },
      DATABASE_URL: 'postgres://user:pass@host/db',
      nested: [{ token: 'abc' }, { safe: 'ok' }],
    };
    const output = redact(input) as Record<string, unknown>;
    const user = output['user'] as Record<string, unknown>;
    const profile = user['profile'] as Record<string, unknown>;
    expect(profile['apiKey']).toBe('<redacted>');
    expect(profile['name']).toBe('kenji');
    expect(output['DATABASE_URL']).toBe('<redacted>');
    const nested = output['nested'] as Array<Record<string, unknown>>;
    expect(nested[0]?.['token']).toBe('<redacted>');
    expect(nested[1]?.['safe']).toBe('ok');
  });

  it('matches sensitive key names case-insensitively', () => {
    const output = redact({
      Authorization: 'Bearer x',
      CONNECTION_STRING: 'cs',
      Password: 'pw',
      botSecret: 's',
    }) as Record<string, unknown>;
    expect(output['Authorization']).toBe('<redacted>');
    expect(output['CONNECTION_STRING']).toBe('<redacted>');
    expect(output['Password']).toBe('<redacted>');
    expect(output['botSecret']).toBe('<redacted>');
  });

  it('handles circular references without crashing', () => {
    const input: Record<string, unknown> = { name: 'loop' };
    input['self'] = input;
    const output = redact(input) as Record<string, unknown>;
    expect(output['name']).toBe('loop');
    expect(output['self']).toBe('<circular>');
  });

  it('truncates strings longer than 200 characters', () => {
    const long = 'a'.repeat(250);
    const output = redact({ text: long }) as Record<string, unknown>;
    const text = output['text'] as string;
    expect(text.endsWith('…(truncated)')).toBe(true);
    expect(text.startsWith('a'.repeat(200))).toBe(true);
    expect(text.length).toBe(200 + '…(truncated)'.length);
  });

  it('leaves short strings and numbers untouched', () => {
    const output = redact({ text: 'short', count: 42 }) as Record<string, unknown>;
    expect(output['text']).toBe('short');
    expect(output['count']).toBe(42);
  });

  it('replaces values deeper than 32 levels with <max-depth>', () => {
    let input: Record<string, unknown> = { leaf: 'bottom', secret: 'hidden' };
    for (let i = 0; i < 40; i += 1) {
      input = { level: i, child: input };
    }
    const serialized = JSON.stringify(redact(input));
    expect(serialized).toContain('<max-depth>');
    expect(serialized).not.toContain('bottom');
    expect(serialized).not.toContain('hidden');
  });

  it('does not trigger max-depth for shallow structures', () => {
    const input = { a: { b: { c: { d: 'ok' } } } };
    const output = redact(input) as Record<string, unknown>;
    const a = output['a'] as Record<string, unknown>;
    const b = a['b'] as Record<string, unknown>;
    const c = b['c'] as Record<string, unknown>;
    expect(c['d']).toBe('ok');
  });

  it('redacts custom sensitive properties on Error while keeping name and message readable', () => {
    const error = new Error('connection failed') as Error & {
      connectionString: string;
      apiKey: string;
    };
    error.connectionString = 'postgres://u:pw@h/db';
    error.apiKey = 'sk-live-123';
    const output = redact(error) as Record<string, unknown>;
    expect(output['name']).toBe('Error');
    expect(output['message']).toBe('connection failed');
    expect(output['connectionString']).toBe('<redacted>');
    expect(output['apiKey']).toBe('<redacted>');
    expect(typeof output['stack']).toBe('string');
    expect((output['stack'] as string).length).toBeLessThanOrEqual(
      200 + '…(truncated)'.length,
    );
  });

  it('redacts sensitive fields inside an Error cause chain', () => {
    const cause = new Error('pg connect error') as Error & {
      connectionString: string;
    };
    cause.connectionString = 'postgres://u:pw@h/db';
    const error = new Error('query failed', { cause });
    const output = redact(error) as Record<string, unknown>;
    expect(output['message']).toBe('query failed');
    const outputCause = output['cause'] as Record<string, unknown>;
    expect(outputCause['message']).toBe('pg connect error');
    expect(outputCause['connectionString']).toBe('<redacted>');
  });

  it('does not mark shared references as circular', () => {
    const shared = { name: 'shared', token: 'abc' };
    const output = redact({ x: shared, y: shared }) as Record<
      string,
      Record<string, unknown>
    >;
    expect(output['x']?.['name']).toBe('shared');
    expect(output['y']?.['name']).toBe('shared');
    expect(output['x']?.['token']).toBe('<redacted>');
    expect(output['y']?.['token']).toBe('<redacted>');
  });

  it('still marks true circular references as circular', () => {
    const input: Record<string, unknown> = { name: 'loop' };
    input['self'] = input;
    const output = redact(input) as Record<string, unknown>;
    expect(output['name']).toBe('loop');
    expect(output['self']).toBe('<circular>');
  });

  it('does not write Buffer contents into logs', () => {
    const secret = 'super-secret-bytes';
    const output = redact({ data: Buffer.from(secret) }) as Record<
      string,
      unknown
    >;
    expect(output['data']).toBe(`<binary:${secret.length} bytes>`);
    expect(JSON.stringify(output)).not.toContain(secret);
  });

  it('redacts sensitive properties on unknown class instances', () => {
    class PgClientConfig {
      host = 'db.internal';
      apiKey = 'sk-live-123';
      password = 'hunter2';
    }
    const output = redact({ client: new PgClientConfig() }) as Record<
      string,
      Record<string, unknown>
    >;
    expect(output['client']?.['host']).toBe('db.internal');
    expect(output['client']?.['apiKey']).toBe('<redacted>');
    expect(output['client']?.['password']).toBe('<redacted>');
  });
});
