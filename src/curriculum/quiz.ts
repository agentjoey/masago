/**
 * 仮名の出題（V2 §2.1 / §4.3 の第一段：選択式）。
 *
 * 純粋関数。乱数も引数で受け取る——出題は「たまたま正しく見える」ことが
 * 一番怖い種類のコードで、固定した乱数で全パターンを踏めないと検証にならない。
 */
import {
  CONFUSABLES,
  HOMOPHONE_PAIRS,
  KANA,
  KANA_BY_ID,
  kanaGlyph,
  type Kana,
  type KanaScript,
} from './kana.js';

export type QuestionKind =
  /** 字を見せて読みを選ばせる。 */
  | 'GLYPH_TO_ROMAJI'
  /** 読みを見せて字を選ばせる。 */
  | 'ROMAJI_TO_GLYPH'
  /** 音を聞かせて字を選ばせる。音声そのものは呼び出し側が送る。 */
  | 'AUDIO_TO_GLYPH';

export interface QuizOption {
  readonly kanaId: string;
  /** 選択肢に表示する文字列。 */
  readonly label: string;
}

export interface QuizQuestion {
  readonly kind: QuestionKind;
  readonly targetId: string;
  readonly script: KanaScript;
  /** 提示する側の文字列。AUDIO_TO_GLYPH では空（音声で提示するため）。 */
  readonly prompt: string;
  readonly options: readonly QuizOption[];
  /**
   * 正解となる選択肢の kanaId。
   *
   * 配列なのは保険ではなく事実：「ji」は じ とも ぢ とも読める。
   * 単一の正解を前提に書くと、いつか答えられない問題を平然と出す。
   * ここは仮定せず、選択肢から実際に判定して埋める。
   */
  readonly correctIds: readonly string[];
}

/** [0, 1) を返す乱数。テストでは決定的な列を渡す。 */
export type Random = () => number;

const CONFUSABLE_BY_ID = new Map<string, Map<KanaScript, Set<string>>>();
for (const set of CONFUSABLES) {
  for (const id of set.ids) {
    const byScript = CONFUSABLE_BY_ID.get(id) ?? new Map();
    const peers = byScript.get(set.script) ?? new Set<string>();
    for (const other of set.ids) {
      if (other !== id) peers.add(other);
    }
    byScript.set(set.script, peers);
    CONFUSABLE_BY_ID.set(id, byScript);
  }
}

/** 音が同じ仮名の組。を/お のようにローマ字が違っても同音のものがある。 */
const HOMOPHONES_BY_ID = new Map<string, Set<string>>();
for (const [left, right] of HOMOPHONE_PAIRS) {
  const pairs: readonly (readonly [string, string])[] = [
    [left, right],
    [right, left],
  ];
  for (const [a, b] of pairs) {
    const peers = HOMOPHONES_BY_ID.get(a) ?? new Set<string>();
    peers.add(b);
    HOMOPHONES_BY_ID.set(a, peers);
  }
}

/**
 * その出題形式で、この仮名と見分けがつかない仮名。
 *
 * 形式ごとに違う：字を選ばせるなら読みが同じものが紛れると答えが二つになり、
 * 音で出すなら を と お のように綴りが違っても区別できない。
 */
function indistinguishableFrom(
  target: Kana,
  kind: QuestionKind,
): ReadonlySet<string> {
  const ids = new Set<string>();
  if (kind === 'GLYPH_TO_ROMAJI' || kind === 'ROMAJI_TO_GLYPH') {
    for (const kana of KANA) {
      if (kana.id !== target.id && kana.romaji === target.romaji) {
        ids.add(kana.id);
      }
    }
  }
  if (kind === 'AUDIO_TO_GLYPH') {
    for (const id of HOMOPHONES_BY_ID.get(target.id) ?? []) {
      ids.add(id);
    }
  }
  return ids;
}

