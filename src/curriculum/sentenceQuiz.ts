/**
 * 文の意味を問う四択（docs/scenario-learning.md §4 第一档 / §5 読）。純粋関数。
 *
 * **選択肢は四つとも人が書いた実在の文**。日本語も中国語訳も Tatoeba 由来で、
 * 模型は一切通らない（§8）。判定も決定的——訳が付いているから、
 * 正解が何かを推測する必要が無い。
 *
 * 誤答は「意味が違う実在の文」から採る。作文した誤答と違い、
 * 学習者が誤答のほうを覚えてしまっても実在の日本語なので害が小さい（§15）。
 */
import type { Random } from './quiz.js';
import { TRANSLATED, type Sentence } from './sentences.js';

export type SentenceQuestionKind =
  /** 中国語を見せて、それに当たる日本語文を選ばせる。 */
  | 'ZH_TO_JA'
  /** 日本語を見せて、意味を選ばせる。 */
  | 'JA_TO_ZH';

export interface SentenceOption {
  readonly sentenceId: string;
  readonly label: string;
}

export interface SentenceQuestion {
  readonly kind: SentenceQuestionKind;
  readonly targetId: string;
  readonly prompt: string;
  readonly options: readonly SentenceOption[];
  /**
   * 正解として認める文の id。
   *
   * 一つとは限らない。「目が痛いです。」と「目が痛い。」はどちらも
   * 「我的眼睛疼」で、同じ問題に両方が並ぶことがある。**どちらを選んでも
   * 正解**にしないと、正しく読めた学習者に ❌ を出すことになる。
   */
  readonly correctIds: readonly string[];
}

/** 比較用に句読点と空白を落とす。「我的眼睛疼」と「我的眼睛疼。」は同じ。 */
function normalizeZh(text: string): string {
  return text.replace(/[\s。，、．,.！!？?；;：:]/gu, '');
}

const CONTENT_POS = new Set(['名詞', '動詞', '形容詞', '副詞', '連体詞']);

/** 内容語の見出し。意味が本当に違うかを見るのに使う。 */
function contentWords(sentence: Sentence): Set<string> {
  return new Set(
    sentence.tokens
      .filter((token) => CONTENT_POS.has(token.p))
      .map((token) => token.s),
  );
}

function sameContent(a: Sentence, b: Sentence): boolean {
  const left = contentWords(a);
  const right = contentWords(b);
  if (left.size !== right.size) return false;
  for (const word of left) if (!right.has(word)) return false;
  return true;
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

/** 二文が共有する内容語の数。多いほど紛らわしい＝良い誤答。 */
function overlap(a: Sentence, b: Sentence): number {
  const left = contentWords(a);
  let count = 0;
  for (const word of contentWords(b)) if (left.has(word)) count += 1;
  return count;
}

export interface SentenceQuizOptions {
  readonly kind: SentenceQuestionKind;
  readonly optionCount: number;
  readonly random: Random;
  /** 誤答を採る母集団。省略すると訳の付いた文すべて。 */
  readonly pool?: readonly Sentence[];
}

/**
 * 一問組む。訳の無い文は対象にできない（意味を示せないので）。
 *
 * 誤答は内容語の重なりが多い文を優先する。全く関係のない文を並べると、
 * 知っている単語が一つあるだけで当たってしまい、読めたことにならない。
 */
export function buildSentenceQuestion(
  target: Sentence,
  options: SentenceQuizOptions,
): SentenceQuestion | undefined {
  const targetZh = target.zh;
  if (targetZh === undefined) return undefined;

  const pool = options.pool ?? TRANSLATED;
  const targetKey = normalizeZh(targetZh);

  /**
   * 誤答にできない文を除く。
   *
   * 訳が同じ文は「別の正解」であって誤答ではない。内容語が丸ごと同じ文も
   * 言い換えの可能性が高いので外す——訳の字面が違っても意味は同じ、
   * ということが起きる。
   */
  const usable = pool.filter(
    (candidate) =>
      candidate.id !== target.id &&
      candidate.zh !== undefined &&
      normalizeZh(candidate.zh) !== targetKey &&
      !sameContent(candidate, target),
  );

  const wanted = Math.max(0, options.optionCount - 1);
  // 重なりの多い順に候補を並べ、上位から採る。同点は乱数で崩す。
  const ranked = shuffle(usable, options.random).sort(
    (a, b) => overlap(target, b) - overlap(target, a),
  );

  const label = (sentence: Sentence): string =>
    options.kind === 'ZH_TO_JA' ? sentence.text : (sentence.zh ?? '');

  // 表示が同じ選択肢を並べない。訳が違っても文字列が同じことはあり得る。
  const usedLabels = new Set<string>([label(target)]);
  // 意味も重ねない。**正解と比べるだけでは足りない**——誤答どうしが
  // 同じ意味だと、四択のうち二つが同じ答えになり、消去法が崩れる
  // （実測：「我妹妹的房间总是整整齐齐的」で四つの選択肢の意味が三種類）。
  const usedMeanings = new Set<string>([targetKey]);
  const distractors: Sentence[] = [];
  for (const candidate of ranked) {
    if (distractors.length >= wanted) break;
    const text = label(candidate);
    const meaning = normalizeZh(candidate.zh ?? '');
    if (text === '' || usedLabels.has(text) || usedMeanings.has(meaning)) {
      continue;
    }
    usedLabels.add(text);
    usedMeanings.add(meaning);
    distractors.push(candidate);
  }
  if (distractors.length < wanted) return undefined;

  const chosen = shuffle([target, ...distractors], options.random);
  return {
    kind: options.kind,
    targetId: target.id,
    prompt: options.kind === 'ZH_TO_JA' ? targetZh : target.text,
    options: chosen.map((sentence) => ({
      sentenceId: sentence.id,
      label: label(sentence),
    })),
    // 除外しているので通常は一つだが、計算で出す。
    // 「正解は一つ」と決め打つと、後で母集団を変えたときに黙って壊れる。
    correctIds: chosen
      .filter(
        (sentence) =>
          sentence.id === target.id ||
          (sentence.zh !== undefined &&
            normalizeZh(sentence.zh) === targetKey),
      )
      .map((sentence) => sentence.id),
  };
}

export function isCorrectSentenceAnswer(
  question: SentenceQuestion,
  chosenId: string,
): boolean {
  return question.correctIds.includes(chosenId);
}
