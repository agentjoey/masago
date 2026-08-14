import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { kanaOfKey } from '../curriculum/kana.js';
import { kanaProgress } from '../curriculum/lessonPlan.js';
import {
  currentVocabLevel,
  vocabProgress,
  vocabProgressByLevel,
} from '../curriculum/stage.js';
import { vocabOfKey } from '../curriculum/vocab.js';
import type { Executor } from '../db/repositories/executor.js';
import * as learnerProfiles from '../db/repositories/learnerProfiles.js';
import * as reviewQueue from '../db/repositories/reviewQueue.js';
import {
  detectedIssues,
  learningEvents,
  reviewQueue as reviewQueueTable,
  sessions,
} from '../db/schema/index.js';
import { localDateKey } from '../scheduler/index.js';

/**
 * Mini App が読むデータ（V3）。**同じ後端を使い回す**——出題も進度も
 * 一つの真実から出す。ここで別集計を作ると、bot と Mini App で
 * 違う数字が出る。
 */

export interface ProgressPayload {
  readonly kana: { introduced: number; total: number; due: number };
  readonly vocab: {
    introduced: number;
    total: number;
    due: number;
    level: string;
    levelIntroduced: number;
    levelTotal: number;
  };
  readonly activity: readonly { day: string; count: number }[];
  readonly streak: number;
}

export interface ErrorEntry {
  readonly id: string;
  readonly original: string;
  readonly recommended: string;
  readonly reason: string | null;
  readonly knowledgeKey: string;
  readonly source: string;
  readonly at: string;
}

export interface CalendarDay {
  readonly day: string;
  readonly due: number;
}

async function introducedIds(
  tx: Executor,
  learnerId: string,
  type: 'KANA' | 'VOCABULARY',
): Promise<string[]> {
  const keys = await reviewQueue.listIntroducedKeys(tx, learnerId, type);
  return keys
    .map((key) => (type === 'KANA' ? kanaOfKey(key)?.id : vocabOfKey(key)?.id))
    .filter((id): id is string => id !== undefined);
}

export async function loadProgress(
  tx: Executor,
  learnerId: string,
  now: Date,
  timeZone: string,
): Promise<ProgressPayload> {
  const kanaIds = await introducedIds(tx, learnerId, 'KANA');
  const vocabIds = await introducedIds(tx, learnerId, 'VOCABULARY');
  const level = currentVocabLevel(vocabIds);

  const [kanaDue, vocabDue] = await Promise.all([
    reviewQueue.countDue(tx, learnerId, now, 'KANA'),
    reviewQueue.countDue(tx, learnerId, now, 'VOCABULARY'),
  ]);

  // 直近 7 日の回答。日界は学習者の時計で切る。
  const since = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
  const stamps = await tx
    .select({ createdAt: learningEvents.createdAt })
    .from(learningEvents)
    .where(
      and(
        eq(learningEvents.learnerId, learnerId),
        gte(learningEvents.createdAt, since),
      ),
    );
  const counts = new Map<string, number>();
  for (const row of stamps) {
    const key = localDateKey(row.createdAt, timeZone);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const todayKey = localDateKey(now, timeZone);
  const dayBack = (back: number): string => {
    const at = new Date(now.getTime() - back * 24 * 60 * 60 * 1000);
    return localDateKey(at, timeZone);
  };
  const activity = Array.from({ length: 7 }, (_, index) => {
    const day = dayBack(6 - index);
    return { day, count: counts.get(day) ?? 0 };
  });
  let streak = 0;
  for (let back = (counts.get(todayKey) ?? 0) > 0 ? 0 : 1; back < 400; back += 1) {
    if ((counts.get(dayBack(back)) ?? 0) > 0) streak += 1;
    else break;
  }

  const kana = kanaProgress(kanaIds);
  const vocab = vocabProgress(vocabIds);
  const byLevel = vocabProgressByLevel(vocabIds, level);

  return {
    kana: { ...kana, due: kanaDue },
    vocab: {
      ...vocab,
      due: vocabDue,
      level,
      levelIntroduced: byLevel.introduced,
      levelTotal: byLevel.total,
    },
    activity,
    streak,
  };
}

/**
 * 錯題本。直近の指摘を新しい順に。
 *
 * `detected_issues` は学習者を直接持たず、session 経由でしか辿れない。
 * **必ず join で絞ること**——絞り忘れると他人の記録が出る。いまは
 * 単一利用者なので実害は出ないが、V4 で多利用者になった瞬間に漏れる。
 */
export async function loadErrors(
  tx: Executor,
  learnerId: string,
  limit: number,
): Promise<ErrorEntry[]> {
  const rows = await tx
    .select({ issue: detectedIssues })
    .from(detectedIssues)
    .innerJoin(sessions, eq(detectedIssues.sessionId, sessions.id))
    .where(eq(sessions.learnerId, learnerId))
    .orderBy(desc(detectedIssues.createdAt))
    .limit(limit);

  return rows.map(({ issue }) => ({
    id: issue.id,
    original: issue.original,
    recommended: issue.recommended,
    reason: issue.reason,
    knowledgeKey: issue.knowledgeKey,
    source: issue.source,
    at: issue.createdAt.toISOString(),
  }));
}

/** 復習日历：これから 30 日ぶんの期日。 */
export async function loadCalendar(
  tx: Executor,
  learnerId: string,
  now: Date,
  timeZone: string,
  days: number,
): Promise<CalendarDay[]> {
  const until = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const rows = await tx
    .select({ at: reviewQueueTable.nextReviewAt })
    .from(reviewQueueTable)
    .where(
      and(
        eq(reviewQueueTable.learnerId, learnerId),
        lte(reviewQueueTable.nextReviewAt, until),
      ),
    );

  const counts = new Map<string, number>();
  for (const row of rows) {
    // 期日を過ぎたものは「今日やる分」として今日に寄せる。
    const at = row.at.getTime() < now.getTime() ? now : row.at;
    const key = localDateKey(at, timeZone);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return Array.from({ length: days }, (_, index) => {
    const at = new Date(now.getTime() + index * 24 * 60 * 60 * 1000);
    const day = localDateKey(at, timeZone);
    return { day, due: counts.get(day) ?? 0 };
  });
}

export async function findLearnerId(
  tx: Executor,
  telegramUserId: number,
): Promise<string | undefined> {
  const learner = await learnerProfiles.findByTelegramUserId(tx, telegramUserId);
  return learner?.id;
}
