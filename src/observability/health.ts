import { createServer, type Server } from 'node:http';
import type { Logger } from './logger.js';

/**
 * 生存確認だけを返す HTTP エンドポイント（INTERFACES.md §6）。
 *
 * **ここから DB を触ってはいけない。** `select 1` すら書かない。
 * プラットフォームの探針は 30 秒級で叩いてくるので、一度でも DB に
 * 触れば Neon の compute が一日中起きたままになり、§9.1 の見積り
 * （月 5.6 CU-h / 上限 100）が丸ごと崩れる。
 *
 * 設定・接続文字列・利用者のデータも返さない。外から誰でも叩ける。
 */
export interface HealthServerOptions {
  readonly port: number;
  readonly version: string;
  readonly logger: Logger;
}

export function startHealthServer(options: HealthServerOptions): Server {
  const body = JSON.stringify({ status: 'ok', version: options.version });

  const server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    const path = (req.url ?? '/').split('?')[0];
    if (path !== '/' && path !== '/health') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });

  server.listen(options.port, () => {
    options.logger.info('health server listening', { port: options.port });
  });

  return server;
}
