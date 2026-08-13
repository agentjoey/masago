import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from '../../src/observability/index.js';
import { startHealthServer } from '../../src/observability/health.js';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

let close: (() => void) | undefined;

afterEach(() => {
  close?.();
  close = undefined;
});

async function start(): Promise<string> {
  // 0 番ポートで OS に空きを選ばせる。固定番号だと並行実行で衝突する。
  const server = startHealthServer({
    port: 0,
    version: '9.9.9',
    logger: silentLogger,
  });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  close = () => server.close();
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(address.port)}`;
}

describe('health server', () => {
  it('reports status and version', async () => {
    const base = await start();
    for (const path of ['/', '/health']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok', version: '9.9.9' });
    }
  });

  it('answers HEAD without a body', async () => {
    const base = await start();
    const res = await fetch(`${base}/health`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('ignores query strings', async () => {
    const base = await start();
    const res = await fetch(`${base}/health?probe=1`);
    expect(res.status).toBe(200);
  });

  it('does not answer other paths or methods', async () => {
    const base = await start();
    expect((await fetch(`${base}/secrets`)).status).toBe(404);
    expect((await fetch(`${base}/health`, { method: 'POST' })).status).toBe(405);
  });

  it('leaks no configuration or connection details', async () => {
    const base = await start();
    const body = await (await fetch(`${base}/health`)).text();
    expect(body).not.toMatch(/postgres|npg_|sk-|token|password/i);
    expect(Object.keys(JSON.parse(body) as object).sort()).toEqual([
      'status',
      'version',
    ]);
  });

  // 探针は 30 秒級で叩かれる。一度でも DB に触れば Neon の compute が
  // 一日中起きたままになり、§9.1 の見積り（月 5.6 CU-h / 上限 100）が崩れる。
  // 実装を読んで、DB へ通じる入口を持ち込んでいないことを確かめる。
  it('does not import anything that can reach the database', () => {
    const source = readFileSync('src/observability/health.ts', 'utf8');
    for (const forbidden of [
      'db/',
      'drizzle',
      'pg',
      'select',
      'repositories',
    ]) {
      expect(
        source.toLowerCase().includes(`from '${forbidden}`),
        forbidden,
      ).toBe(false);
    }
    expect(source).not.toMatch(/import .* from ['"][^'"]*\/db\//);
  });
});
