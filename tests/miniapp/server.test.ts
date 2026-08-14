import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from '../../src/observability/index.js';
import { startMiniAppServer } from '../../src/miniapp/server.js';

const BOT_TOKEN = '123456:AAExampleTokenForTestsOnly';
const USER_ID = 7747462834;

const silentLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
} as unknown as Logger;

function signInitData(fields: Record<string, string>, token = BOT_TOKEN): string {
  const data = Object.keys(fields).sort().map((k) => `${k}=${fields[k] ?? ''}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(data).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

function validInitData(userId = USER_ID): string {
  return signInitData({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: userId, first_name: 'Y' }),
  });
}

let close: (() => void) | undefined;
afterEach(() => {
  close?.();
  close = undefined;
});

async function start(handlers?: Partial<Record<string, () => Promise<unknown>>>) {
  const calls: string[] = [];
  const make = (name: string) => async () => {
    calls.push(name);
    return (await handlers?.[name]?.()) ?? { ok: name };
  };
  const server = startMiniAppServer({
    port: 0,
    version: '9.9.9',
    kanaAudioDir: 'assets/kana-audio',
    logger: silentLogger,
    botToken: BOT_TOKEN,
    allowedTelegramUserId: USER_ID,
    handlers: {
      progress: make('progress'),
      errors: make('errors'),
      calendar: make('calendar'),
      kana: make('kana'),
      practice: async (_userId, key) => {
        calls.push(`practice:${key}`);
        return { ok: true };
      },
    },
  });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  close = () => server.close();
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${String(port)}`, calls };
}

const post = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('mini app server', () => {
  it('serves the page', async () => {
    const { base } = await start();
    const res = await fetch(base);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('MasaGo');
    // ruby の体裁が入っていること。V3 の存在理由がこれ（§4.2 の制約を外す）。
    expect(html).toContain('ruby-position');
    expect(html).toContain('rt {');
    // Telegram の WebApp SDK を読み込む（initData はここからしか取れない）
    expect(html).toContain('telegram-web-app.js');
  });

  // 探针は 30 秒級で叩いてくる。ここで DB を触ると Neon が寝なくなる（§6）。
  it('answers health without any handler doing work', async () => {
    const { base, calls } = await start();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', version: '9.9.9' });
    expect(calls).toEqual([]);
  });

  it('returns data for a properly signed request', async () => {
    const { base, calls } = await start();
    const res = await post(base, '/api/progress', { initData: validInitData() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: 'progress' });
    expect(calls).toEqual(['progress']);
  });

  // 検証を省くと user_id を書き換えるだけで他人の記録が読める。
  it('refuses an unsigned request and never runs the handler', async () => {
    const { base, calls } = await start();
    for (const body of [{}, { initData: '' }, { initData: 'user=%7B%22id%22%3A1%7D' }]) {
      const res = await post(base, '/api/progress', body);
      expect(res.status).toBe(401);
    }
    expect(calls).toEqual([]);
  });

  it('refuses a forged signature', async () => {
    const { base, calls } = await start();
    const forged = validInitData().replace(/hash=[0-9a-f]+/, `hash=${'0'.repeat(64)}`);
    expect((await post(base, '/api/progress', { initData: forged })).status).toBe(401);
    expect(calls).toEqual([]);
  });

  // 署名が本物でも、別人なら通さない（V1 は単一利用者）。
  it('refuses a valid signature from another user', async () => {
    const { base, calls } = await start();
    const other = validInitData(999);
    expect((await post(base, '/api/progress', { initData: other })).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('rejects the wrong method and unknown paths', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/api/progress`)).status).toBe(405);
    expect((await post(base, '/api/nope', {})).status).toBe(404);
  });

  it('does not leak internals when a handler throws', async () => {
    const { base } = await start({
      progress: () => Promise.reject(new Error('connection string: postgres://u:p@h/db')),
    });
    const res = await post(base, '/api/progress', { initData: validInitData() });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('postgres://');
    expect(JSON.parse(text)).toEqual({ error: 'internal' });
  });

  it('refuses an oversized body', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/progress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData: 'x'.repeat(64 * 1024) }),
    });
    expect(res.status).toBe(500);
  });

  it('serves each api route', async () => {
    const { base, calls } = await start();
    for (const path of ['/api/progress', '/api/errors', '/api/calendar', '/api/kana']) {
      const res = await post(base, path, { initData: validInitData() });
      expect(res.status, path).toBe(200);
    }
    expect(calls).toEqual(['progress', 'errors', 'calendar', 'kana']);
  });

  it('passes the item key through to practice', async () => {
    const { base, calls } = await start();
    const res = await post(base, '/api/practice', {
      initData: validInitData(),
      key: 'kana_a',
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual(['practice:kana_a']);
  });

  describe('kana audio', () => {
    it('serves a pre-generated clip', async () => {
      const { base } = await start();
      const res = await fetch(`${base}/audio/kana/a.mp3`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('audio/mpeg');
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    });

    // ここを緩めると任意のファイルを読まれる。
    it('refuses anything that is not a plain kana id', async () => {
      const { base } = await start();
      for (const path of [
        '/audio/kana/..%2F..%2Fpackage.json',
        '/audio/kana/../../package.json',
        '/audio/kana/a%2F..%2Fb.mp3',
        '/audio/kana/A.mp3',
        '/audio/kana/toolongid.mp3',
        '/audio/kana/.env',
      ]) {
        const res = await fetch(`${base}${path}`);
        expect(res.status, path).toBe(404);
      }
    });

    it('does not require auth for audio', async () => {
      const { base, calls } = await start();
      expect((await fetch(`${base}/audio/kana/ka.mp3`)).status).toBe(200);
      expect(calls).toEqual([]);
    });
  });
});
