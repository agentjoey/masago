import { and, asc, desc, eq, gte, isNotNull, lte, sql } from 'drizzle-orm';
import {
  knowledgeItems,
  reviewQueue,
  type ReviewQueueEntry,
} from '../schema/learning.js';
import type { Executor } from './executor.js';

/**
 * 復習キューの永続化だけを持つ。間隔をどう決めるかは `curriculum/review.ts`、
 * 両者を繋ぐのは `learning/review.ts`——ここに FSRS を持ち込むと、repository が
 * repository でなくなり、学習理論がデータ層に癒着する。
 *
 * 到来した項目を取りに行くのは学習者が `/today` や `/review` を叩いた時だけ。
 * 期日を定期ポーリングして探しに行くと、Neon の compute が起き続けて
 * 無料枠を焼く（§9.1）。予定通知は別途アプリ内タイマーが持つ。
 */

/** FSRS 由来の列。値の意味は curriculum 側が決め、ここは運ぶだけ。 */
export type ReviewCardColumns = Pick<
  typeof reviewQueue.$inferInsert,
  | 'nextReviewAt'
  | 'intervalDays'
  | 'stability'
  | 'difficulty'
  | 'elapsedDays'
  | 'learningSteps'
  | 'reps'
  | 'lapses'
  | 'lastReview'
  | 'state'
>;

export interface DueItem {
  entry: ReviewQueueEntry;
  knowledgeType: (typeof knowledgeItems.$inferSelect)['type'];
  knowledgeKey: string;
}

/**
 * まだキューに無い知識項目を積む。既にあれば触らない——学習済みの
 * FSRS 状態を初期化してしまうと、それまでの復習履歴が消える。
 */
export async function enqueueIfAbsent(
  tx: Executor,
  learnerId: string,
  knowledgeItemIds: readonly string[],
  initial: ReviewCardColumns,
): Promise<number> {
  const unique = [...new Set(knowledgeItemIds)];
  if (unique.length === 0) {
    return 0;
  }
  const inserted = await tx
    .insert(reviewQueue)
    .values(
      unique.map((knowledgeItemId) => ({
        learnerId,
        knowledgeItemId,
        ...initial,
      })),
    )
    .onConflictDoNothing({
      target: [reviewQueue.learnerId, reviewQueue.knowledgeItemId],
    })
    .returning({ id: reviewQueue.id });
  return inserted.length;
}

type KnowledgeType = (typeof knowledgeItems.$inferSelect)['type'];

/** 期日が来ている項目。期日の早い順＝忘れかけている順。 */
export async function listDue(
  tx: Executor,
  learnerId: string,
  now: Date,
  limit: number,
  type?: KnowledgeType,
): Promise<DueItem[]> {
  const rows = await tx
    .select({ entry: reviewQueue, item: knowledgeItems })
    .from(reviewQueue)
    .innerJoin(
      knowledgeItems,
      eq(reviewQueue.knowledgeItemId, knowledgeItems.id),
    )
    .where(
      and(
        eq(reviewQueue.learnerId, learnerId),
        lte(reviewQueue.nextReviewAt, now),
        type === undefined ? undefined : eq(knowledgeItems.type, type),
      ),
    )
    // まだ一度も答えていない項目を先に出す。
    //
    // 期日順だけだと、導入したての項目は `nextReviewAt = now` なので
    // **必ず最後尾**に回る。「な行を五つ教えた直後に た を訊く」が
    // 実際に起きていた——目の前で見せた字をその場で確かめられないなら、
    // 教えた意味が薄い。答えて reps が 1 になれば、あとは期日順に戻る。
    .orderBy(
      asc(sql`case when ${reviewQueue.reps} = 0 then 0 else 1 end`),
      asc(reviewQueue.nextReviewAt),
    )
    .limit(limit);

  return rows.map((row) => ({
    entry: row.entry,
    knowledgeType: row.item.type,
    knowledgeKey: row.item.key,
  }));
}

export async function countDue(
  tx: Executor,
  learnerId: string,
  now: Date,
  type?: KnowledgeType,
): Promise<number> {
  const rows = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(reviewQueue)
    .innerJoin(
      knowledgeItems,
      eq(reviewQueue.knowledgeItemId, knowledgeItems.id),
    )
    .where(
      and(
        eq(reviewQueue.learnerId, learnerId),
        lte(reviewQueue.nextReviewAt, now),
        type === undefined ? undefined : eq(knowledgeItems.type, type),
      ),
    );
  return rows[0]?.count ?? 0;
}

