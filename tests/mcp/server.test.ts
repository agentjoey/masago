import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { RateLimiter, tokenMatches } from '../../src/mcp/server.js';
import { safePath, startMiniAppServer } from '../../src/miniapp/server.js';

const TOKEN = 'x'.repeat(64);
const BOT_TOKEN = 'test-bot-token';
const USER_ID = 4242;

const logged: { level: string; fields: unknown }[] = [];
const capturingLogger = {
  info: (_m: string, f?: unknown) => logged.push({ level: 'info', fields: f }),
  warn: (_m: string, f?: unknown) => logged.push({ level: 'warn', fields: f }),
  error: (_m: string, f?: unknown) => logged.push({ level: 'error', fields: f }),
  debug: () => {},
} as never;

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
  logged.length = 0;
});

function start(withMcp: boolean): Promise<string> {
  const data = {
    progress: () => Promise.resolve({ kana: { introduced: 10 } }),
    today: () => Promise.resolve({ newKana: ['あ'] }),
    errors: () => Promise.resolve([]),
    report: () => Promise.resolve({ answered: 12 }),
    itemState: () => Promise.resolve(undefined),
  };
  server = startMiniAppServer({
    port: 0,
    version: '9.9.9',
    kanaAudioDir: 'assets/kana-audio',
    logger: capturingLogger,
    botToken: BOT_TOKEN,
    allowedTelegramUserId: USER_ID,
    ...(withMcp
      ? {
          mcp: {
            token: TOKEN,
            ratePerMinute: 30,
            baseUrl: 'https://example.test/app',
            data,
          },
        }
      : {}),
    handlers: {
      progress: () => Promise.resolve({}),
      errors: () => Promise.resolve({}),
      calendar: () => Promise.resolve({}),
      kana: () => Promise.resolve({}),
      cost: () => Promise.resolve({}),
      practice: () => Promise.resolve({}),
      reading: () => Promise.resolve({}),
      readingAnswer: () => Promise.resolve({}),
    },
  });
  return new Promise((resolve) => {
    server?.on('listening', () => {
      const address = server?.address() as AddressInfo;
      resolve(`http://127.0.0.1:${String(address.port)}`);
    });
  });
}

/** MCP の初期化要求。これが通れば工具一覧まで進める。 */
function initialize(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    },
  });
}

async function post(url: string, body: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body,
  });
}

describe('tokenMatches', () => {
  it('accepts only the exact token', () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(tokenMatches(TOKEN.slice(0, -1), TOKEN)).toBe(false);
    expect(tokenMatches(`y${TOKEN.slice(1)}`, TOKEN)).toBe(false);
  });

  /** 鍵が未設定のとき空文字で通ってはいけない。 */
  it('never accepts an empty expected token', () => {
    expect(tokenMatches('', '')).toBe(false);
    expect(tokenMatches('anything', '')).toBe(false);
  });
});

describe('RateLimiter', () => {
  it('allows up to the limit inside the window', () => {
    const limiter = new RateLimiter(3);
    expect(limiter.allow(1000)).toBe(true);
    expect(limiter.allow(1001)).toBe(true);
    expect(limiter.allow(1002)).toBe(true);
    expect(limiter.allow(1003)).toBe(false);
  });

  it('lets requests through again once the window has passed', () => {
    const limiter = new RateLimiter(2);
    expect(limiter.allow(0)).toBe(true);
    expect(limiter.allow(1)).toBe(true);
    expect(limiter.allow(2)).toBe(false);
    expect(limiter.allow(60_001)).toBe(true);
  });
});

describe('safePath', () => {
  /**
   * 能力 URL 方式の唯一にして最大の弱点。`redact.ts` は鍵の**名前**で
   * 消すので、パスに混ざった値は捕まえられない。
   */
  it('masks the token in a path before it reaches the log', () => {
    expect(safePath(`/mcp/${TOKEN}`)).toBe('/mcp/<redacted>');
    expect(safePath(`/mcp/${TOKEN}/sse`)).toBe('/mcp/<redacted>');
  });

  it('leaves other paths alone', () => {
    expect(safePath('/api/progress')).toBe('/api/progress');
    expect(safePath('/health')).toBe('/health');
  });
});

