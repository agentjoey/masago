import { and, desc, eq, lte } from 'drizzle-orm';
import { gojuonGrid } from '../curriculum/gojuon.js';
import { kanaOfKey } from '../curriculum/kana.js';
import { particleOfKey, particleProgress } from '../curriculum/particles.js';
import { kanaProgress } from '../curriculum/lessonPlan.js';
import {
  currentVocabLevel,
  vocabProgress,
  vocabProgressByLevel,
} from '../curriculum/stage.js';
import { vocabOfKey } from '../curriculum/vocab.js';
import type { Executor } from '../db/repositories/executor.js';
import * as learnerProfiles from '../db/repositories/learnerProfiles.js';
import * as learningEventsRepo from '../db/repositories/learningEvents.js';
import * as reviewQueue from '../db/repositories/reviewQueue.js';
import {
  detectedIssues,
  knowledgeItems,
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
  /** 助詞。/today は既に出しているので、ここに無いとまた数字が割れる。 */
  readonly grammar: { introduced: number; total: number; due: number };
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

  const [kanaDue, vocabDue, grammarDue] = await Promise.all([
    reviewQueue.countDue(tx, learnerId, now, 'KANA'),
    reviewQueue.countDue(tx, learnerId, now, 'VOCABULARY'),
    reviewQueue.countDue(tx, learnerId, now, 'GRAMMAR'),
  ]);
  const grammarKeys = await reviewQueue.listIntroducedKeys(
    tx,
    learnerId,
    'GRAMMAR',
  );
  const grammar = particleProgress(
    new Set(
      grammarKeys
        .map((key) => particleOfKey(key)?.id)
        .filter((id): id is string => id !== undefined),
    ),
  );

  /**
   * 直近 7 日の**回答**。日界は学習者の時計で切る。
   *
   * `learning_events` を無条件に数えてはいけない——導入（INTRODUCED）まで
   * 「やった」に混ざる。実測で、今日の活動が 22 と出ているのに月の回答数は
   * 17 しか無い、という有り得ない組み合わせが MCP 経由で見えた
   * （差の 5 はその日の新出）。
   *
   * 連続日数にも効く：新しい項目が入っただけで答えていない日を
   * 「学習した日」と数えてしまう。数え方は `answerTimestampsSince` に
   * 寄せて、bot 側の `/progress` と同じ定義にする。
   */
  const since = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
  const stamps = await learningEventsRepo.answerTimestampsSince(
    tx,
    learnerId,
    since,
  );
  const counts = new Map<string, number>();
  for (const at of stamps) {
    const key = localDateKey(at, timeZone);
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
    grammar: { ...grammar, due: grammarDue },
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

/** 一つの字／語の学習状態。表を光らせるのに使う。 */
export interface ItemState {
  readonly key: string;
  readonly state: string;
  readonly reps: number;
  readonly lapses: number;
  readonly dueAt: string;
  readonly due: boolean;
  /** 0–1。安定度から出す「どれくらい定着したか」。 */
  readonly strength: number;
}

export interface KanaCell {
  readonly id: string;
  readonly hiragana: string;
  readonly katakana: string;
  readonly romaji: string;
  readonly state: ItemState | null;
}

export interface KanaSection {
  readonly group: string;
  readonly title: string;
  readonly columns: readonly string[];
  readonly rows: readonly { row: string; cells: readonly (KanaCell | null)[] }[];
}

/**
 * 安定度を 0–1 に均す。
 *
 * FSRS の stability は日数で、上限が無い。棒や濃淡に使うには
 * 「そろそろ確か」と言える所で頭打ちにしたい。30 日覚えていられれば
 * 十分定着とみなす。
 */
function strengthOf(stabilityDays: number): number {
  return Math.max(0, Math.min(1, stabilityDays / 30));
}

export async function loadKanaTable(
  tx: Executor,
  learnerId: string,
  now: Date,
): Promise<KanaSection[]> {
  const rows = await tx
    .select({ entry: reviewQueueTable, key: knowledgeItems.key })
    .from(reviewQueueTable)
    .innerJoin(
      knowledgeItems,
      eq(reviewQueueTable.knowledgeItemId, knowledgeItems.id),
    )
    .where(
      and(
        eq(reviewQueueTable.learnerId, learnerId),
        eq(knowledgeItems.type, 'KANA'),
      ),
    );

  const byKanaId = new Map<string, ItemState>();
  for (const row of rows) {
    const kana = kanaOfKey(row.key);
    if (kana === undefined) continue;
    byKanaId.set(kana.id, {
      key: row.key,
      state: row.entry.state,
      reps: row.entry.reps,
      lapses: row.entry.lapses,
      dueAt: row.entry.nextReviewAt.toISOString(),
      due: row.entry.nextReviewAt.getTime() <= now.getTime(),
      strength: strengthOf(row.entry.stability),
    });
  }

  return gojuonGrid().map((section) => ({
    group: section.group,
    title: section.title,
    columns: [...section.columns],
    rows: section.rows.map((row) => ({
      row: row.row,
      cells: row.cells.map((kana) =>
        kana === undefined
          ? null
          : {
              id: kana.id,
              hiragana: kana.hiragana,
              katakana: kana.katakana,
              romaji: kana.romaji,
              state: byKanaId.get(kana.id) ?? null,
            },
      ),
    })),
  }));
}

/**
 * 「これをもう一度やりたい」。期日を今にするだけで、FSRS の履歴は壊さない。
 *
 * 状態や安定度まで初期化すると、それまでの復習が無かったことになる。
 * 学習者が求めているのは「今出して」であって「忘れたことにして」ではない。
 */
export async function markDueNow(
  tx: Executor,
  learnerId: string,
  knowledgeKey: string,
  now: Date,
): Promise<boolean> {
  const [item] = await tx
    .select({ id: knowledgeItems.id })
    .from(knowledgeItems)
    .where(eq(knowledgeItems.key, knowledgeKey))
    .limit(1);
  if (item === undefined) return false;

  const updated = await tx
    .update(reviewQueueTable)
    .set({ nextReviewAt: now, updatedAt: now })
    .where(
      and(
        eq(reviewQueueTable.learnerId, learnerId),
        eq(reviewQueueTable.knowledgeItemId, item.id),
      ),
    )
    .returning({ id: reviewQueueTable.id });
  return updated.length > 0;
}

export interface ItemStateView {
  readonly reps: number;
  readonly lapses: number;
  readonly nextReviewAt: string;
  readonly state: string;
}

/**
 * 一つの知識項の学習状態（MCP の `fetch` が使う）。
 *
 * 「辞書」と「この人の学習記録」を分けるのがこの一行——同じ語でも、
 * 何回練習して次はいつか、は学習者ごとに違う。
 */
export async function loadItemState(
  tx: Executor,
  learnerId: string,
  knowledgeKey: string,
): Promise<ItemStateView | undefined> {
  const rows = await tx
    .select({ entry: reviewQueueTable })
    .from(reviewQueueTable)
    .innerJoin(
      knowledgeItems,
      eq(reviewQueueTable.knowledgeItemId, knowledgeItems.id),
    )
    .where(
      and(
        eq(reviewQueueTable.learnerId, learnerId),
        eq(knowledgeItems.key, knowledgeKey),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    reps: row.entry.reps,
    lapses: row.entry.lapses,
    nextReviewAt: row.entry.nextReviewAt.toISOString(),
    state: row.entry.state,
  };
}
