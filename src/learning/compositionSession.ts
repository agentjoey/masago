import type { CompositionVerdict } from '../agent/composition.js';
import type { Random } from '../curriculum/quiz.js';
import { SCENE_BY_ID, sceneSentences } from '../curriculum/scenes.js';
import {
  SENTENCES_BY_ID,
  TRANSLATED,
  type Sentence,
} from '../curriculum/sentences.js';
import type { GrammarIssue, Token } from '../nlp/index.js';

/**
 * 中訳日の駆動（docs/scenario-learning.md §5 書 第 3 档）。
 *
 * 中国語を見せて日本語を書かせる。手本は人が書いた文で、模型は
 * 「同じ意味になっているか」を判定するだけ。
 *
 * ## 三段で判定する。安いほうから順に。
 *
 *   1. 手本と一致 → 正解。模型を呼ばない（費用ゼロ、常に同じ答え）
 *   2. 規則層が確定的な誤りを見つけた → 不正解。模型を呼ばない
 *   3. どちらでもない → 模型に訊く
 *
 * 1 と 2 で片付く分だけ費用も揺らぎも減る。**どの段でも手本は必ず見せる**
 * ——判定を外しても、学習者の目には正しい日本語が残る。
 */

export type CompositionSource = 'EXACT' | 'RULE' | 'MODEL' | 'UNJUDGED';

export interface CompositionQuestion {
  readonly sentenceId: string;
  /** 出題の中国語。 */
  readonly meaning: string;
  /** 手本の日本語。採点まで見せない。 */
  readonly reference: string;
}

export interface CompositionOptions {
  readonly random: Random;
  /** 既習の語（表記）。空なら全文から選ぶ。 */
  readonly known?: ReadonlySet<string>;
  readonly sceneId?: string;
}

/** 助詞・助動詞・記号は既習判定の対象外。 */
const FUNCTION_POS = new Set(['助詞', '助動詞', '記号', 'フィラー', '感動詞']);

/**
 * 書ける文だけを出す。
 *
 * 読むのと違い、書くのは未習の語が一つでも混じると手が止まる
 * ——読解は前後から推測できるが、作文は語を知らなければ書きようがない。
 */
function writable(sentence: Sentence, known: ReadonlySet<string>): boolean {
  if (known.size === 0) return true;
  return sentence.tokens.every(
    (token) =>
      FUNCTION_POS.has(token.p) ||
      known.has(token.s) ||
      known.has(token.r ?? ''),
  );
}

export function nextCompositionQuestion(
  options: CompositionOptions,
): CompositionQuestion | undefined {
  const known = options.known ?? new Set<string>();
  const scene =
    options.sceneId === undefined ? undefined : SCENE_BY_ID.get(options.sceneId);
  const source =
    scene === undefined
      ? TRANSLATED
      : sceneSentences(scene).filter((sentence) => sentence.zh !== undefined);

  const pool = source.filter((sentence) => writable(sentence, known));
  // 書ける文が足りないうちは全体から出す。短い文が混ざるので手は動く。
  const chosen = pool.length >= 5 ? pool : source;
  if (chosen.length === 0) return undefined;

  const index = Math.min(
    chosen.length - 1,
    Math.floor(options.random() * chosen.length),
  );
  const target = chosen[index];
  if (target?.zh === undefined) return undefined;
  return {
    sentenceId: target.id,
    meaning: target.zh,
    reference: target.text,
  };
}

export interface CompositionResult {
  readonly correct: boolean;
  /** どこで決まったか。費用と再現性を追うのに使う。 */
  readonly source: CompositionSource;
  /** 手本。判定にかかわらず必ず見せる。 */
  readonly reference: string;
  /** 学習者に見せる一言（中国語）。無ければ空。 */
  readonly note: string;
}

/**
 * 送り仮名や句読点の揺れを吸収する。
 *
 * 「私は学生です」と「私は学生です。」を別物として扱うと、
 * 句点を打たなかっただけで模型を呼ぶことになる。
 */
