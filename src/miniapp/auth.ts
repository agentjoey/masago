import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Telegram Mini App の `initData` 検証（V3）。
 *
 * Mini App は普通の Web ページなので、URL さえ知れば誰でも開ける。
 * 「誰として開いているか」は Telegram が署名した `initData` でしか
 * 分からない——**検証を省くと、user_id を書き換えるだけで他人の学習記録が
 * 読める**。ここは飾りではなく唯一の鍵。
 *
 * 手順（Telegram の仕様）:
 *   1. `hash` を取り除いた残りを `key=value` にして改行で連結（キー昇順）
 *   2. 署名鍵は `HMAC_SHA256("WebAppData", bot_token)`
 *   3. その鍵で 1 を HMAC_SHA256 し、`hash` と一致するか見る
 *
 * 鍵が `HMAC(定数, トークン)` であって `HMAC(トークン, 定数)` ではない点に
 * 注意。逆にすると常に検証が通らない。
 */

export interface InitDataUser {
  readonly id: number;
  readonly firstName?: string;
  readonly username?: string;
  readonly languageCode?: string;
}

export type VerifyResult =
  | { readonly ok: true; readonly user: InitDataUser; readonly authDate: Date }
  | { readonly ok: false; readonly reason: VerifyFailure };

export type VerifyFailure =
  | 'MISSING_HASH'
  | 'BAD_SIGNATURE'
  | 'EXPIRED'
  | 'MISSING_USER'
  | 'MALFORMED';

export interface VerifyOptions {
  readonly botToken: string;
  /** これより古い initData は拒否する。既定 24 時間。 */
  readonly maxAgeMs?: number;
  readonly now?: Date;
}

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    // 長さが違えば Buffer 長も違い timingSafeEqual が投げる。上で弾いてある。
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

export function verifyInitData(
  initData: string,
  options: VerifyOptions,
): VerifyResult {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }

  const hash = params.get('hash');
  if (hash === null || hash === '') {
    return { ok: false, reason: 'MISSING_HASH' };
  }

  // hash 以外を キー昇順で連結する。並び順が違うと署名は一致しない。
  const pairs: string[] = [];
  for (const [key, value] of [...params.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (key === 'hash') continue;
    pairs.push(`${key}=${value}`);
  }
  const dataCheckString = pairs.join('\n');

  // 署名鍵は HMAC("WebAppData", token)。引数の順を逆にすると必ず外れる。
  const secret = createHmac('sha256', 'WebAppData')
    .update(options.botToken)
    .digest();
  const expected = createHmac('sha256', secret)
    .update(dataCheckString)
    .digest('hex');

  if (!safeEqualHex(expected, hash)) {
    return { ok: false, reason: 'BAD_SIGNATURE' };
  }

  // 署名が正しくても古いものは受けない。盗まれた initData を
  // いつまでも使い回せてしまう。
  const authDateRaw = params.get('auth_date');
  const authDateSeconds = Number.parseInt(authDateRaw ?? '', 10);
  if (Number.isNaN(authDateSeconds)) {
    return { ok: false, reason: 'MALFORMED' };
  }
  const authDate = new Date(authDateSeconds * 1000);
  const now = options.now ?? new Date();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  if (now.getTime() - authDate.getTime() > maxAgeMs) {
    return { ok: false, reason: 'EXPIRED' };
  }

  const userRaw = params.get('user');
  if (userRaw === null) {
    return { ok: false, reason: 'MISSING_USER' };
  }
  let parsed: { id?: unknown; first_name?: unknown; username?: unknown; language_code?: unknown };
  try {
    parsed = JSON.parse(userRaw) as typeof parsed;
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
  if (typeof parsed.id !== 'number') {
    return { ok: false, reason: 'MISSING_USER' };
  }

  return {
    ok: true,
    authDate,
    user: {
      id: parsed.id,
      ...(typeof parsed.first_name === 'string'
        ? { firstName: parsed.first_name }
        : {}),
      ...(typeof parsed.username === 'string'
        ? { username: parsed.username }
        : {}),
      ...(typeof parsed.language_code === 'string'
        ? { languageCode: parsed.language_code }
        : {}),
    },
  };
}
