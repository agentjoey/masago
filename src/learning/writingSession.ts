import {
  buildParticleBlank,
  buildWordOrder,
  judgeWordOrder,
  usableForParticle,
  usableForWordOrder,
  type OrderVerdict,
} from '../curriculum/writing.js';
import type { Random } from '../curriculum/quiz.js';
import {
  SENTENCES,
  SENTENCES_BY_ID,
  type Sentence,
} from '../curriculum/sentences.js';

/**
 * 書く練習の駆動（docs/scenario-learning.md §5）。
 *
 * 出題も採点も純粋関数で、モデルは使わない。答えは元の文そのものだから。
 *
 * 状態を持たないのは仮名・単語と同じ考え方。助詞の問題は選択肢に、
 * 語順の問題は返信元の本文に、必要な情報が全部載っている。
 */

export type WritingKind = 'PARTICLE' | 'WORD_ORDER';

export interface WritingQuestion {
  readonly kind: WritingKind;
  readonly sentenceId: string;
  readonly prompt: string;
  /** 助詞問題の選択肢。語順問題では空。 */
  readonly options: readonly string[];
  /** 語順問題で並べ替える断片。助詞問題では空。 */
  readonly pieces: readonly string[];
}

/**
 * 既習の語彙で読める文だけを出す。
 *
 * 未習の語が混じった文で語順を練習させても、意味が取れないまま
 * 形だけ並べることになる。
 */
function pickSentence(
  known: ReadonlySet<string>,
  usable: (sentence: Sentence) => boolean,
  random: Random,
): Sentence | undefined {
  const pool = SENTENCES.filter(
    (sentence) =>
      usable(sentence) &&
      sentence.tokens.every(
        (token) =>
          token.p === '助詞' ||
          token.p === '助動詞' ||
          token.p === '記号' ||
          known.has(token.s) ||
          known.size === 0,
      ),
  );
  const source = pool.length > 0 ? pool : SENTENCES.filter(usable);
  if (source.length === 0) return undefined;
  const index = Math.min(
    source.length - 1,
    Math.floor(random() * source.length),
  );
  return source[index];
}

export interface WritingOptions {
  readonly optionCount: number;
  readonly random: Random;
  /** 既習の語（表記）。空なら全文から選ぶ。 */
  readonly known?: ReadonlySet<string>;
}

export function nextWritingQuestion(
  kind: WritingKind,
  options: WritingOptions,
): WritingQuestion | undefined {
  const known = options.known ?? new Set<string>();
  if (kind === 'PARTICLE') {
    const sentence = pickSentence(known, usableForParticle, options.random);
    if (sentence === undefined) return undefined;
    const blank = buildParticleBlank(sentence, {
      optionCount: options.optionCount,
      random: options.random,
    });
    if (blank === undefined) return undefined;
    return {
      kind,
      sentenceId: sentence.id,
      prompt: blank.prompt,
      options: blank.options,
      pieces: [],
    };
  }

  const sentence = pickSentence(known, usableForWordOrder, options.random);
  if (sentence === undefined) return undefined;
  const order = buildWordOrder(sentence, { random: options.random });
  if (order === undefined) return undefined;
  return {
    kind,
    sentenceId: sentence.id,
    prompt: order.pieces.join('　/　'),
    options: [],
    pieces: order.pieces,
  };
}

export interface ParticleResult {
  readonly correct: boolean;
  readonly answer: string;
  readonly full: string;
}

/**
 * 助詞の採点。出題を保持していないので、文 id と選択から組み直す。
 *
 * 同じ乱数を渡さなくても答えは決まる——空欄の位置は文から一意に
 * 決まるわけではないが、**選ばれた助詞が正しいかどうか**は
 * 文の中でその助詞が使われているかで判定できる。
 */
export function gradeParticle(
  sentenceId: string,
  blankedPrompt: string,
  chosen: string,
): ParticleResult | undefined {
  const sentence = SENTENCES_BY_ID.get(sentenceId);
  if (sentence === undefined) return undefined;
  // 空欄に選択肢を入れて元の文と一致するかを見る。位置を覚えずに済む。
  const filled = blankedPrompt.replace('＿', chosen);
  const correct = filled === sentence.text;
  const answerChar = answerOf(blankedPrompt, sentence.text);
  return {
    correct,
    answer: answerChar ?? '',
    full: sentence.text,
  };
}

/** 空欄に入るべき文字を、元の文と突き合わせて取り出す。 */
function answerOf(blanked: string, full: string): string | undefined {
  const at = [...blanked].findIndex((char) => char === '＿');
  if (at < 0) return undefined;
  return [...full][at];
}

export interface OrderResult {
  readonly verdict: OrderVerdict;
  readonly answer: string;
  readonly full: string;
}

/**
 * 語順の採点。学習者が書き上げた文をそのまま受け取る。
 *
 * 空白や中黒は取り除いてから比べる——並べ替えの区切りとして
 * 入れてしまう人がいるが、それは誤りではない。
 */
export function gradeWordOrder(
  sentenceId: string,
  submittedText: string,
): OrderResult | undefined {
  const sentence = SENTENCES_BY_ID.get(sentenceId);
  if (sentence === undefined) return undefined;

  const normalize = (text: string): string =>
    text.replace(/[\s　/／・|｜]/g, '');
  const submitted = normalize(submittedText);
  const answer = normalize(sentence.text);

  if (submitted === answer) {
    return { verdict: 'CORRECT', answer: sentence.text, full: sentence.text };
  }

  // 断片の並び替えとして解釈できるか。文節に割り直して判定する。
  const order = buildWordOrder(sentence, { random: () => 0.5 });
  if (order === undefined) {
    return { verdict: 'WRONG', answer: sentence.text, full: sentence.text };
  }
  const pieces = splitByChunks(submitted, order.answer);
  const verdict: OrderVerdict =
    pieces === undefined ? 'WRONG' : judgeWordOrder(order, pieces);
  return { verdict, answer: sentence.text, full: sentence.text };
}

/**
 * 提出された一続きの文を、正解の文節で切り直す。
 *
 * 学習者は区切りを付けずに書いてくるので、こちらで文節に戻さないと
 * 「並べ替えとして成立しているか」を判定できない。
 */
function splitByChunks(
  submitted: string,
  chunks: readonly string[],
): string[] | undefined {
  const remaining = [...chunks];
  const out: string[] = [];
  let rest = submitted;
  while (rest.length > 0) {
    const index = remaining.findIndex((chunk) => rest.startsWith(chunk));
    if (index < 0) return undefined;
    const chunk = remaining[index];
    if (chunk === undefined) return undefined;
    out.push(chunk);
    remaining.splice(index, 1);
    rest = rest.slice(chunk.length);
  }
  return remaining.length === 0 ? out : undefined;
}