function normalize(text: string): string {
  return text
    .replace(/[\s　]/gu, '')
    .replace(/[。．.！!？?、，,]/gu, '')
    .trim();
}

export interface JudgeDeps {
  /** 形態素解析。規則層に渡す。 */
  readonly analyze: (text: string) => Promise<readonly Token[]>;
  readonly detectIssues: (tokens: readonly Token[]) => readonly GrammarIssue[];
  /** 模型の判定。省略すると規則層までで止まる。 */
  readonly judge?: (input: {
    meaning: string;
    reference: string;
    written: string;
    ruleFindings: readonly string[];
  }) => Promise<CompositionVerdict | undefined>;
}

export async function gradeComposition(
  sentenceId: string,
  written: string,
  deps: JudgeDeps,
): Promise<CompositionResult | undefined> {
  const sentence = SENTENCES_BY_ID.get(sentenceId);
  if (sentence?.zh === undefined) return undefined;
  const reference = sentence.text;

  // ── 1 段目：手本と一致。模型を呼ばない。
  if (normalize(written) === normalize(reference)) {
    return { correct: true, source: 'EXACT', reference, note: '' };
  }

  // ── 2 段目：規則で確定できる誤り。模型を呼ばない。
  let findings: readonly GrammarIssue[] = [];
  try {
    findings = deps.detectIssues(await deps.analyze(written));
  } catch {
    // 解析できなくても採点は続ける。辞書が落ちているだけで
    // 練習が止まるのは割に合わない。
    findings = [];
  }
  if (findings.length > 0) {
    return {
      correct: false,
      source: 'RULE',
      reference,
      note: findings.map((issue) => issue.explanation).join('\n'),
    };
  }

  // ── 3 段目：模型に訊く。
  if (deps.judge === undefined) {
    return { correct: false, source: 'UNJUDGED', reference, note: '' };
  }
  const verdict = await deps.judge({
    meaning: sentence.zh,
    reference,
    written,
    ruleFindings: findings.map((issue) => issue.explanation),
  });
  if (verdict === undefined) {
    // 模型が答えなかった。「間違い」とは言わない——判定できていない。
    return { correct: false, source: 'UNJUDGED', reference, note: '' };
  }
  return {
    correct: verdict.ok,
    source: 'MODEL',
    reference,
    note: verdict.note.trim(),
  };
}

/**
 * 作文に使えた既習の語（`USED_SPONTANEOUSLY` の材料、§3.2）。
 *
 * 正しく書けた文の中の既習語だけを返す。誤った文の語を「使えた」と
 * 数えると、間違った使い方をしたものが習得済みに寄ってしまう。
 */
export function spontaneousWords(
  tokens: readonly Token[],
  known: ReadonlySet<string>,
): string[] {
  const used = new Set<string>();
  for (const token of tokens) {
    if (FUNCTION_POS.has(token.pos)) continue;
    if (known.has(token.surface)) used.add(token.surface);
    else if (known.has(token.basicForm)) used.add(token.basicForm);
  }
  return [...used];
}

/**
 * 出題本文から、どの文を訊いたかを引き当てる。
 *
 * 出題に載っているのは中国語だけなので、それを鍵にする。同じ訳を持つ文が
 * 複数あるときは先に見つけたものを使う——どちらも同じ意味の手本なので、
 * どちらを見せても学習者にとっては正しい。
 */
let meaningIndex: Map<string, string> | undefined;

export function sentenceOfCompositionQuestion(
  text: string,
): string | undefined {
  if (meaningIndex === undefined) {
    meaningIndex = new Map();
    for (const sentence of TRANSLATED) {
      if (sentence.zh === undefined) continue;
      if (!meaningIndex.has(sentence.zh)) {
        meaningIndex.set(sentence.zh, sentence.id);
      }
    }
  }
  for (const line of text.split('\n')) {
    const found = meaningIndex.get(line.trim());
    if (found !== undefined) return found;
  }
  return undefined;
}
