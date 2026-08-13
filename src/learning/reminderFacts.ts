import { planKanaLesson } from './kanaSession.js';
import type { Executor } from '../db/repositories/executor.js';
import * as learnerProfiles from '../db/repositories/learnerProfiles.js';
import * as reviewQueue from '../db/repositories/reviewQueue.js';
import type { ReminderFacts } from '../scheduler/reminder.js';

/**
 * リマインダの判断材料を集める。
 *
 * 一日一回だけ呼ばれる。定期ポーリングではないので、ここで数回
 * 問い合わせても Neon の compute には響かない（§9.1）。
 */
export interface ReminderFactsDeps {
  readonly executor: Executor;
  readonly telegramUserId: number;
  readonly newPerDay: number;
  readonly maxReviews: number;
  readonly backlogThreshold: number;
}

export async function collectReminderFacts(
  deps: ReminderFactsDeps,
  now: Date,
  dayStart: Date,
): Promise<ReminderFacts> {
  const learner = await learnerProfiles.findByTelegramUserId(
    deps.executor,
    deps.telegramUserId,
  );
  if (learner === undefined) {
    // まだ一度も話しかけていない人に催促はしない。
    return { dueCount: 0, newCount: 0, answeredToday: 0 };
  }

  const lesson = await planKanaLesson(deps.executor, learner.id, now, {
    newPerDay: deps.newPerDay,
    maxReviews: deps.maxReviews,
    backlogThreshold: deps.backlogThreshold,
  });
  const answeredToday = await reviewQueue.countReviewedSince(
    deps.executor,
    learner.id,
    dayStart,
  );

  return {
    dueCount: lesson.dueTotal,
    newCount: lesson.newKana.length,
    answeredToday,
  };
}
