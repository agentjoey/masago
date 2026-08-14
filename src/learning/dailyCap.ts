import type { Executor } from '../db/repositories/executor.js';
import * as learningEvents from '../db/repositories/learningEvents.js';

/**
 * 「今日まだ出してよい新出の数」（§2.5）。
 *
 * 上限は「一回の呼び出しで出す数」ではなく「その日に出した総数」で効かせる。
 * 前者だと `/kana` を五回叩けば五日分が一日で入り、翌日以降の復習が
 * 雪だるまになる（実測で確認済み）。
 *
 * ここに一本化した理由：bot 側（kanaCommands）と MCP 側（app.ts）が
 * 別々に計算していて、**MCP の get_today だけ上限を見ていなかった**。
 * ChatGPT は「新しい仮名 5 個」と言い、bot の /today は「今日はもう終わり」
 * と言う——同じ質問に違う答えが出る。数え方は一箇所に置く
 * （語彙の分母・活動の数え方に続いて三度目の教訓）。
 */

export type CappedType = 'KANA' | 'VOCABULARY' | 'GRAMMAR';

export interface DailyCapOptions {
  readonly newPerDay: number;
  /** 学習者の地域時間での「その日の 0 時」。無ければ上限は一回あたり。 */
  readonly dayStart?: (now: Date) => Date;
}

export async function remainingNewToday(
  executor: Executor,
  learnerId: string,
  now: Date,
  type: CappedType,
  options: DailyCapOptions,
): Promise<number> {
  if (options.dayStart === undefined) return options.newPerDay;
  const already = await learningEvents.countIntroducedSince(
    executor,
    learnerId,
    options.dayStart(now),
    type,
  );
  return Math.max(0, options.newPerDay - already);
}
