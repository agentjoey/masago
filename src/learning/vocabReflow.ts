import { VOCAB, type VocabEntry } from '../curriculum/vocab.js';
import type { Executor } from '../db/repositories/executor.js';
import * as reviewQueue from '../db/repositories/reviewQueue.js';
import { vocabOfKey } from '../curriculum/vocab.js';
import type { Token } from '../nlp/index.js';
import { recordSpontaneousUse } from './review.js';
import { resolveVocabItemIds } from './vocabSeed.js';

/**
 * 会話で使えた語を FSRS に戻す（§3.2 の最終行 / scenario-learning.md §4）。
 *
 * 出題に答えるのと、話の中で自分から使うのは、違う種類の証拠である。
 * 後者のほうが強い——選択肢も文脈も無いところで出てきたのだから。
 * §3.2 はこれを Easy と定めている。
 *
 * ## 数えない三つ
 *
 * 1. **未習の語**（キューに無い）。たまたま書けたことは「復習」ではなく、
 *    導入の順は課程が決める（§2.4）
 * 2. **誤りに巻き込まれた語**。「本を読むます」の 読む は使えていない
 * 3. **同じ日の二回目以降**（`recordSpontaneousUse` が畳む）。会話で五回
 *    使っても証拠は一つで、使うたびに Easy を積むと目の前の字を写しただけで
 *    間隔が伸びる
 */

const FUNCTION_POS = new Set(['助詞', '助動詞', '記号', 'フィラー', '感動詞']);

export interface DetectedFragment {
  readonly original: string;
}

/**
 * 使えたと数えてよい語を選ぶ。
 *
 * `known` は既習語の表記と読み。誤りの断片に文字が重なる語は落とす
 * ——誤り箇所の内訳までは分からないので、疑わしいほうを外す。
 */
export function creditableWords(
  tokens: readonly Token[],
  known: ReadonlySet<string>,
  detected: readonly DetectedFragment[] = [],
): string[] {
  const suspect = detected
    .map((issue) => issue.original)
    .filter((text) => text.trim() !== '');

  const used = new Set<string>();
  for (const token of tokens) {
    if (FUNCTION_POS.has(token.pos)) continue;
    const form = known.has(token.surface)
      ? token.surface
      : known.has(token.basicForm)
        ? token.basicForm
        : undefined;
    if (form === undefined) continue;
    // 誤りの断片に含まれる語は数えない。
    if (suspect.some((fragment) => fragment.includes(token.surface))) continue;
    used.add(form);
  }
  return [...used];
}

/** 表記・読み → 語彙 id。同じ表記に複数の項目があれば全部返す。 */
function vocabIdsOf(forms: readonly string[]): string[] {
  const wanted = new Set(forms);
  const ids: string[] = [];
  for (const entry of VOCAB) {
    if (wanted.has(entry.expression) || wanted.has(entry.reading)) {
      ids.push(entry.id);
    }
  }
  return ids;
}

export interface ReflowDeps {
  readonly executor: Executor;
  readonly analyze: (text: string) => Promise<readonly Token[]>;
  readonly requestRetention: number;
  /** 学習者の地域時間での日付キー。一日一回に畳むのに使う。 */
  readonly dayKey: (now: Date) => string;
}

export interface ReflowResult {
  /** 実際に記録した語彙 id。 */
  readonly recorded: readonly string[];
  /** 使えていたが今日は既に記録済みだった語も含む、候補の数。 */
  readonly candidates: number;
}

/**
 * 一つの発話から語彙の回流を記録する。
 *
 * 失敗しても投げない。会話の返事は既に送られていて、これは後処理
 * ——解析器が落ちていることを理由に会話を止める理由が無い。
 */
export async function reflowVocabulary(
  deps: ReflowDeps,
  learnerId: string,
  text: string,
  now: Date,
  detected: readonly DetectedFragment[] = [],
): Promise<ReflowResult> {
  let tokens: readonly Token[];
  try {
    tokens = await deps.analyze(text);
  } catch {
    return { recorded: [], candidates: 0 };
  }

  const known = await knownForms(deps.executor, learnerId);
  if (known.size === 0) return { recorded: [], candidates: 0 };

  const forms = creditableWords(tokens, known, detected);
  const vocabIds = vocabIdsOf(forms);
  if (vocabIds.length === 0) return { recorded: [], candidates: 0 };

  const itemIds = await resolveVocabItemIds(deps.executor, vocabIds);
  const recordedItems = await recordSpontaneousUse(
    deps.executor,
    learnerId,
    [...itemIds.values()],
    now,
    deps.requestRetention,
    deps.dayKey(now),
  );

  const byItemId = new Map(
    [...itemIds.entries()].map(([vocabId, itemId]) => [itemId, vocabId]),
  );
  return {
    recorded: recordedItems
      .map((itemId) => byItemId.get(itemId))
      .filter((id): id is string => id !== undefined),
    candidates: vocabIds.length,
  };
}

/** 既習の語（表記と読み）。 */
async function knownForms(
  tx: Executor,
  learnerId: string,
): Promise<Set<string>> {
  const keys = await reviewQueue.listIntroducedKeys(tx, learnerId, 'VOCABULARY');
  const known = new Set<string>();
  for (const key of keys) {
    const entry: VocabEntry | undefined = vocabOfKey(key);
    if (entry === undefined) continue;
    known.add(entry.expression);
    known.add(entry.reading);
  }
  return known;
}
