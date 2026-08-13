import {
  KANA_BY_GLYPH,
  KANA_BY_ID,
  kanaOfKey,
  type Kana,
} from '../curriculum/kana.js';
import { taughtPool } from '../curriculum/lessonPlan.js';
import {
  buildQuestion,
  isCorrectAnswer,
  isCorrectRomaji,
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
  /** 打ち込みで答えさせる段階か。選択肢は出さない。 */
  readonly typed: boolean;
}

/**
 * 出題の段階（V2 §4.3）。回数が増えるほど楽な形式から外していく。
 *
 * 1. 見て選ぶ（字 → 読み）……初見はこれしかない。字を知らないうちに
 *    「a はどれ？」と訊いても総当たりになる。
 * 2. 逆に選ぶ（読み → 字）……読めるようになってから。
 * 3. 打つ（字 → 読みを入力）……四択は消去法で当たる。打てて初めて
 *    「書ける」に近づく。選択肢を出さないので偶然の正解が消える。
 *
 * 三段目に上げる回数を早くしすぎると、まだ覚えていない字を打たせて
 * 手が止まる。逆に遅すぎると、いつまでも四択の運が混ざる。
 */
export type DrillTier = 'RECOGNIZE' | 'RECALL' | 'PRODUCE';

export function tierFor(reps: number): DrillTier {
  if (reps <= 1) return 'RECOGNIZE';
  if (reps <= 3) return 'RECALL';
  return 'PRODUCE';
}

export function questionKindFor(reps: number): QuestionKind {
  // 打たせるときは字を見せて読みを訊く。読みを見せて字を打たせるのは
  // かな入力が要るので、S1 以降（第三段の「日本語入力」）に回す。
  return tierFor(reps) === 'RECALL' ? 'ROMAJI_TO_GLYPH' : 'GLYPH_TO_ROMAJI';
}

/** 選択肢を出すか、打たせるか。 */
export function isTypedTier(reps: number): boolean {
  return tierFor(reps) === 'PRODUCE';
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
  const typed = isTypedTier(first.entry.reps);
  const question = buildQuestion(kana, {
    kind,
    script: 'hiragana',
    // 打たせる段でも問題は組む——正解判定の規則を一本にしておきたい。
    // 選択肢そのものは送らない側で捨てる。
    optionCount: options.optionCount,
    random: options.random,
    // 誤答は習った字からだけ。未習の字を混ぜると、消去法すら効かない。
    pool: taughtPool(introducedIds),
  });

  return { question, kana, reps: first.entry.reps, typed };
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

/**
 * 打ち込みの答えを採点して記録する。
 *
 * ヘボン式でも訓令式でも通す。「ji」は じ とも ぢ とも綴れるので、
 * 正しく打てた人を不正解にはしない（isCorrectRomaji）。
 */
export async function gradeTypedAndRecord(
  tx: Executor,
  learnerId: string,
  targetId: string,
  typed: string,
  now: Date,
  requestRetention: number,
  responseMs?: number,
): Promise<GradedAnswer> {
  const target = KANA_BY_ID.get(targetId);
  if (target === undefined) {
    throw new Error(`unknown kana ${targetId}`);
  }
  const correct = isCorrectRomaji(targetId, typed);

  const outcome: ReviewOutcome = correct
    ? {
        kind: 'CORRECT',
        hinted: false,
        inputMode: 'ROMAJI',
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

  return { correct, target, chosen: undefined, applied };
}

/**
 * 出題メッセージの本文から「何を訊かれたか」を復元する。
 *
 * 打ち込みの答えには押しボタンが無いので、コールバックに情報を載せられない。
 * とはいえ「出した問題」をどこかに覚えておくと、再起動やタイムアウトで
 * 必ず失われる。返信元の本文には字形がそのまま入っているので、それを鍵にする
 * ——状態を持たずに済み、いつ答えが返ってきても解釈がぶれない。
 *
 * 字形だけの行を探す。説明文に紛れた同じ字を拾わないため、行全体が
 * 一致するものだけを見る。
 */
export function targetOfQuestionText(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const kana = KANA_BY_GLYPH.get(line.trim());
    if (kana !== undefined) return kana.id;
  }
  return undefined;
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
