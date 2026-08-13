import {
  newCardState,
  scheduleNext,
  type ReviewCardState,
  type ReviewOutcome,
  type ReviewStateName,
} from '../curriculum/review.js';
import type { Executor } from '../db/repositories/executor.js';
import * as learningEvents from '../db/repositories/learningEvents.js';
import * as reviewQueue from '../db/repositories/reviewQueue.js';
import type { learningEventType } from '../db/schema/enums.js';
import type { ReviewQueueEntry } from '../db/schema/learning.js';

type LearningEventType = (typeof learningEventType.enumValues)[number];

/**
 * 復習の適用。純粋な計算（curriculum）と永続化（db）を繋ぐだけの層。
 *
 * この分離は形式的に見えるが、実利がある：間隔の正しさを DB 無しで検証でき、
 * DB 側は FSRS の版が上がっても書き換えずに済む。
 */

function toCardState(row: ReviewQueueEntry): ReviewCardState {
  return {
    nextReviewAt: row.nextReviewAt,
    intervalDays: row.intervalDays,
    stability: row.stability,
    difficulty: row.difficulty,
    elapsedDays: row.elapsedDays,
    learningSteps: row.learningSteps,
    reps: row.reps,
    lapses: row.lapses,
    lastReview: row.lastReview,
    state: row.state,
  };
}

function toColumns(state: ReviewCardState): reviewQueue.ReviewCardColumns {
  return {
    nextReviewAt: state.nextReviewAt,
    intervalDays: state.intervalDays,
    stability: state.stability,
    difficulty: state.difficulty,
    elapsedDays: state.elapsedDays,
    learningSteps: state.learningSteps,
    reps: state.reps,
    lapses: state.lapses,
    lastReview: state.lastReview,
    state: state.state,
  };
}

/** 新しい知識項目を復習キューに積む。既にあるものは触らない。 */
export async function enqueueNew(
  tx: Executor,
  learnerId: string,
  knowledgeItemIds: readonly string[],
  now: Date,
): Promise<number> {
  const inserted = await reviewQueue.enqueueIfAbsent(
    tx,
    learnerId,
    knowledgeItemIds,
    toColumns(newCardState(now)),
  );
  if (inserted > 0) {
    // 導入も事件として残す。「いつ習ったか」は振り返りの基準になる。
    await learningEvents.insertMany(
      tx,
      [...new Set(knowledgeItemIds)].map((knowledgeItemId) => ({
        learnerId,
        knowledgeItemId,
        eventType: 'INTRODUCED' as const,
        dedupeKey: `introduce:${learnerId}:${knowledgeItemId}`,
      })),
    );
  }
  return inserted;
}

export interface AppliedReview {
  entry: ReviewQueueEntry;
  previousState: ReviewStateName;
}

/** 答えの種類を §3.3 の事件型に対応させる。 */
function eventTypeOf(outcome: ReviewOutcome): LearningEventType {
  switch (outcome.kind) {
    case 'CORRECT':
      return 'USER_CORRECT';
    case 'SPONTANEOUS':
      return 'USED_SPONTANEOUSLY';
    case 'INCORRECT':
      return 'FAILED_RECALL';
  }
}

/**
 * 一回の復習結果を反映する。キューに無ければその場で作ってから採点する
 * ——出題できた以上は項目が存在するので、無いことを理由に捨てない。
 *
 * 併せて事件を書き残す（§3.3）。`review_queue` は**最後の一回**しか
 * 持たないので、掌握度を事件列から計算し直せるという設計は、ここが
 * 書かれて初めて成り立つ。週次の振り返りも、後で算法を差し替えて遡って
 * 計算し直すのも、履歴が無ければできない。
 *
 * 読んでから書くので、同一項目を並行に採点する場合は呼び出し側で
 * トランザクションに包むこと。`tx` を受け取るのはそのため。
 */
export async function applyReview(
  tx: Executor,
  learnerId: string,
  knowledgeItemId: string,
  outcome: ReviewOutcome,
  now: Date,
  requestRetention: number,
): Promise<AppliedReview> {
  const existing = await reviewQueue.findEntry(tx, learnerId, knowledgeItemId);
  const current =
    existing === undefined ? newCardState(now) : toCardState(existing);

  const { state, rating } = scheduleNext(current, outcome, now, requestRetention);
  const entry = await reviewQueue.saveState(
    tx,
    learnerId,
    knowledgeItemId,
    toColumns(state),
  );

  await learningEvents.insertMany(tx, [
    {
      learnerId,
      knowledgeItemId,
      eventType: eventTypeOf(outcome),
      // 同じ項目を同じ瞬間に二度採点することは無いので、これで一意。
      dedupeKey: `review:${learnerId}:${knowledgeItemId}:${now.toISOString()}`,
      evidence: {
        rating,
        reps: state.reps,
        lapses: state.lapses,
        intervalDays: state.intervalDays,
        ...(outcome.kind === 'CORRECT'
          ? { inputMode: outcome.inputMode, hinted: outcome.hinted }
          : {}),
      },
    },
  ]);

  return { entry, previousState: current.state };
}
