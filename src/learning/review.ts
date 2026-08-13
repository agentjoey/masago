import {
  newCardState,
  scheduleNext,
  type ReviewCardState,
  type ReviewOutcome,
  type ReviewStateName,
} from '../curriculum/review.js';
import type { Executor } from '../db/repositories/executor.js';
import * as reviewQueue from '../db/repositories/reviewQueue.js';
import type { ReviewQueueEntry } from '../db/schema/learning.js';

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
  return reviewQueue.enqueueIfAbsent(
    tx,
    learnerId,
    knowledgeItemIds,
    toColumns(newCardState(now)),
  );
}

export interface AppliedReview {
  entry: ReviewQueueEntry;
  previousState: ReviewStateName;
}

/**
 * 一回の復習結果を反映する。キューに無ければその場で作ってから採点する
 * ——出題できた以上は項目が存在するので、無いことを理由に捨てない。
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

  const { state } = scheduleNext(current, outcome, now, requestRetention);
  const entry = await reviewQueue.saveState(
    tx,
    learnerId,
    knowledgeItemId,
    toColumns(state),
  );
  return { entry, previousState: current.state };
}
