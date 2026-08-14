import type { Analyzer } from './analyzer.js';
import { detectGrammarIssues, type GrammarIssue } from './grammar.js';

/**
 * 規則で見つけた誤りを、模型が出した一覧に足す（V2 §8）。
 *
 * 模型が既に同じ箇所を挙げていれば足さない——学習者に同じ指摘を二度
 * 見せないため。逆に模型が見落としていた分だけが増える。
 */

export interface DetectedLike {
  readonly knowledgeKey: string;
  readonly original: string;
}

export interface CrossCheckResult {
  /** 模型が見落としていた、規則で確実に言える誤り。 */
  readonly added: readonly GrammarIssue[];
  /** 解析できたか。落ちても学習は止めないので、結果だけ残す。 */
  readonly analyzed: boolean;
}

export interface CrossCheckOptions {
  readonly analyzer: Analyzer;
  /** 模型が既に挙げている誤り。 */
  readonly alreadyDetected: readonly DetectedLike[];
  /** 解析に失敗したときに残す。 */
  readonly onError?: (error: unknown) => void;
}

export async function crossCheck(
  text: string,
  options: CrossCheckOptions,
): Promise<CrossCheckResult> {
  try {
    const tokens = await options.analyzer.tokenize(text);
    const issues = detectGrammarIssues(tokens);

    // 同じ鍵で既に挙がっていれば重ねない。表記が少し違っても、
    // 指摘の中身が同じなら学習者にとっては同じ一件。
    const seen = new Set(
      options.alreadyDetected.map((issue) => issue.knowledgeKey),
    );
    return {
      added: issues.filter((issue) => !seen.has(issue.knowledgeKey)),
      analyzed: true,
    };
  } catch (error) {
    // 形態素解析は補助。落ちても会話は成立させる——ここで投げると、
    // 辞書が読めないだけで返事が返らなくなる。
    options.onError?.(error);
    return { added: [], analyzed: false };
  }
}