describe('MCP over HTTP', () => {
  it('answers initialize on the token path', async () => {
    const base = await start(true);
    const response = await post(`${base}/mcp/${TOKEN}`, initialize());
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('masago');
  });

  it('serves the sse path too', async () => {
    const base = await start(true);
    const response = await post(`${base}/mcp/${TOKEN}/sse`, initialize());
    expect(response.status).toBe(200);
  });

  it('is a 404 with the wrong token, not a 401', async () => {
    const base = await start(true);
    const response = await post(`${base}/mcp/${'y'.repeat(64)}`, initialize());
    // 401 だと「鍵さえ合えば何かある」と教えることになる。
    expect(response.status).toBe(404);
  });

  it('never writes the token to the log', async () => {
    const base = await start(true);
    await post(`${base}/mcp/${'y'.repeat(64)}`, initialize());
    const serialized = JSON.stringify(logged);
    expect(serialized).not.toContain('y'.repeat(64));
    expect(serialized).toContain('<redacted>');
  });

  /** 鍵が未設定なら入口ごと出さない。 */
  it('is absent when no token is configured', async () => {
    const base = await start(false);
    const response = await post(`${base}/mcp/${TOKEN}`, initialize());
    expect(response.status).toBe(404);
  });

  it('turns away a flood with 429', async () => {
    const base = await start(true);
    const codes: number[] = [];
    for (let i = 0; i < 34; i += 1) {
      const response = await post(`${base}/mcp/${TOKEN}`, initialize());
      codes.push(response.status);
      await response.text();
    }
    expect(codes.filter((code) => code === 429).length).toBeGreaterThan(0);
    expect(codes.filter((code) => code === 200).length).toBe(30);
  });

  it('leaves the health check untouched', async () => {
    const base = await start(true);
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', version: '9.9.9' });
  });
});

describe('MCP を本物の客户端から通す', () => {
  /**
   * 手書きの JSON-RPC ではなく SDK の客户端で通す。ChatGPT が使うのも
   * 同じ実装なので、握手やヘッダの細部を取り違えていればここで落ちる。
   */
  async function connect(base: string) {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/streamableHttp.js'
    );
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp/${TOKEN}`)),
    );
    return client;
  }

  it('lists exactly the six read-only tools', async () => {
    const base = await start(true);
    const client = await connect(base);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'fetch',
      'get_errors',
      'get_progress',
      'get_report',
      'get_today',
      'search',
    ]);
    // 書く工具が紛れ込んでいないこと（§11）。
    for (const tool of tools) {
      expect(tool.name).not.toMatch(/create|update|delete|record|mark|set_/);
    }
    await client.close();
  });

  it('runs search and returns ids that fetch understands', async () => {
    const base = await start(true);
    const client = await connect(base);

    const found = (await client.callTool({
      name: 'search',
      arguments: { query: '医者' },
    })) as { structuredContent?: { results?: { id: string }[] } };
    const first = found.structuredContent?.results?.[0];
    expect(first?.id).toBe('vocab:医者#いしゃ');

    const detail = (await client.callTool({
      name: 'fetch',
      arguments: { id: first?.id ?? '' },
    })) as { structuredContent?: { text?: string } };
    expect(detail.structuredContent?.text).toContain('doctor');
    // 学習状態は DB 由来。テストのスタブは undefined を返す。
    expect(detail.structuredContent?.text).toContain('还没学过');
    await client.close();
  });

  it('returns the same numbers the rest of the app uses', async () => {
    const base = await start(true);
    const client = await connect(base);
    const progress = (await client.callTool({
      name: 'get_progress',
      arguments: {},
    })) as { structuredContent?: { kana?: { introduced?: number } } };
    expect(progress.structuredContent?.kana?.introduced).toBe(10);
    await client.close();
  });

  it('answers fetch for an unknown id instead of failing the call', async () => {
    const base = await start(true);
    const client = await connect(base);
    const detail = (await client.callTool({
      name: 'fetch',
      arguments: { id: 'kana:zzz' },
    })) as { structuredContent?: { text?: string } };
    expect(detail.structuredContent?.text).toContain('没有这个条目');
    await client.close();
  });
});
