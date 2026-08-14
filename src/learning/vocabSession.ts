import { kanaOfKey } from '../curriculum/kana.js';
import {
  currentVocabLevel,
  planVocabLesson,
  stageOf,
  vocabProgressByLevel,
  teachesVocab,
  vocabProgress,
  type Stage,
  type VocabPlan,
} from '../curriculum/stage.js';
import {
  VOCAB_BY_ID,
  vocabOfKey,
  type JlptLevel,
  type VocabEntry,
} from '../curriculum/vocab.js';
import {
  buildVocabQuestion,
  isCorrectVocabAnswer,
  isCorrectVocabTyped,
  type Random,
  type VocabQuestion,
  type VocabQuestionKind,
} from '../curriculum/vocabQuiz.js';
import type { ReviewOutcome } from '../curriculum/review.js';
import type { Executor } from '../db/repositories/executor.js';
import * as reviewQueue from '../db/repositories/reviewQueue.js';
import { applyReview, enqueueNew, type AppliedReview } from './review.js';
import { resolveVocabItemIds } from './vocabSeed.js';

/**
 * S1（N5 語彙）の一日分。仮名側と同じ組み立てで、対象が語彙になるだけ。
 */

const VOCAB_TYPE = 'VOCABULARY' as const;
const KANA_TYPE = 'KANA' as const;

export interface VocabLessonOptions {
  readonly newPerDay: number;
  readonly maxReviews: number;
  readonly backlogThreshold: number;
}

export interface VocabLesson extends VocabPlan {
  readonly stage: Stage;
  /** いま取り組んでいる等級。 */
  readonly level: JlptLevel;
  readonly levelProgress: { introduced: number; total: number };
  readonly pool: readonly VocabEntry[];
  readonly progress: { introduced: number; total: number };
  readonly dueTotal: number;
}

async function introducedVocabIds(
  tx: Executor,
  learnerId: string,
): Promise<string[]> {
  const keys = await reviewQueue.listIntroducedKeys(tx, learnerId, VOCAB_TYPE);
  return keys
    .map((key) => vocabOfKey(key)?.id)
    .filter((id): id is string => id !== undefined);
}

export async function planVocabSession(
  tx: Executor,
  learnerId: string,
  now: Date,
  options: VocabLessonOptions,
): Promise<VocabLesson> {
  const kanaKeys = await reviewQueue.listIntroducedKeys(
    tx,
    learnerId,
    KANA_TYPE,
  );
  const kanaCount = kanaKeys.filter(
    (key) => kanaOfKey(key) !== undefined,
  ).length;
  const stage = stageOf(kanaCount);

  const introduced = await introducedVocabIds(tx, learnerId);
  const dueTotal = await reviewQueue.countDue(tx, learnerId, now, VOCAB_TYPE);
  const due = await reviewQueue.listDue(
    tx,
    learnerId,
    now,
    Math.max(options.maxReviews, options.backlogThreshold + 1),
    VOCAB_TYPE,
  );
  const dueIds = due
    .map((item) => vocabOfKey(item.knowledgeKey)?.id)
    .filter((id): id is string => id !== undefined);

  const plan = planVocabLesson({
    introducedIds: introduced,
    dueIds,
    // 清音がまだなら語彙は出さない。読めない字ばかりになる。
    newPerDay: teachesVocab(stage) ? options.newPerDay : 0,
    maxReviews: options.maxReviews,
    backlogThreshold: options.backlogThreshold,
  });

  return {
    ...plan,
    stage,
    pool: introduced
      .map((id) => VOCAB_BY_ID.get(id))
      .filter((entry): entry is VocabEntry => entry !== undefined),
    progress: vocabProgress(introduced),
    level: currentVocabLevel(introduced),
    levelProgress: vocabProgressByLevel(
      introduced,
      currentVocabLevel(introduced),
    ),
    dueTotal,
  };
}

export async function introduceVocab(
  tx: Executor,
  learnerId: string,
  vocabIds: readonly string[],
  now: Date,
): Promise<number> {
  if (vocabIds.length === 0) return 0;
  const itemIds = await resolveVocabItemIds(tx, vocabIds);
  const missing = vocabIds.filter((id) => !itemIds.has(id));
  if (missing.length > 0) {
    throw new Error(
      `vocab not seeded in knowledge_items: ${missing.join(', ')} — run ensureVocabSeeded first`,
    );
  }
  return enqueueNew(tx, learnerId, [...itemIds.values()], now);
}

