import { kanaOfKey } from '../curriculum/kana.js';
import {
  kanaProgress,
  planLesson,
  taughtPool,
  type LessonPlan,
} from '../curriculum/lessonPlan.js';
import type { Kana } from '../curriculum/kana.js';
import type { ReviewOutcome } from '../curriculum/review.js';
import type { Executor } from '../db/repositories/executor.js';
import * as reviewQueue from '../db/repositories/reviewQueue.js';
import { resolveKanaItemIds } from './kanaSeed.js';
import { applyReview, enqueueNew, type AppliedReview } from './review.js';

/**
 * S0（五十音）の一日分を組み立てる。
 *
 * 「導入済み」は復習キューに居ることで表す。別に導入フラグを持つと、
 * キューと二重管理になっていつか食い違う。
 */

const KANA_TYPE = 'KANA' as const;

export interface KanaLessonOptions {
  readonly newPerDay: number;
  readonly maxReviews: number;
  readonly backlogThreshold: number;
}

export interface KanaLesson extends LessonPlan {
  /** 誤答の候補に使える範囲＝導入済みの仮名。 */
  readonly pool: readonly Kana[];
  readonly progress: { introduced: number; total: number };
  /** 上限で切る前の、期日到来の総数。 */
  readonly dueTotal: number;
}

export async function planKanaLesson(
  tx: Executor,
  learnerId: string,
  now: Date,
  options: KanaLessonOptions,
): Promise<KanaLesson> {
  const introducedKeys = await reviewQueue.listIntroducedKeys(
    tx,
    learnerId,
    KANA_TYPE,
  );
  const introducedIds = introducedKeys
    .map((key) => kanaOfKey(key)?.id)
    .filter((id): id is string => id !== undefined);

  // 表示上限とは別に総数を数える。上限で切った数で判断すると、
  // どれだけ溜まっても「まだ余裕がある」と読めてしまう。
  const dueTotal = await reviewQueue.countDue(tx, learnerId, now, KANA_TYPE);
  const due = await reviewQueue.listDue(
    tx,
    learnerId,
    now,
    Math.max(options.maxReviews, options.backlogThreshold + 1),
    KANA_TYPE,
  );
  const dueIds = due
    .map((item) => kanaOfKey(item.knowledgeKey)?.id)
    .filter((id): id is string => id !== undefined);

  const plan = planLesson({
    introducedIds,
    dueIds,
    newPerDay: options.newPerDay,
    maxReviews: options.maxReviews,
    backlogThreshold: options.backlogThreshold,
  });

  return {
    ...plan,
    pool: taughtPool(introducedIds),
    progress: kanaProgress(introducedIds),
    dueTotal,
  };
}

/**
 * 新しく導入した仮名を復習キューに載せる。
 *
 * 教えた直後に呼ぶ。ここを通らないと「導入済み」にならず、翌日も
 * 同じ行が新出として出続ける。
 */
export async function introduceKana(
  tx: Executor,
  learnerId: string,
  kanaIds: readonly string[],
  now: Date,
): Promise<number> {
  if (kanaIds.length === 0) return 0;
  const itemIds = await resolveKanaItemIds(tx, kanaIds);
  const missing = kanaIds.filter((id) => !itemIds.has(id));
  if (missing.length > 0) {
    throw new Error(
      `kana not seeded in knowledge_items: ${missing.join(', ')} — run ensureKanaSeeded first`,
    );
  }
  return enqueueNew(tx, learnerId, [...itemIds.values()], now);
}

/** 一問分の結果を記録する。 */
export async function recordKanaAnswer(
  tx: Executor,
  learnerId: string,
  kanaId: string,
  outcome: ReviewOutcome,
  now: Date,
  requestRetention: number,
): Promise<AppliedReview> {
  const itemIds = await resolveKanaItemIds(tx, [kanaId]);
  const itemId = itemIds.get(kanaId);
  if (itemId === undefined) {
    throw new Error(`kana not seeded in knowledge_items: ${kanaId}`);
  }
  return applyReview(tx, learnerId, itemId, outcome, now, requestRetention);
}
