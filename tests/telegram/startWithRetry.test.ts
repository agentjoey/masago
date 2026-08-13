import type { Bot } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../../src/telegram/bot.js';
import { startWithRetry } from '../../src/telegram/startWithRetry.js';
import { fakeLogger } from './helpers.js';

/** grammy の Bot を、start だけ差し替えた最小の代役で表す。 */
function botThatFails(
  errors: readonly unknown[],
): { bot: Bot<AppContext>; attempts: () => number } {
  let attempt = 0;
  const bot = {
    start: async (opts?: { onStart?: (me: { username: string }) => void }) => {
      const error = errors[attempt];
      attempt += 1;
      if (error !== undefined) throw error;
      opts?.onStart?.({ username: 'masa_go_bot' });
      return Promise.resolve();
    },
  } as unknown as Bot<AppContext>;
  return { bot, attempts: () => attempt };
}

const conflict = (): Error =>
  Object.assign(
    new Error(
      "Call to 'getUpdates' failed! (409: Conflict: terminated by other getUpdates request; make sure that only one bot instance is running)",
    ),
    { error_code: 409 },
  );

const noSleep = (): Promise<void> => Promise.resolve();

describe('startWithRetry', () => {
  it('starts normally when there is no conflict', async () => {
    const { bot, attempts } = botThatFails([]);
    const onStart = vi.fn();
    await startWithRetry(bot, { logger: fakeLogger(), sleep: noSleep, onStart });
    expect(attempts()).toBe(1);
    expect(onStart).toHaveBeenCalledWith('masa_go_bot');
  });

  // 入れ替わりの数秒だけ二重になる。ここで落ちると再起動の予算を食う。
  it('waits out a transient conflict and takes over', async () => {
    const { bot, attempts } = botThatFails([conflict(), conflict()]);
    const onStart = vi.fn();
    await startWithRetry(bot, { logger: fakeLogger(), sleep: noSleep, onStart });
    expect(attempts()).toBe(3);
    expect(onStart).toHaveBeenCalledOnce();
  });

  it('backs off further on each attempt', async () => {
    const delays: number[] = [];
    const { bot } = botThatFails([conflict(), conflict(), conflict()]);
    await startWithRetry(bot, {
      logger: fakeLogger(),
      baseDelayMs: 100,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });
    expect(delays).toEqual([100, 200, 300]);
  });

  // 本当に二つ動いているなら譲り合っても解決しない。永遠に粘らない。
  it('gives up after the last attempt and rethrows', async () => {
    const { bot, attempts } = botThatFails(
      Array.from({ length: 10 }, () => conflict()),
    );
    await expect(
      startWithRetry(bot, {
        logger: fakeLogger(),
        maxAttempts: 3,
        sleep: noSleep,
      }),
    ).rejects.toThrow(/409/);
    expect(attempts()).toBe(3);
  });

  // 409 以外を飲み込むと、設定ミスや失効したトークンが黙って再試行され続ける。
  it('does not retry anything other than a conflict', async () => {
    const { bot, attempts } = botThatFails([
      Object.assign(new Error('Unauthorized'), { error_code: 401 }),
    ]);
    await expect(
      startWithRetry(bot, { logger: fakeLogger(), sleep: noSleep }),
    ).rejects.toThrow(/Unauthorized/);
    expect(attempts()).toBe(1);
  });

  it('recognises a conflict reported only in the message', async () => {
    const { bot, attempts } = botThatFails([
      new Error('HttpError: 409: Conflict: terminated by other getUpdates'),
    ]);
    await startWithRetry(bot, { logger: fakeLogger(), sleep: noSleep });
    expect(attempts()).toBe(2);
  });

  it('is not confused by a 409 mentioned in an unrelated message', async () => {
    const { bot } = botThatFails([new Error('request id 409 timed out')]);
    await expect(
      startWithRetry(bot, { logger: fakeLogger(), sleep: noSleep }),
    ).rejects.toThrow(/timed out/);
  });
});
