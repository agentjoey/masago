import { KANA_BY_ID, kanaOfKey, type Kana } from '../curriculum/kana.js';
import { taughtPool } from '../curriculum/lessonPlan.js';
import {
  buildQuestion,
  isCorrectAnswer,
  type QuestionKind,
  type QuizQuestion,
  type Random,
} from '../curriculum/quiz.js';
import type { ReviewOutcome } from '../curriculum/review.js';
import type { Executor } from '../db/repositories/executor.js';
import * as reviewQueue from '../db/repositories/reviewQueue.js';
import { recordKanaAnswer } from './kanaSession.js';
import type { AppliedReview } from './review.js';

/**
 * 出題の駆動（V2 §4.3 の第一段）。
 *
 * 「今日やる分」をどこかに保持したりしない。導入した仮名は期日が即座に
 * 来るので、出題は常に「いま期日が来ているものを出す」だけで済む。
 * 途中で離脱しても、別の端末から戻っても、続きから再開できる。
 */

const KANA_TYPE = 'KANA' as const;

export interface DrillQuestion {
  readonly question: QuizQuestion;
  readonly kana: Kana;
  /** これまでの出題回数。初回かどうかで問い方を変える。 */
  readonly reps: number;
}

/**
 * 出題形式は習熟度で変える。
 *
 * 初めて見る字にいきなり「a はどれ？」と訊いても、字を知らないのだから
 * 総当たりになる。まず字を見せて読みを選ばせ、読めるようになってから
 * 逆を訊く。
 */
export function questionKindFor(reps: number): QuestionKind {
  return reps <= 1 ? 'GLYPH_TO_ROMAJI' : 'ROMAJI_TO_GLYPH';
}

export interface DrillOptions {
  readonly optionCount: number;
  readonly random: Random;
}

export async function nextDrillQuestion(
  tx: Executor,
  learnerId: string,
  now: Date,
  options: DrillOptions,
): Promise<DrillQuestion | undefined> {
  const due = await reviewQueue.listDue(tx, learnerId, now, 1, KANA_TYPE);
  const first = due[0];
  if (first === undefined) return undefined;

  const kana = kanaOfKey(first.knowledgeKey);
  if (kana === undefined) return undefined;

  const introducedKeys = await reviewQueue.listIntroducedKeys(
    tx,
    learnerId,
    KANA_TYPE,
  );
  const introducedIds = introducedKeys
    .map((key) => kanaOfKey(key)?.id)
    .filter((id): id is string => id !== undefined);

  const kind = questionKindFor(first.entry.reps);
  const question = buildQuestion(kana, {
    kind,
    script: 'hiragana',
    optionCount: options.optionCount,
    random: options.random,
    // 誤答は習った字からだけ。未習の字を混ぜると、消去法すら効かない。
    pool: taughtPool(introducedIds),
  });

  return { question, kana, reps: first.entry.reps };
}

export interface GradedAnswer {
  readonly correct: boolean;
  readonly target: Kana;
  readonly chosen: Kana | undefined;
  readonly applied: AppliedReview;
}

/**
 * 回答を採点して記録する。
 *
 * 出した問題そのものは保持していないので、対象と選択と形式から採点する
 * ——同じ規則を出題側と共有しているので、結果は一致する。
 */
export async function gradeAndRecord(
  tx: Executor,
  learnerId: string,
  targetId: string,
  chosenId: string,
  kind: QuestionKind,
  now: Date,
  requestRetention: number,
  responseMs?: number,
): Promise<GradedAnswer> {
  const target = KANA_BY_ID.get(targetId);
  if (target === undefined) {
    throw new Error(`unknown kana ${targetId}`);
  }
  const correct = isCorrectAnswer(targetId, chosenId, kind);

  const outcome: ReviewOutcome = correct
    ? {
        kind: 'CORRECT',
        hinted: false,
        inputMode: 'CHOICE',
        ...(responseMs === undefined ? {} : { responseMs }),
      }
    : { kind: 'INCORRECT' };

  const applied = await recordKanaAnswer(
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
    chosen: KANA_BY_ID.get(chosenId),
    applied,
  };
}

/** コールバックに載せる文字列。64 バイト制限があるので短く。 */
export function encodeAnswer(
  targetId: string,
  chosenId: string,
  kind: QuestionKind,
): string {
  const k = kind === 'GLYPH_TO_ROMAJI' ? 'g' : kind === 'ROMAJI_TO_GLYPH' ? 'r' : 'a';
  return `kq:${k}:${targetId}:${chosenId}`;
}

export interface DecodedAnswer {
  readonly targetId: string;
  readonly chosenId: string;
  readonly kind: QuestionKind;
}

export function decodeAnswer(data: string): DecodedAnswer | undefined {
  const parts = data.split(':');
  if (parts.length !== 4 || parts[0] !== 'kq') return undefined;
  const [, k, targetId, chosenId] = parts;
  if (targetId === undefined || chosenId === undefined) return undefined;
  const kind: QuestionKind | undefined =
    k === 'g'
      ? 'GLYPH_TO_ROMAJI'
      : k === 'r'
        ? 'ROMAJI_TO_GLYPH'
        : k === 'a'
          ? 'AUDIO_TO_GLYPH'
          : undefined;
  if (kind === undefined) return undefined;
  if (!KANA_BY_ID.has(targetId) || !KANA_BY_ID.has(chosenId)) return undefined;
  return { targetId, chosenId, kind };
}
