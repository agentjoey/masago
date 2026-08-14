/**
 * 書く練習（docs/scenario-learning.md §5）。純粋関数。
 *
 * 助詞の穴埋めと語順の並べ替え——ゼロ初級が最も詰まる二つで、
 * どちらも**採点にモデルが要らない**。答えは元の文そのものだから。
 *
 * 素材は `sentences.ts`（人が書いた文を条件で絞ったもの）。
 * ここでは文を作らない。
 */
import type { Sentence, StoredToken } from './sentences.js';
import {
  isBlankableParticle,
  PARTICLE_BY_SURFACE,
  PARTICLE_SURFACES,
} from './particles.js';
import type { Random } from './quiz.js';

/* ─────────────── 文節への分割 ─────────────── */

/** 内容語。文節はここから始まる。 */
const CONTENT_POS = new Set([
  '名詞',
  '動詞',
  '形容詞',
  '副詞',
  '連体詞',
  '接続詞',
  '感動詞',
]);

/** 文節：内容語と、それにくっつく助詞・助動詞。 */
export interface Chunk {
  readonly text: string;
  readonly tokens: readonly StoredToken[];
  /** 末尾に助詞が付いているか。語順の判定に使う。 */
  readonly particle: string | undefined;
}

/**
 * 文を文節に割る。
 *
 * 語単位で割ると「私/は/学生/です」と細かすぎて、日本語の語順を
 * 練習していることにならない。「私は/学生です」の単位で扱う。
 */
export function toChunks(tokens: readonly StoredToken[]): Chunk[] {
  const chunks: Chunk[] = [];
  let current: StoredToken[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    const last = current[current.length - 1];
    chunks.push({
      text: current.map((token) => token.s).join(''),
      tokens: current,
      particle:
        last !== undefined && last.p === '助詞' ? last.s : undefined,
    });
    current = [];
  };

  for (const token of tokens) {
    // 句読点は前の文節に付ける。単独で並べ替えさせても意味が無い。
    // 文頭に来た記号（開き括弧など）も捨てない——捨てると本文が欠ける。
    if (token.p === '記号') {
      current.push(token);
      continue;
    }
    if (CONTENT_POS.has(token.p) && current.length > 0) {
      const last = current[current.length - 1];
      // 名詞が続くとき（「日本 語」）は同じ文節に入れる。
      const compound =
        last !== undefined && last.p === '名詞' && token.p === '名詞';
      // 補助動詞は述語の続き。「住んで」「います」に割ると、
      // 並べ替えの断片として意味を成さない——日本語話者は
      // 「住んでいます」を一つの述語として扱う。
      const auxiliaryVerb = token.p === '動詞' && token.d === '非自立';
      // 接頭辞の直後は必ず同じ文節（「お」「いくつ」を割らない）。
      const afterPrefix = last !== undefined && last.p === '接頭詞';
      if (!compound && !auxiliaryVerb && !afterPrefix) flush();
    }
    current.push(token);
  }
  flush();
  return chunks;
}

/* ─────────────── 助詞の穴埋め ─────────────── */

export interface ParticleBlank {
  readonly sentenceId: string;
  /** 空欄を `＿` にした本文。 */
  readonly prompt: string;
  readonly answer: string;
  /** 問うている助詞の知識項 id（`particles.ts`）。復習の記録に使う。 */
  readonly particleId: string;
  readonly options: readonly string[];
  /** 元の文。答え合わせで見せる。 */
  readonly full: string;
}

