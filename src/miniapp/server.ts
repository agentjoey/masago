import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Logger } from '../observability/index.js';
import { verifyInitData } from './auth.js';
import { renderPage } from './page.js';

/**
 * Mini App と健康確認を同じポートで出す（V3）。
 *
 * **`/health` は DB を触らない**（INTERFACES.md §6）。探針は 30 秒級で
 * 叩いてくるので、ここで問い合わせると Neon の compute が一日中起きたまま
 * になる。Mini App の API は利用者が開いた時だけ動くので DB を読んでよい。
 */

export interface MiniAppHandlers {
  progress(telegramUserId: number): Promise<unknown>;
  errors(telegramUserId: number): Promise<unknown>;
  calendar(telegramUserId: number): Promise<unknown>;
  /** 五十音図と、各字の学習状態。 */
  kana(telegramUserId: number): Promise<unknown>;
  /** 「これをもう一度」。期日を今にする。 */
  practice(telegramUserId: number, knowledgeKey: string): Promise<unknown>;
  /** 読解の一問。ruby の段と場面を受け取る。 */
  reading(
    telegramUserId: number,
    level: string,
    sceneId: string | undefined,
  ): Promise<unknown>;
  /** 読解の採点。正解を前端に渡さないため後端で判定する。 */
  readingAnswer(
    telegramUserId: number,
    targetId: string,
    chosenId: string,
  ): Promise<unknown>;
}

export interface MiniAppServerOptions {
  readonly port: number;
  /** 事前生成した仮名音声の置き場。Mini App から直接再生する。 */
  readonly kanaAudioDir: string;
  readonly version: string;
  readonly logger: Logger;
  readonly botToken: string;
  /** この利用者以外は拒否する。V1 は単一利用者（§10）。 */
  readonly allowedTelegramUserId: number;
  readonly handlers: MiniAppHandlers;
}

const MAX_BODY_BYTES = 16 * 1024;

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    // 上限を切らないと、大きな本文を投げるだけでメモリを食わせられる。
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function send(
  res: ServerResponse,
  status: number,
  body: string,
  contentType: string,
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    // Mini App は Telegram の webview 内でのみ開く。外から埋め込ませない。
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
}

export function startMiniAppServer(options: MiniAppServerOptions): Server {
  const healthBody = JSON.stringify({ status: 'ok', version: options.version });

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const method = req.method ?? 'GET';

    void (async () => {
      try {
        // 健康確認。DB を触らないこと（§6）。
        if (path === '/health' || path === '/healthz') {
          if (method !== 'GET' && method !== 'HEAD') {
            send(res, 405, '', 'text/plain');
            return;
          }
          send(res, 200, method === 'HEAD' ? '' : healthBody, 'application/json');
          return;
        }

        if (path === '/' || path === '/app') {
          if (method !== 'GET') {
            send(res, 405, '', 'text/plain');
            return;
          }
          send(res, 200, renderPage(), 'text/html; charset=utf-8');
          return;
        }

        // 仮名の音声。事前生成済みの静的ファイルで、秘密は含まない。
        if (path.startsWith('/audio/kana/')) {
          if (method !== 'GET' && method !== 'HEAD') {
            send(res, 405, '', 'text/plain');
            return;
          }
          await serveKanaAudio(res, path, options);
          return;
        }

        const route = API_ROUTES[path];
        if (route === undefined) {
          send(res, 404, JSON.stringify({ error: 'not found' }), 'application/json');
          return;
        }
        if (method !== 'POST') {
          send(res, 405, JSON.stringify({ error: 'use POST' }), 'application/json');
          return;
        }

        const body = (await readJson(req)) as { initData?: unknown };
        const initData = typeof body.initData === 'string' ? body.initData : '';

        // ここが唯一の鍵。省くと user_id を書き換えるだけで他人の記録が読める。
        const verified = verifyInitData(initData, {
          botToken: options.botToken,
        });
        if (!verified.ok) {
          options.logger.warn('mini app rejected an unverified request', {
            reason: verified.reason,
            path,
          });
          send(res, 401, JSON.stringify({ error: 'unauthorized' }), 'application/json');
          return;
        }
        if (verified.user.id !== options.allowedTelegramUserId) {
          send(res, 403, JSON.stringify({ error: 'forbidden' }), 'application/json');
          return;
        }

        const payload = await route(
          options.handlers,
          verified.user.id,
          body as Record<string, unknown>,
        );
        send(res, 200, JSON.stringify(payload), 'application/json');
      } catch (error) {
        options.logger.error('mini app request failed', { path, error });
        send(res, 500, JSON.stringify({ error: 'internal' }), 'application/json');
      }
    })();
  });

  server.listen(options.port, () => {
    options.logger.info('mini app server listening', { port: options.port });
  });

  return server;
}

const API_ROUTES: Record<
  string,
  (
    handlers: MiniAppHandlers,
    userId: number,
    body: Record<string, unknown>,
  ) => Promise<unknown>
> = {
  '/api/progress': (handlers, userId) => handlers.progress(userId),
  '/api/errors': (handlers, userId) => handlers.errors(userId),
  '/api/calendar': (handlers, userId) => handlers.calendar(userId),
  '/api/kana': (handlers, userId) => handlers.kana(userId),
  '/api/practice': (handlers, userId, body) =>
    handlers.practice(
      userId,
      typeof body['key'] === 'string' ? body['key'] : '',
    ),
  '/api/reading': (handlers, userId, body) =>
    handlers.reading(
      userId,
      typeof body['level'] === 'string' ? body['level'] : 'ALL',
      typeof body['scene'] === 'string' && body['scene'] !== ''
        ? body['scene']
        : undefined,
    ),
  '/api/reading/answer': (handlers, userId, body) =>
    handlers.readingAnswer(
      userId,
      typeof body['target'] === 'string' ? body['target'] : '',
      typeof body['chosen'] === 'string' ? body['chosen'] : '',
    ),
};

/** 仮名 id は英小文字のみ。これを緩めるとパスを遡られる。 */
const KANA_ID = /^[a-z]{1,3}$/;

async function serveKanaAudio(
  res: ServerResponse,
  path: string,
  options: MiniAppServerOptions,
): Promise<void> {
  const name = path.slice('/audio/kana/'.length);
  const id = name.endsWith('.mp3') ? name.slice(0, -4) : name;
  // 厳しく検査する。`..` やスラッシュを通すと任意のファイルを読まれる。
  if (!KANA_ID.test(id)) {
    send(res, 404, '', 'text/plain');
    return;
  }
  const file = join(options.kanaAudioDir, `${id}.mp3`);
  try {
    const bytes = await readFile(file);
    res.writeHead(200, {
      'content-type': 'audio/mpeg',
      'content-length': String(bytes.byteLength),
      // 音声は不変。長く持たせてよい。
      'cache-control': 'public, max-age=31536000, immutable',
    });
    res.end(bytes);
  } catch {
    send(res, 404, '', 'text/plain');
  }
}
