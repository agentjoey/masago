import { and, eq, gte, inArray } from 'drizzle-orm';
import {
  learningEvents,
  type LearningEvent,
  type NewLearningEvent,
} from '../schema/learning.js';
import type { Executor } from './executor.js';

export async function insertMany(
  tx: Executor,
  events: NewLearningEvent[],
): Promise<LearningEvent[]> {
  if (events.length === 0) {
    return [];
  }
  return tx
    .insert(learningEvents)
    .values(events)
    .onConflictDoNothing({ target: learningEvents.dedupeKey })
    .returning();
}

/** 「やった」と数える事件。導入は含めない——答えた回数だけを見る。 */
const ANSWER_EVENT_TYPES = [
  'USER_CORRECT',
  'USER_ERROR',
  'FAILED_RECALL',
  'USED_SPONTANEOUSLY',
  'USED_WITH_HINT',
] as const;

/**
 * 直近 N 日の回答時刻。日ごとの集計は呼び出し側で行う。
 *
 * SQL で地域時間の日界を切ることもできるが、そうすると「学習者にとって
 * 何日か」の実装が SQL と TypeScript の二箇所に増える。日界の扱いは
 * すでに `scheduler/dailyTime.ts` で試験してあるので、そちらに寄せる。
 * 一週間ぶんの回答は多くても数百件で、持ってきて数えても何ということはない。
 */
export async function answerTimestampsSince(
  tx: Executor,
  learnerId: string,
  since: Date,
): Promise<Date[]> {
  const rows = await tx
    .select({ createdAt: learningEvents.createdAt })
    .from(learningEvents)
    .where(
      and(
        eq(learningEvents.learnerId, learnerId),
        inArray(learningEvents.eventType, [...ANSWER_EVENT_TYPES]),
        gte(learningEvents.createdAt, since),
      ),
    );
  return rows.map((row) => row.createdAt);
}
