import type { Bot } from 'grammy';
import type { Logger } from '../observability/index.js';
import type { AppContext } from './bot.js';

/**
 * `getUpdates` の 409 を、落ちずに待って取り返す。
 *
 * Telegram の長轮询は同時に一つの実例しか許さない。一方 Railway は
 * 新しいコンテナがヘルスチェックを通ってから古いほうを止めるので、
 * 入れ替わりの数秒は必ず二重になる——構造上避けられない。
 *
 * 既定の挙動は「起動失敗として落ちる」で、復帰は Railway の再起動策に
 * 委ねていた。自愈はするが、再起動の回数は有限（10 回）。うっかり
 * ローカルでもう一つ動かした日には、その予算を使い切ってサービスごと
 * 落ちる。ここで待てば、一時的な重複は再起動を消費せずに解ける。
 *
 * ただし無限には待たない。本当に二つ動いているなら、譲り合っても
 * 解決しないので、諦めて異常終了し、外側の判断に委ねる。
 */
export const CONFLICT_STATUS = 409;

export interface StartWithRetryOptions {
  readonly logger: Logger;
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onStart?: (username: string) => void;
}

function isConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { error_code?: unknown; message?: unknown };
  if (candidate.error_code === CONFLICT_STATUS) return true;
  // grammy は HttpError などで包むことがあるため、文面でも拾う。
  return (
    typeof candidate.message === 'string' &&
    candidate.message.includes('409') &&
    candidate.message.includes('Conflict')
  );
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function startWithRetry(
  bot: Bot<AppContext>,
  options: StartWithRetryOptions,
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? 6;
  const baseDelayMs = options.baseDelayMs ?? 2_000;
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await bot.start({
        onStart: (me) => {
          options.onStart?.(me.username);
        },
      });
      return;
    } catch (error) {
      if (!isConflict(error) || attempt === maxAttempts) {
        throw error;
      }
      const delayMs = baseDelayMs * attempt;
      options.logger.warn('another instance is polling; waiting to take over', {
        attempt,
        maxAttempts,
        delayMs,
      });
      await sleep(delayMs);
    }
  }
}
