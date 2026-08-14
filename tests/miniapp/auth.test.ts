import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyInitData } from '../../src/miniapp/auth.js';

const BOT_TOKEN = '123456:AAExampleTokenForTestsOnly';

/** Telegram と同じ手順で署名した initData を作る。 */
function signInitData(
  fields: Record<string, string>,
  token = BOT_TOKEN,
): string {
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key] ?? ''}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  const params = new URLSearchParams({ ...fields, hash });
  return params.toString();
}

const NOW = new Date('2026-08-14T12:00:00Z');
const authDate = String(Math.floor(NOW.getTime() / 1000) - 60);
const user = JSON.stringify({ id: 7747462834, first_name: 'Y', username: 'y' });

describe('verifyInitData', () => {
  it('accepts data signed with the real bot token', () => {
    const initData = signInitData({ auth_date: authDate, user, query_id: 'q' });
    const result = verifyInitData(initData, { botToken: BOT_TOKEN, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.id).toBe(7747462834);
    expect(result.user.username).toBe('y');
  });

  // ここが唯一の鍵。通ってしまうと user_id を書き換えるだけで他人の記録が読める。
  it('rejects a forged hash', () => {
    const initData = signInitData({ auth_date: authDate, user });
    const forged = initData.replace(/hash=[0-9a-f]+/, `hash=${'0'.repeat(64)}`);
    const result = verifyInitData(forged, { botToken: BOT_TOKEN, now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('BAD_SIGNATURE');
  });

  it('rejects data signed with a different token', () => {
    const initData = signInitData({ auth_date: authDate, user }, 'other:token');
    const result = verifyInitData(initData, { botToken: BOT_TOKEN, now: NOW });
    expect(result.ok).toBe(false);
  });

  // 署名は本物のまま user だけ差し替える攻撃。data_check_string に user が
  // 含まれるので署名が合わなくなる——それを実際に確かめる。
  it('rejects a tampered user id even with an otherwise valid signature', () => {
    const initData = signInitData({ auth_date: authDate, user });
    const tampered = initData.replace(
      encodeURIComponent('7747462834'),
      encodeURIComponent('999'),
    );
    const result = verifyInitData(tampered, { botToken: BOT_TOKEN, now: NOW });
    expect(result.ok).toBe(false);
  });

  it('rejects missing hash', () => {
    const result = verifyInitData('auth_date=1&user=%7B%7D', {
      botToken: BOT_TOKEN,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('MISSING_HASH');
  });

  // 盗まれた initData をいつまでも使い回せるのは困る。
  it('rejects data that is too old', () => {
    const old = String(Math.floor(NOW.getTime() / 1000) - 48 * 3600);
    const initData = signInitData({ auth_date: old, user });
    const result = verifyInitData(initData, { botToken: BOT_TOKEN, now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('EXPIRED');
  });

  it('honours a custom max age', () => {
    const old = String(Math.floor(NOW.getTime() / 1000) - 3600);
    const initData = signInitData({ auth_date: old, user });
    expect(
      verifyInitData(initData, {
        botToken: BOT_TOKEN,
        now: NOW,
        maxAgeMs: 30 * 60_000,
      }).ok,
    ).toBe(false);
    expect(
      verifyInitData(initData, {
        botToken: BOT_TOKEN,
        now: NOW,
        maxAgeMs: 2 * 3600_000,
      }).ok,
    ).toBe(true);
  });

  it('rejects data with no user', () => {
    const initData = signInitData({ auth_date: authDate, query_id: 'q' });
    const result = verifyInitData(initData, { botToken: BOT_TOKEN, now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('MISSING_USER');
  });

  it('rejects malformed user json', () => {
    const initData = signInitData({ auth_date: authDate, user: 'not json' });
    const result = verifyInitData(initData, { botToken: BOT_TOKEN, now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('MALFORMED');
  });

  it('rejects an empty string', () => {
    expect(verifyInitData('', { botToken: BOT_TOKEN, now: NOW }).ok).toBe(false);
  });

  // 署名対象はキー昇順で連結する。順序が変わっても署名は同じでなければならない。
  it('does not depend on the order fields arrive in', () => {
    const fields = { auth_date: authDate, user, query_id: 'q' };
    const signed = signInitData(fields);
    const params = new URLSearchParams(signed);
    const reordered = new URLSearchParams();
    for (const key of ['hash', 'user', 'query_id', 'auth_date']) {
      const value = params.get(key);
      if (value !== null) reordered.append(key, value);
    }
    expect(
      verifyInitData(reordered.toString(), { botToken: BOT_TOKEN, now: NOW }).ok,
    ).toBe(true);
  });
});