/**
 * `since` 以降に答えた項目の数。
 *
 * リマインダを出すかどうかの判断に使う。もう今日やった人に
 * 「やりましょう」と送るのは、通知を無視する習慣を育てるだけ。
 */
export async function countReviewedSince(
  tx: Executor,
  learnerId: string,
  since: Date,
): Promise<number> {
  const rows = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(reviewQueue)
    .where(
      and(
        eq(reviewQueue.learnerId, learnerId),
        gte(reviewQueue.lastReview, since),
      ),
    );
  return rows[0]?.count ?? 0;
}

export async function countMastered(
  tx: Executor,
  learnerId: string,
  type: KnowledgeType,
): Promise<number> {
  const rows = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(reviewQueue)
    .innerJoin(
      knowledgeItems,
      eq(reviewQueue.knowledgeItemId, knowledgeItems.id),
    )
    .where(
      and(
        eq(reviewQueue.learnerId, learnerId),
        eq(knowledgeItems.type, type),
        eq(reviewQueue.state, 'MASTERED'),
      ),
    );
  return rows[0]?.count ?? 0;
}

/**
 * キューに入っている知識項目のキー＝「一度は導入した」もの。
 * 新出を選ぶときに、既に出したものを除くのに使う。
 */
export async function listIntroducedKeys(
  tx: Executor,
  learnerId: string,
  type: KnowledgeType,
): Promise<string[]> {
  const rows = await tx
    .select({ key: knowledgeItems.key })
    .from(reviewQueue)
    .innerJoin(
      knowledgeItems,
      eq(reviewQueue.knowledgeItemId, knowledgeItems.id),
    )
    .where(
      and(eq(reviewQueue.learnerId, learnerId), eq(knowledgeItems.type, type)),
    );
  return rows.map((row) => row.key);
}

/**
 * 直近に答えた項目。`/explain` が「今のあれ」を指すのに使う。
 *
 * どこにも覚えておかずに済むのが利点——最後に答えた時刻は
 * 復習キューに既に載っている。
 */
export async function findMostRecentlyReviewed(
  tx: Executor,
  learnerId: string,
): Promise<{ entry: ReviewQueueEntry; knowledgeKey: string } | undefined> {
  const rows = await tx
    .select({ entry: reviewQueue, item: knowledgeItems })
    .from(reviewQueue)
    .innerJoin(
      knowledgeItems,
      eq(reviewQueue.knowledgeItemId, knowledgeItems.id),
    )
    .where(
      and(
        eq(reviewQueue.learnerId, learnerId),
        isNotNull(reviewQueue.lastReview),
      ),
    )
    .orderBy(desc(reviewQueue.lastReview))
    .limit(1);
  const row = rows[0];
  return row === undefined
    ? undefined
    : { entry: row.entry, knowledgeKey: row.item.key };
}

export async function findEntry(
  tx: Executor,
  learnerId: string,
  knowledgeItemId: string,
): Promise<ReviewQueueEntry | undefined> {
  const rows = await tx
    .select()
    .from(reviewQueue)
    .where(
      and(
        eq(reviewQueue.learnerId, learnerId),
        eq(reviewQueue.knowledgeItemId, knowledgeItemId),
      ),
    )
    .limit(1);
  return rows[0];
}

/** 計算済みの状態を書き込む。無ければ作る。 */
export async function saveState(
  tx: Executor,
  learnerId: string,
  knowledgeItemId: string,
  columns: ReviewCardColumns,
): Promise<ReviewQueueEntry> {
  const values = { ...columns, updatedAt: new Date() };
  const [row] = await tx
    .insert(reviewQueue)
    .values({ learnerId, knowledgeItemId, ...values })
    .onConflictDoUpdate({
      target: [reviewQueue.learnerId, reviewQueue.knowledgeItemId],
      set: values,
    })
    .returning();

  if (row === undefined) {
    throw new Error(
      `review_queue upsert returned no row for item ${knowledgeItemId}`,
    );
  }
  return row;
}

/**
 * 掌握済みに上げる。FSRS は「習得」を知らないので、判定は §3.3 の
 * 集計側が持ち、ここは記録するだけ。
 */
export async function markMastered(
  tx: Executor,
  learnerId: string,
  knowledgeItemId: string,
): Promise<void> {
  await tx
    .update(reviewQueue)
    .set({ state: 'MASTERED', updatedAt: new Date() })
    .where(
      and(
        eq(reviewQueue.learnerId, learnerId),
        eq(reviewQueue.knowledgeItemId, knowledgeItemId),
      ),
    );
}