export interface VocabDrillQuestion {
  readonly question: VocabQuestion;
  readonly entry: VocabEntry;
  readonly reps: number;
  readonly typed: boolean;
}

/**
 * 出題形式は仮名と同じ考え方で段を上げる。
 *
 * まず語を見せて意味を選ばせ（読めるかどうかも同時に確かめられる）、
 * 慣れたら意味から語を選ばせ、最後は打たせる。
 */
export function vocabQuestionKindFor(reps: number): VocabQuestionKind {
  return reps <= 1 ? 'WORD_TO_MEANING' : 'MEANING_TO_WORD';
}

export function isVocabTypedTier(reps: number): boolean {
  return reps >= 4;
}

export async function nextVocabQuestion(
  tx: Executor,
  learnerId: string,
  now: Date,
  options: { optionCount: number; random: Random },
): Promise<VocabDrillQuestion | undefined> {
  const due = await reviewQueue.listDue(tx, learnerId, now, 1, VOCAB_TYPE);
  const first = due[0];
  if (first === undefined) return undefined;

  const entry = vocabOfKey(first.knowledgeKey);
  if (entry === undefined) return undefined;

  const introduced = await introducedVocabIds(tx, learnerId);
  const pool = introduced
    .map((id) => VOCAB_BY_ID.get(id))
    .filter((item): item is VocabEntry => item !== undefined);

  const typed = isVocabTypedTier(first.entry.reps);
  const question = buildVocabQuestion(entry, {
    // 打たせる段は必ず「意味 → 日本語」。語を見せて書かせても
    // 目の前の字を写すだけで、思い出す働きが無い。
    kind: typed ? 'MEANING_TO_WORD' : vocabQuestionKindFor(first.entry.reps),
    optionCount: options.optionCount,
    random: options.random,
    pool,
  });

  return { question, entry, reps: first.entry.reps, typed };
}

export interface GradedVocab {
  readonly correct: boolean;
  readonly target: VocabEntry;
  readonly chosen: VocabEntry | undefined;
  readonly applied: AppliedReview;
}

async function record(
  tx: Executor,
  learnerId: string,
  vocabId: string,
  outcome: ReviewOutcome,
  now: Date,
  requestRetention: number,
): Promise<AppliedReview> {
  const itemIds = await resolveVocabItemIds(tx, [vocabId]);
  const itemId = itemIds.get(vocabId);
  if (itemId === undefined) {
    throw new Error(`vocab not seeded in knowledge_items: ${vocabId}`);
  }
  return applyReview(tx, learnerId, itemId, outcome, now, requestRetention);
}

export async function gradeVocabChoice(
  tx: Executor,
  learnerId: string,
  targetId: string,
  chosenId: string,
  now: Date,
  requestRetention: number,
  responseMs?: number,
): Promise<GradedVocab> {
  const target = VOCAB_BY_ID.get(targetId);
  if (target === undefined) throw new Error(`unknown vocab ${targetId}`);
  const correct = isCorrectVocabAnswer(targetId, chosenId);
  const outcome: ReviewOutcome = correct
    ? {
        kind: 'CORRECT',
        hinted: false,
        inputMode: 'CHOICE',
        ...(responseMs === undefined ? {} : { responseMs }),
      }
    : { kind: 'INCORRECT' };
  const applied = await record(
    tx,
    learnerId,
    targetId,
    outcome,
    now,
    requestRetention,
  );
  return {
    correct,
    target,
    chosen: VOCAB_BY_ID.get(chosenId),
    applied,
  };
}

export async function gradeVocabTyped(
  tx: Executor,
  learnerId: string,
  targetId: string,
  typed: string,
  now: Date,
  requestRetention: number,
  responseMs?: number,
): Promise<GradedVocab> {
  const target = VOCAB_BY_ID.get(targetId);
  if (target === undefined) throw new Error(`unknown vocab ${targetId}`);
  const correct = isCorrectVocabTyped(targetId, typed);
  const outcome: ReviewOutcome = correct
    ? {
        kind: 'CORRECT',
        hinted: false,
        inputMode: 'JAPANESE',
        ...(responseMs === undefined ? {} : { responseMs }),
      }
    : { kind: 'INCORRECT' };
  const applied = await record(
    tx,
    learnerId,
    targetId,
    outcome,
    now,
    requestRetention,
  );
  return { correct, target, chosen: undefined, applied };
}
