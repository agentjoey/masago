/**
 * どこまで進んだか（V2 §2.1 の S0 → S1）。
 *
 * 純粋関数。DB も時計も見ない。
 */
import { KANA } from './kana.js';
import { VOCAB_N5, type VocabEntry } from './vocabN5.js';

/** 清音の総数。ここが読めれば大半の語は音を追える。 */
export const SEION_COUNT = KANA.filter((kana) => kana.group === 'seion').length;

export type Stage =
  /** 五十音だけ。清音がまだ終わっていない。 */
  | 'S0_KANA_ONLY'
  /** 清音は終わった。語彙を始めつつ、濁音・拗音は並行して続ける。 */
  | 'S1_VOCAB'
  /** 五十音は全部導入済み。語彙が主線。 */
  | 'S1_VOCAB_ONLY';

/**
 * 語彙を始める境目は「清音が終わったか」。
 *
 * 濁音・拗音まで待つ必要は無い——が/ぱ/きゃ を知らなくても
 * 「わたし」「がくせい」の大半は読める。実際 Genki も一課から
 * 語彙を出す。逆に、清音の途中で語彙を混ぜると読めない字だらけになる。
 */
export function stageOf(introducedKanaCount: number): Stage {
  if (introducedKanaCount < SEION_COUNT) return 'S0_KANA_ONLY';
  if (introducedKanaCount < KANA.length) return 'S1_VOCAB';
  return 'S1_VOCAB_ONLY';
}

export function teachesVocab(stage: Stage): boolean {
  return stage !== 'S0_KANA_ONLY';
}

export interface VocabPlanInput {
  readonly introducedIds: readonly string[];
  readonly dueIds: readonly string[];
  readonly newPerDay: number;
  readonly maxReviews: number;
  readonly backlogThreshold: number;
}

export interface VocabPlan {
  readonly newWords: readonly VocabEntry[];
  readonly reviewWords: readonly VocabEntry[];
  readonly newHeldBackForBacklog: boolean;
}

const VOCAB_BY_ID = new Map(VOCAB_N5.map((entry) => [entry.id, entry]));

/**
 * 次に導入する語を選ぶ。
 *
 * 接辞（～円、～時）は単独では語にならないので新出には出さない。
 * 「～円という単語がある」と覚えられると、後で解くのが面倒な誤解になる。
 */
export function planVocabLesson(input: VocabPlanInput): VocabPlan {
  const introduced = new Set(input.introducedIds);

  const reviewWords = input.dueIds
    .map((id) => VOCAB_BY_ID.get(id))
    .filter((entry): entry is VocabEntry => entry !== undefined)
    .slice(0, Math.max(0, input.maxReviews));

  const backlog = input.dueIds.length;
  const newHeldBackForBacklog = backlog > input.backlogThreshold;

  const newWords = newHeldBackForBacklog
    ? []
    : VOCAB_N5.filter(
        (entry) => !introduced.has(entry.id) && entry.isAffix !== true,
      ).slice(0, Math.max(0, input.newPerDay));

  return { newWords, reviewWords, newHeldBackForBacklog };
}

export function vocabProgress(introducedIds: readonly string[]): {
  introduced: number;
  total: number;
} {
  const introduced = new Set(introducedIds);
  const teachable = VOCAB_N5.filter((entry) => entry.isAffix !== true);
  return {
    introduced: teachable.filter((entry) => introduced.has(entry.id)).length,
    total: teachable.length,
  };
}

/**
 * 会話で使う水準。課程の進み具合から出す。
 *
 * プロフィールに書いた文字列ではなく、実際に何を習ったかで決める。
 * 清音すら終えていない人に日本語で返しても、一文字も読めない。
 */
export function conversationLevel(
  introducedKanaCount: number,
): 'zero' | 'beginner' {
  return introducedKanaCount < SEION_COUNT ? 'zero' : 'beginner';
}