function shuffle<T>(items: readonly T[], random: Random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

export interface ParticleBlankOptions {
  readonly optionCount: number;
  readonly random: Random;
  /** この助詞を問う。復習で期限が来た項目を出すときに指定する。 */
  readonly particleId?: string;
}

/**
 * 助詞を一つ隠して選ばせる。
 *
 * 同じ助詞が文中に複数あると、どれを問うているのか曖昧になり、
 * 別の場所を見て答えられてしまう。その場合は出題しない。
 */
export function buildParticleBlank(
  sentence: Sentence,
  options: ParticleBlankOptions,
): ParticleBlank | undefined {
  // 名詞に付いた助詞だけを問う。
  //
  // これを絞らないと、固定表現の一部を問うことになる——「お飲みに
  // なりますか」の「に」は尊敬語 お〜になる の部品で、助詞を選ぶ
  // 問題ではない。「質問してもいい」の「も」も同じ。
  // 名詞に付く助詞なら、問いは常に「この名詞は文の中で何の役か」
  // になり、初級で本当に要る力に一致する。
  const candidates = blankCandidates(sentence, options.particleId);
  if (candidates.length === 0) return undefined;

  const picked = candidates[Math.floor(random01(options.random) * candidates.length)];
  if (picked === undefined) return undefined;
  return finishBlank(sentence, picked, options);
}

interface BlankCandidate {
  token: StoredToken;
  index: number;
}

/**
 * 本文に `needle` が何回出るか。
 *
 * 文字単位で数えてはいけない。「から」「まで」「より」は二文字なので、
 * 一文字ずつと比べると**永遠に 0 回**になり、候補から黙って外れる
 * ——実測で、から/まで/より は一問も出題されていなかった。
 * 部分文字列で数えれば一文字の助詞でも結果は変わらない。
 */
function occurrencesOf(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    count += 1;
    at = haystack.indexOf(needle, at + 1);
  }
  return count;
}

function blankCandidates(
  sentence: Sentence,
  particleId?: string,
): BlankCandidate[] {
  return sentence.tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token, index }) => {
      if (!isBlankableParticle(token)) return false;
      if (
        particleId !== undefined &&
        PARTICLE_BY_SURFACE.get(token.s)?.id !== particleId
      ) {
        return false;
      }
      const previous = sentence.tokens[index - 1];
      if (previous === undefined || previous.p !== '名詞') return false;
      // 答えが本文の他所に残っていたら、そこを見れば分かってしまう。
      //
      // 語（トークン）単位で数えるだけでは足りない。「今では」の で を
      // 隠しても「でも」の で が本文に残る——別の語の一部でも、
      // 学習者の目には同じ文字として映る。
      return occurrencesOf(sentence.text, token.s) === 1;
    });
}

function finishBlank(
  sentence: Sentence,
  picked: BlankCandidate,
  options: ParticleBlankOptions,
): ParticleBlank | undefined {
  const answer = picked.token.s;
  const entry = PARTICLE_BY_SURFACE.get(answer);
  if (entry === undefined) return undefined;

  // 誤答も答えと同じ集合から採る。別々の集合にすると、答えにしか
  // 出ない助詞ができてしまい、「見慣れない字が答え」という当て方が通る。
  const distractors = shuffle(
    PARTICLE_SURFACES.filter((particle) => particle !== answer),
    options.random,
  ).slice(0, Math.max(0, options.optionCount - 1));

  return {
    sentenceId: sentence.id,
    prompt: sentence.tokens
      .map((token, index) => (index === picked.index ? '＿' : token.s))
      .join(''),
    answer,
    particleId: entry.id,
    options: shuffle([answer, ...distractors], options.random),
    full: sentence.text,
  };
}

function random01(random: Random): number {
  const value = random();
  return value >= 1 ? 0.999999 : value < 0 ? 0 : value;
}

export function isCorrectParticle(
  blank: ParticleBlank,
  chosen: string,
): boolean {
  return chosen === blank.answer;
}

/* ─────────────── 語順の並べ替え ─────────────── */

export interface WordOrder {
  readonly sentenceId: string;
  /** 並べ替えてもらう文節（既にシャッフル済み）。 */
  readonly pieces: readonly string[];
  /** 正解の並び。 */
  readonly answer: readonly string[];
  /**
   * 助詞で終わる文節か（`answer` と同じ並び）。
   *
   * 助詞の付いた文節は文中で比較的自由に動かせるが、助詞の無い文節
   * ——連体修飾語など——は動かせない。「新しい学校は」の「新しい」を
   * 後ろへ回すと修飾関係が切れて非文になる。
   */
  readonly movable: readonly boolean[];
  readonly full: string;
}

