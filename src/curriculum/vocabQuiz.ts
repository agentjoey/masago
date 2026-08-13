/**
 * 語彙の出題（V2 §2.1 の S1）。
 *
 * 純粋関数。乱数も引数で受け取る——仮名のときと同じで、出題は
 * 「たまたま正しく見える」のが一番危ない。
 */
import type { Random } from './quiz.js';
export type { Random };
import { VOCAB_N5, VOCAB_N5_BY_ID, type VocabEntry } from './vocabN5.js';

export type VocabQuestionKind =
  /** 語を見せて意味を選ばせる。 */
  | 'WORD_TO_MEANING'
  /** 意味を見せて語を選ばせる。 */
  | 'MEANING_TO_WORD';

export interface VocabOption {
  readonly vocabId: string;
  readonly label: string;
}

export interface VocabQuestion {
  readonly kind: VocabQuestionKind;
  readonly targetId: string;
  readonly prompt: string;
  /** 語を見せる問題では振り仮名を添える。意味を訊く側では出さない。 */
  readonly promptReading?: string;
  readonly options: readonly VocabOption[];
  readonly correctIds: readonly string[];
}

/**
 * 語義の第一義。ここが同じ語は、学習者から見て区別がつかない。
 *
 * 「blue」は 青 と 青い の両方、「student」は 学生 と 生徒 の両方。
 * どちらかを誤答に混ぜた瞬間、正解が二つある問題になる。
 * 完全一致だけを見ると "blue" と "blue, azure" を別物と判定して
 * すり抜けるので、第一義で比べる。
 */
function primarySense(meaning: string): string {
  return (meaning.split(/[,;]/)[0] ?? meaning).trim().toLowerCase();
}

const BY_SENSE = new Map<string, VocabEntry[]>();
for (const entry of VOCAB_N5) {
  const sense = primarySense(entry.meaning);
  BY_SENSE.set(sense, [...(BY_SENSE.get(sense) ?? []), entry]);
}

/** その出題形式で、この語と見分けがつかない語。 */
function indistinguishableFrom(target: VocabEntry): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const peer of BY_SENSE.get(primarySense(target.meaning)) ?? []) {
    if (peer.id !== target.id) ids.add(peer.id);
  }
  return ids;
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

/**
 * 誤答は「同じ課で習った語」を優先する。
 *
 * 無関係な語ばかり並ぶと、意味を思い出さなくても消去法で当たる
 * （食べ物の問題に曜日が三つ並んでいれば、意味を知らなくても解ける）。
 * 同じ課の語は場面が近いので、ちゃんと区別できないと当たらない。
 */
function distractorTiers(
  target: VocabEntry,
  pool: readonly VocabEntry[],
  excluded: ReadonlySet<string>,
): VocabEntry[][] {
  const usable = pool.filter(
    (entry) =>
      entry.id !== target.id &&
      !excluded.has(entry.id) &&
      entry.isAffix !== true,
  );
  const sameLesson = usable.filter(
    (entry) =>
      target.genkiLesson !== undefined &&
      entry.genkiLesson === target.genkiLesson,
  );
  const nearLesson = usable.filter(
    (entry) =>
      target.genkiLesson !== undefined &&
      entry.genkiLesson !== undefined &&
      entry.genkiLesson !== target.genkiLesson &&
      Math.abs(entry.genkiLesson - target.genkiLesson) <= 2,
  );
  const rest = usable.filter(
    (entry) => !sameLesson.includes(entry) && !nearLesson.includes(entry),
  );
  return [sameLesson, nearLesson, rest];
}

export interface BuildVocabQuestionOptions {
  readonly kind: VocabQuestionKind;
  readonly optionCount: number;
  readonly random: Random;
  /** 誤答を取る範囲。既習の語だけを渡す。 */
  readonly pool?: readonly VocabEntry[];
}

export function buildVocabQuestion(
  target: VocabEntry,
  options: BuildVocabQuestionOptions,
): VocabQuestion {
  const pool = options.pool ?? VOCAB_N5;
  const excluded = indistinguishableFrom(target);
  const tiers = distractorTiers(target, pool, excluded);

  const label = (entry: VocabEntry): string =>
    options.kind === 'WORD_TO_MEANING' ? entry.meaning : entry.expression;

  // 表示が重複する選択肢を作らない。
  //
  // 対象と紛らわしい語は excluded で除いてあるが、それだけでは
  // **誤答同士**が同じ見た目になるのを防げない（青 と 青い を二つとも
  // 誤答に選べば、どちらも "blue" と表示される）。意味を訊く側では
  // 語義が、語を訊く側では表記が衝突する（一日 は読み違いで二語ある）。
  // どちらも「同じボタンが並ぶ」ので、表示そのもので弾く。
  const usedLabels = new Set<string>([label(target)]);
  const picked: VocabEntry[] = [];
  for (const tier of tiers) {
    if (picked.length >= options.optionCount - 1) break;
    for (const entry of shuffle(tier, options.random)) {
      if (picked.length >= options.optionCount - 1) break;
      const text = label(entry);
      if (usedLabels.has(text)) continue;
      usedLabels.add(text);
      picked.push(entry);
    }
  }

  const shuffled = shuffle([target, ...picked], options.random);
  const quizOptions = shuffled.map((entry) => ({
    vocabId: entry.id,
    label: label(entry),
  }));

  // 正解は仮定せず、選択肢から判定する。
  const correctIds = quizOptions
    .filter(
      (option) =>
        option.vocabId === target.id || excluded.has(option.vocabId),
    )
    .map((option) => option.vocabId);

  return {
    kind: options.kind,
    targetId: target.id,
    prompt:
      options.kind === 'WORD_TO_MEANING' ? target.expression : target.meaning,
    // 読めない字は覚えようが無い。語を見せる側では必ず振り仮名を添える。
    ...(options.kind === 'WORD_TO_MEANING'
      ? { promptReading: target.reading }
      : {}),
    options: quizOptions,
    correctIds,
  };
}

/** 出題を保持せずに採点する。仮名と同じ考え方。 */
export function isCorrectVocabAnswer(
  targetId: string,
  chosenId: string,
): boolean {
  const target = VOCAB_N5_BY_ID.get(targetId);
  if (target === undefined) return false;
  if (chosenId === targetId) return true;
  return indistinguishableFrom(target).has(chosenId);
}

/**
 * 打ち込みの答え（読みをローマ字ではなく仮名で受ける）。
 *
 * S1 の学習者は仮名を打てる。表記そのものでも読みでも通す——
 * 「今」と打っても「いま」と打っても、その語を知っていることに変わりはない。
 */
export function isCorrectVocabTyped(targetId: string, typed: string): boolean {
  const target = VOCAB_N5_BY_ID.get(targetId);
  if (target === undefined) return false;
  const normalized = typed.trim();
  if (normalized === '') return false;

  // 語義から書かせる問題では、同義の語はどれも正しい。「blue」と訊いて
  // 青 と 青い のどちらを書いても、その意味を知っていることに変わりはない。
  const accepted = [target, ...(BY_SENSE.get(primarySense(target.meaning)) ?? [])];
  return accepted.some(
    (entry) =>
      normalized === entry.expression || normalized === entry.reading,
  );
}