function shuffle<T>(items: readonly T[], random: Random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = out[i];
    const b = out[j];
    // 範囲外は起きないが、noUncheckedIndexedAccess の下では確認が要る。
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

/**
 * 誤答の候補を「紛らわしい順」に層で集める。
 *
 * 無作為に選ぶと、シ と ツ を並べずに一生を終えかねない。零基礎が
 * 詰まるのはまさにそこなので、混同しやすい組を優先して当てにいく（§2.2）。
 */
function distractorTiers(
  target: Kana,
  script: KanaScript,
  pool: readonly Kana[],
  excluded: ReadonlySet<string>,
): Kana[][] {
  const usable = pool.filter(
    (kana) => kana.id !== target.id && !excluded.has(kana.id),
  );
  const confusable = CONFUSABLE_BY_ID.get(target.id)?.get(script) ?? new Set();

  const tier1 = usable.filter((kana) => confusable.has(kana.id));
  const tier2 = usable.filter(
    (kana) => !confusable.has(kana.id) && kana.row === target.row,
  );
  const tier3 = usable.filter(
    (kana) =>
      !confusable.has(kana.id) &&
      kana.row !== target.row &&
      kana.group === target.group,
  );
  const tier4 = usable.filter(
    (kana) =>
      !confusable.has(kana.id) &&
      kana.row !== target.row &&
      kana.group !== target.group,
  );
  return [tier1, tier2, tier3, tier4];
}

export interface BuildQuestionOptions {
  readonly kind: QuestionKind;
  readonly script: KanaScript;
  readonly optionCount: number;
  readonly random: Random;
  /**
   * 誤答を取ってよい範囲。既習の仮名だけを渡すこと——未習の字を
   * 誤答に混ぜると、答えられて当然の問題が「知らない字だらけ」になる。
   * 省略時は全仮名。
   */
  readonly pool?: readonly Kana[];
}

export function buildQuestion(
  target: Kana,
  options: BuildQuestionOptions,
): QuizQuestion {
  const { kind, script, optionCount, random } = options;
  const pool = options.pool ?? KANA;

  const excluded = indistinguishableFrom(target, kind);
  const tiers = distractorTiers(target, script, pool, excluded);

  const picked: Kana[] = [];
  for (const tier of tiers) {
    if (picked.length >= optionCount - 1) break;
    for (const kana of shuffle(tier, random)) {
      if (picked.length >= optionCount - 1) break;
      picked.push(kana);
    }
  }

  const label = (kana: Kana): string =>
    kind === 'GLYPH_TO_ROMAJI' ? kana.romaji : kanaGlyph(kana, script);

  const shuffled = shuffle([target, ...picked], random);
  const quizOptions: QuizOption[] = shuffled.map((kana) => ({
    kanaId: kana.id,
    label: label(kana),
  }));

  // 正解は仮定せず、選択肢から判定する。誤答の選び方を後で変えても、
  // 正解の集合が黙ってずれることがない。
  const correctIds = quizOptions
    .filter(
      (option) =>
        option.kanaId === target.id ||
        indistinguishableFrom(target, kind).has(option.kanaId),
    )
    .map((option) => option.kanaId);

  const prompt =
    kind === 'GLYPH_TO_ROMAJI'
      ? kanaGlyph(target, script)
      : kind === 'ROMAJI_TO_GLYPH'
        ? target.romaji
        : '';

  return {
    kind,
    targetId: target.id,
    script,
    prompt,
    options: quizOptions,
    correctIds,
  };
}

/** 選んだ選択肢が正解か。 */
export function isCorrectChoice(
  question: QuizQuestion,
  kanaId: string,
): boolean {
  return question.correctIds.includes(kanaId);
}

/**
 * 打ち込まれたローマ字が正解か。§4.3 の第二段で使う。
 *
 * 「ji」と打たれたら じ でも ぢ でも通す——ローマ字だけでは本当に
 * 区別できないので、正しく打てたものを不正解にしてはいけない。
 */
export function isCorrectRomaji(targetId: string, typed: string): boolean {
  const target = KANA_BY_ID.get(targetId);
  if (target === undefined) return false;
  const normalized = typed.trim().toLowerCase();
  if (normalized === target.romaji) return true;
  // 訓令式で打つ人もいる（si / ti / tu / hu / zi …）。
  return normalized === target.id;
}
