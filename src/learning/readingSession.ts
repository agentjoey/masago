import type { Random } from '../curriculum/quiz.js';
import {
  buildSentenceQuestion,
  isCorrectSentenceAnswer,
  type SentenceQuestion,
  type SentenceQuestionKind,
} from '../curriculum/sentenceQuiz.js';
import {
  SENTENCES_BY_ID,
  TRANSLATED,
  type Sentence,
} from '../curriculum/sentences.js';
import { SCENE_BY_ID, sceneSentences } from '../curriculum/scenes.js';
import type { Executor } from '../db/repositories/executor.js';
import * as reviewQueue from '../db/repositories/reviewQueue.js';
import { vocabOfKey } from '../curriculum/vocab.js';

/**
 * 読む練習の駆動（docs/scenario-learning.md §4 第一档 / §5 読）。
 *
 * 既習の語だけで読める文を選び、意味を四択で問う。文も訳も人が書いた
 * ものなので、出題にも採点にも模型は要らない。
 *
 * 語彙の復習キューには入れない。一文には語が何個も入っていて、
 * 一つ当たったからといってどの語が分かったのかは決まらない
 * ——測っていないものを FSRS に食わせると間隔が実力とずれる。
 * 読解は「既習の語で読めるか」を確かめる場として置く。
 */

const VOCAB_TYPE = 'VOCABULARY' as const;

/** 助詞・助動詞・記号は既習判定の対象外。文法として別に扱う。 */
const FUNCTION_POS = new Set(['助詞', '助動詞', '記号', 'フィラー', '感動詞']);

/**
 * 未習の語がいくつまでなら出してよいか。
 *
 * 0 にすると読める文がほとんど無くなる。一つくらいなら前後から
 * 推測できて、むしろ読む練習になる。
 */
const MAX_UNKNOWN_WORDS = 1;

function unknownCount(
  sentence: Sentence,
  known: ReadonlySet<string>,
): number {
  return sentence.tokens.filter(
    (token) =>
      !FUNCTION_POS.has(token.p) &&
      !known.has(token.s) &&
      !known.has(token.r ?? ''),
  ).length;
}

/** 既習の語（表記と読みの両方）。 */
export async function knownWords(
  tx: Executor,
  learnerId: string,
): Promise<Set<string>> {
  const keys = await reviewQueue.listIntroducedKeys(tx, learnerId, VOCAB_TYPE);
  const known = new Set<string>();
  for (const key of keys) {
    const entry = vocabOfKey(key);
    if (entry === undefined) continue;
    known.add(entry.expression);
    known.add(entry.reading);
  }
  return known;
}

export interface ReadingQuestion {
  readonly question: SentenceQuestion;
  readonly sentence: Sentence;
  /** 未習の語がいくつ混ざっているか。学習者に断りを入れるのに使う。 */
  readonly unknown: number;
}

/**
 * 出題形式は段を上げる。
 *
 * まず日本語を見せて意味を選ばせる（読めるかどうかを測る）。慣れたら
 * 中国語から日本語を選ばせる——こちらのほうが難しく、書くことに近づく。
 */
export function readingKindFor(answered: number): SentenceQuestionKind {
  return answered % 3 === 2 ? 'ZH_TO_JA' : 'JA_TO_ZH';
}

export interface ReadingOptions {
  readonly optionCount: number;
  readonly random: Random;
  readonly kind?: SentenceQuestionKind;
  /** 場面で絞る（`curriculum/scenes.ts`）。未指定なら全部から。 */
  readonly sceneId?: string;
}

export async function nextReadingQuestion(
  tx: Executor,
  learnerId: string,
  options: ReadingOptions,
): Promise<ReadingQuestion | undefined> {
  const known = await knownWords(tx, learnerId);
  return buildReadingQuestion(known, options);
}

/** DB を見ない入り口。テストと Mini App が使う。 */
export function buildReadingQuestion(
  known: ReadonlySet<string>,
  options: ReadingOptions,
): ReadingQuestion | undefined {
  const scene =
    options.sceneId === undefined ? undefined : SCENE_BY_ID.get(options.sceneId);
  // 場面を選んだら訳のある文だけに絞る。訳が無いと意味を問えない。
  const source =
    scene === undefined
      ? TRANSLATED
      : sceneSentences(scene).filter((sentence) => sentence.zh !== undefined);
  const readable = source.filter(
    (sentence) => unknownCount(sentence, known) <= MAX_UNKNOWN_WORDS,
  );
  // 読める文が無いうちは、いちばん易しい文から出す。何も出さないより
  // 「まだ難しい」と分かるほうがよい。
  const pool = readable.length >= 8 ? readable : source;
  if (pool.length < 4) return undefined;

  const index = Math.min(
    pool.length - 1,
    Math.floor(options.random() * pool.length),
  );
  const target = pool[index];
  if (target === undefined) return undefined;

  const question = buildSentenceQuestion(target, {
    kind: options.kind ?? 'JA_TO_ZH',
    optionCount: options.optionCount,
    random: options.random,
    // 誤答も読める文から採る。読めない文が並ぶと、意味ではなく
    // 「見覚えのある字があるほう」で選べてしまう。
    pool,
  });
  if (question === undefined) return undefined;

  return { question, sentence: target, unknown: unknownCount(target, known) };
}

export interface GradedReading {
  readonly correct: boolean;
  readonly target: Sentence;
  readonly chosen: Sentence | undefined;
}

/** コールバックに載せる文字列。64 バイト制限があるので短く。 */
export function encodeReadingAnswer(
  targetId: string,
  chosenId: string,
): string {
  return `rq:${targetId}:${chosenId}`;
}

export interface DecodedReadingAnswer {
  readonly targetId: string;
  readonly chosenId: string;
}

export function decodeReadingAnswer(
  data: string,
): DecodedReadingAnswer | undefined {
  const parts = data.split(':');
  if (parts.length !== 3 || parts[0] !== 'rq') return undefined;
  const [, targetId, chosenId] = parts;
  if (targetId === undefined || chosenId === undefined) return undefined;
  if (!SENTENCES_BY_ID.has(targetId) || !SENTENCES_BY_ID.has(chosenId)) {
    return undefined;
  }
  return { targetId, chosenId };
}

/**
 * 採点。出題を保持していないので、文 id の対から組み直す。
 *
 * 同じ意味の文が選ばれた場合も正解にする——「目が痛いです」と
 * 「目が痛い」を取り違えたのは、読めていないこととは違う。
 */
export function gradeReading(
  decoded: DecodedReadingAnswer,
): GradedReading | undefined {
  const target = SENTENCES_BY_ID.get(decoded.targetId);
  const chosen = SENTENCES_BY_ID.get(decoded.chosenId);
  if (target === undefined) return undefined;

  const question: SentenceQuestion = {
    kind: 'JA_TO_ZH',
    targetId: target.id,
    prompt: target.text,
    options: [],
    correctIds: sameMeaningIds(target),
  };
  return {
    correct: isCorrectSentenceAnswer(question, decoded.chosenId),
    target,
    chosen,
  };
}

function normalizeZh(text: string): string {
  return text.replace(/[\s。，、．,.！!？?；;：:]/gu, '');
}

/** 同じ意味の文（自分を含む）。出題時と同じ規則で数える。 */
function sameMeaningIds(target: Sentence): string[] {
  const key = normalizeZh(target.zh ?? '');
  if (key === '') return [target.id];
  return TRANSLATED.filter(
    (sentence) => normalizeZh(sentence.zh ?? '') === key,
  ).map((sentence) => sentence.id);
}