/**
 * 文節を混ぜて並べ替えさせる。
 *
 * 2 文節では並べ替えにならず、多すぎると総当たりになる。
 */
export function buildWordOrder(
  sentence: Sentence,
  options: { random: Random },
): WordOrder | undefined {
  const chunks = toChunks(sentence.tokens);
  if (chunks.length < 3 || chunks.length > 6) return undefined;

  const answer = chunks.map((chunk) => chunk.text);
  // 元の順のまま出さない。混ざっていない問題は問題にならない。
  let pieces = shuffle(answer, options.random);
  for (let attempt = 0; attempt < 5 && sameOrder(pieces, answer); attempt += 1) {
    pieces = shuffle(answer, options.random);
  }
  if (sameOrder(pieces, answer)) return undefined;

  return {
    sentenceId: sentence.id,
    pieces,
    answer,
    movable: chunks.map((chunk) => chunk.particle !== undefined),
    full: sentence.text,
  };
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export type OrderVerdict =
  /** 元の文どおり。 */
  | 'CORRECT'
  /**
   * 文法上は通るが、元の文とは違う並び。
   *
   * 日本語の語順は比較的自由で、「私は本を読む」と「本を私は読む」は
   * どちらも文法的に成立する。前者だけを正解にして後者を「誤り」と
   * 突き返すのは事実に反する——学習者は正しく書いたのに直される。
   * 述語が最後に来ていて、文節の顔ぶれが同じなら、この扱いにする。
   */
  | 'ACCEPTABLE'
  | 'WRONG';

/**
 * 並べ替えの判定。
 *
 * 述語が最後に来ることは日本語の必須条件なので、そこだけは厳しく見る。
 * それ以外の入れ替えは「通るが自然ではない」に留める。
 */
export function judgeWordOrder(
  order: WordOrder,
  submitted: readonly string[],
): OrderVerdict {
  if (sameOrder(submitted, order.answer)) return 'CORRECT';

  const sameMultiset =
    submitted.length === order.answer.length &&
    [...submitted].sort().join(' ') ===
      [...order.answer].sort().join(' ');
  if (!sameMultiset) return 'WRONG';

  // 述語（元の文の最後の文節）が最後に来ているか。
  const predicate = order.answer[order.answer.length - 1];
  if (submitted[submitted.length - 1] !== predicate) return 'WRONG';

  // 助詞の無い文節が動いていたら非文。
  //
  // 述語が最後に来ていれば何でも許す、では緩すぎる。「新しい学校は
  // どうですか」の「新しい」を後ろへ回した「学校は新しいどうですか」は
  // 述語が最後のままだが日本語として成立しない——連体修飾語は
  // 修飾する語の直前でなければならない。動かせるのは助詞が付いた文節だけ。
  for (let index = 0; index < order.answer.length; index += 1) {
    if (order.movable[index] === true) continue;
    if (submitted[index] !== order.answer[index]) return 'WRONG';
  }
  return 'ACCEPTABLE';
}

/**
 * 出題に使える文か。
 *
 * 判定は `buildParticleBlank` と同じ条件を使う。別々に書くと、
 * 「使える」と言っておいて出題が undefined を返す食い違いが起きる。
 */
export function usableForParticle(
  sentence: Sentence,
  particleId?: string,
): boolean {
  return blankCandidates(sentence, particleId).length > 0;
}

/** 会話の引用符を含む文。並べ替えの断片としては読めない。 */
const QUOTE_MARKS = /[「」『』]/;

export function usableForWordOrder(sentence: Sentence): boolean {
  // 「A」「B」のような二人の発話は、文節に割ると引用符が宙に浮く。
  if (QUOTE_MARKS.test(sentence.text)) return false;
  const count = toChunks(sentence.tokens).length;
  return count >= 3 && count <= 6;
}
