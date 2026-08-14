import { and, count, desc, eq, gte, inArray, lt } from 'drizzle-orm';
import {
  knowledgeItems,
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

/**
 * その日すでに導入した数（種別ごと）。
 *
 * 一日の新出上限は「一回の呼び出しで出す数」ではなく「その日に出した総数」
 * でなければならない。前者だと `/kana` を五回叩けば五日分が一日で入り、
 * 積み残しが雪だるまになる（実測で確認）。
 */
export async function countIntroducedSince(
  tx: Executor,
  learnerId: string,
  since: Date,
  type: (typeof knowledgeItems.$inferSelect)['type'],
): Promise<number> {
  const rows = await tx
    .select({ count: count() })
    .from(learningEvents)
    .innerJoin(
      knowledgeItems,
      eq(learningEvents.knowledgeItemId, knowledgeItems.id),
    )
    .where(
      and(
        eq(learningEvents.learnerId, learnerId),
        eq(learningEvents.eventType, 'INTRODUCED'),
        eq(knowledgeItems.type, type),
        gte(learningEvents.createdAt, since),
      ),
    );
  return rows[0]?.count ?? 0;
}

/**
 * 既に記録済みの dedupe 鍵を返す。
 *
 * `insertMany` は衝突を黙って捨てるので、事件の重複は防げる。だが
 * 復習キューのほうは呼んだ分だけ進んでしまうので、**書く前に**
 * 知る必要がある——会話で同じ語を五回使っても、証拠は一つ。
 */
export async function existingDedupeKeys(
  tx: Executor,
  keys: readonly string[],
): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await tx
    .select({ dedupeKey: learningEvents.dedupeKey })
    .from(learningEvents)
    .where(inArray(learningEvents.dedupeKey, [...keys]));
  return new Set(rows.map((row) => row.dedupeKey));
}

export interface PeriodTally {
  /** 答えた回数（導入は含まない）。 */
  readonly answered: number;
  readonly correct: number;
  readonly failed: number;
  /** 期間中に新しく導入した数。 */
  readonly introduced: number;
}

/** ある期間の集計。週報・月報の土台（§3.3 の事件列から数える）。 */
export async function tallyBetween(
  tx: Executor,
  learnerId: string,
  since: Date,
  until: Date,
): Promise<PeriodTally> {
  const rows = await tx
    .select({ eventType: learningEvents.eventType, count: count() })
    .from(learningEvents)
    .where(
      and(
        eq(learningEvents.learnerId, learnerId),
        gte(learningEvents.createdAt, since),
        lt(learningEvents.createdAt, until),
      ),
    )
    .groupBy(learningEvents.eventType);

  const of = (type: string): number =>
    rows.find((row) => row.eventType === type)?.count ?? 0;

  const correct = of('USER_CORRECT') + of('USED_SPONTANEOUSLY');
  const failed = of('FAILED_RECALL') + of('USER_ERROR');
  return {
    answered: correct + failed + of('USED_WITH_HINT'),
    correct,
    failed,
    introduced: of('INTRODUCED'),
  };
}

export interface TroubleSpot {
  readonly knowledgeItemId: string;
  readonly knowledgeKey: string;
  readonly knowledgeType: (typeof knowledgeItems.$inferSelect)['type'];
  readonly failures: number;
}

/**
 * その期間に間違えた回数が多い順。週報でいちばん役に立つ行。
 *
 * 「今週 120 題やりました」より「を と が が 7 回混ざりました」のほうが、
 * 次に何をすればいいかが決まる。
 */
export async function troubleSpotsBetween(
  tx: Executor,
  learnerId: string,
  since: Date,
  until: Date,
  limit: number,
): Promise<TroubleSpot[]> {
  const rows = await tx
    .select({
      knowledgeItemId: learningEvents.knowledgeItemId,
      key: knowledgeItems.key,
      type: knowledgeItems.type,
      failures: count(),
    })
    .from(learningEvents)
    .innerJoin(
      knowledgeItems,
      eq(learningEvents.knowledgeItemId, knowledgeItems.id),
    )
    .where(
      and(
        eq(learningEvents.learnerId, learnerId),
        inArray(learningEvents.eventType, ['FAILED_RECALL', 'USER_ERROR']),
        gte(learningEvents.createdAt, since),
        lt(learningEvents.createdAt, until),
      ),
    )
    .groupBy(learningEvents.knowledgeItemId, knowledgeItems.key, knowledgeItems.type)
    .orderBy(desc(count()))
    .limit(limit);

  return rows
    .filter((row) => row.knowledgeItemId !== null)
    .map((row) => ({
      knowledgeItemId: row.knowledgeItemId as string,
      knowledgeKey: row.key,
      knowledgeType: row.type,
      failures: row.failures,
    }));
}
