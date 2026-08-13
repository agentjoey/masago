/**
 * 復習スケジューリング（V2 §3.1 / §3.2）。
 *
 * ここは純粋関数だけで構成する。DB も設定も時計も触らない——引数で受け取る。
 * 間隔の計算は「プログラムが決める」ことが V1.1 からの一貫した原則であり、
 * モデルに点数や日数を書かせない。FSRS はその計算を素朴な固定間隔から
 * 検証済みのアルゴリズムに置き換えるだけで、責任の所在は変えない。
 */
import { createEmptyCard, fsrs, Rating, State, type Card, type Grade } from 'ts-fsrs';

/** 入力方式。応答時間の意味が方式ごとに違うため、速さの判定に必要。 */
export type InputMode = 'CHOICE' | 'ROMAJI' | 'JAPANESE';

/**
 * プログラムが観測できる事実だけを持つ。「難しかったか」のような
 * 主観はここに入れない——モデルにも学習者にも評定させないため。
 */
export type ReviewOutcome =
  | {
      kind: 'CORRECT';
      /** ヒント（選択肢の絞り込み、頭文字、ローマ字併記など）を出したか。 */
      hinted: boolean;
      inputMode: InputMode;
      /** 出題から解答までの実測。取れない場合は undefined。 */
      responseMs?: number;
    }
  | { kind: 'INCORRECT' }
  /** 出題ではなく、自然な発話の中で正しく使えた（§3.2 の最終行）。 */
  | { kind: 'SPONTANEOUS' };

/**
 * 「速い」の閾値。入力方式で全く違う。ボタン一つ押すのと
 * スマホでローマ字を打つのを同じ物差しで測ると、打鍵の遅さを
 * 「思い出せていない」と読み違え、難易度推定が狂う。
 */
const FAST_RESPONSE_MS: Record<InputMode, number> = {
  CHOICE: 3_000,
  ROMAJI: 6_000,
  JAPANESE: 10_000,
};

/**
 * §3.2 の対応表をそのまま実装する。
 *
 * 応答時間が取れなかったときは Good に倒す。Easy は間隔を大きく伸ばすので、
 * 計測できていないことを根拠に伸ばすと取りこぼす。安全側は短いほう。
 */
export function ratingOf(outcome: ReviewOutcome): Grade {
  switch (outcome.kind) {
    case 'INCORRECT':
      return Rating.Again;
    case 'SPONTANEOUS':
      return Rating.Easy;
    case 'CORRECT': {
      if (outcome.hinted) {
        return Rating.Hard;
      }
      const { responseMs } = outcome;
      if (responseMs === undefined) {
        return Rating.Good;
      }
      return responseMs <= FAST_RESPONSE_MS[outcome.inputMode]
        ? Rating.Easy
        : Rating.Good;
    }
  }
}

/**
 * 初回だけは Easy を与えない（§3.2 の表に対する明示的な例外）。
 *
 * FSRS は新規カードに Easy が付くと学習ステップを飛ばして一気に 8 日後へ送る。
 * だが初出の仮名を四択で当てられても、25% は偶然で当たる。教わった 30 秒後の
 * 一回だけを根拠に 8 日消すのは、ゼロから始める学習者には賭けが大きすぎる。
 * Good なら 10 分後 → 2 日後と刻めるので、取りこぼしても傷が浅い。
 *
 * 二回目以降は表のとおり。偶然の正解は続かないので、履歴が増えれば均される。
 */
function capFirstExposure(rating: Grade, current: ReviewCardState): Grade {
  if (current.reps === 0 && rating === Rating.Easy) {
    return Rating.Good;
  }
  return rating;
}

/** DB に永続化する復習状態。`review_queue` の FSRS 由来の列と 1:1。 */
export interface ReviewCardState {
  nextReviewAt: Date;
  intervalDays: number;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  lastReview: Date | null;
  state: ReviewStateName;
}

export type ReviewStateName =
  | 'NEW'
  | 'LEARNING'
  | 'REVIEW'
  | 'RELEARNING'
  | 'MASTERED';

const STATE_TO_FSRS: Record<ReviewStateName, State> = {
  NEW: State.New,
  LEARNING: State.Learning,
  REVIEW: State.Review,
  RELEARNING: State.Relearning,
  // MASTERED は FSRS の状態ではなく本システム独自の段階。習得済みでも
  // 忘却は進むので、FSRS から見れば通常の Review 項目として扱う。
  MASTERED: State.Review,
};

const FSRS_TO_STATE: Record<State, ReviewStateName> = {
  [State.New]: 'NEW',
  [State.Learning]: 'LEARNING',
  [State.Review]: 'REVIEW',
  [State.Relearning]: 'RELEARNING',
};

function toCard(state: ReviewCardState): Card {
  return {
    due: state.nextReviewAt,
    stability: state.stability,
    difficulty: state.difficulty,
    elapsed_days: state.elapsedDays,
    scheduled_days: state.intervalDays,
    learning_steps: state.learningSteps,
    reps: state.reps,
    lapses: state.lapses,
    state: STATE_TO_FSRS[state.state],
    ...(state.lastReview === null ? {} : { last_review: state.lastReview }),
  };
}

function fromCard(card: Card, previous: ReviewStateName): ReviewCardState {
  const next = FSRS_TO_STATE[card.state];
  return {
    nextReviewAt: card.due,
    intervalDays: card.scheduled_days,
    stability: card.stability,
    difficulty: card.difficulty,
    elapsedDays: card.elapsed_days,
    learningSteps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    lastReview: card.last_review ?? null,
    // 一度 MASTERED にした項目を、FSRS が Review を返したというだけで
    // 引き下げない。降格は「間違えた」という事実でのみ起きるべき。
    state:
      previous === 'MASTERED' && card.state === State.Review ? 'MASTERED' : next,
  };
}

/** まだ一度も出題していない項目の初期状態。 */
export function newCardState(now: Date): ReviewCardState {
  return fromCard(createEmptyCard(now), 'NEW');
}

export interface ScheduleResult {
  state: ReviewCardState;
  rating: Grade;
}

/**
 * 一回の復習結果を反映して次回日時を計算する。
 *
 * `now` は必ず呼び出し側から渡す。内部で `new Date()` を読むと
 * テストが時計に依存し、境界の挙動を固定できなくなる。
 */
export function scheduleNext(
  current: ReviewCardState,
  outcome: ReviewOutcome,
  now: Date,
  requestRetention: number,
): ScheduleResult {
  const rating = capFirstExposure(ratingOf(outcome), current);
  const scheduler = fsrs({ request_retention: requestRetention });
  const { card } = scheduler.next(toCard(current), now, rating);
  return { state: fromCard(card, current.state), rating };
}

/**
 * 現時点での想起確率（0–1）。§2.5 の優先度式が使う「忘却リスク」は
 * その裏返し（1 - retrievability）。
 */
export function retrievabilityOf(
  state: ReviewCardState,
  now: Date,
  requestRetention: number,
): number {
  if (state.state === 'NEW' || state.lastReview === null) {
    // 未学習に想起確率は定義できない。忘却リスク最大として扱う。
    return 0;
  }
  const scheduler = fsrs({ request_retention: requestRetention });
  return scheduler.get_retrievability(toCard(state), now, false);
}

/** §2.5 の「忘却リスク」項。 */
export function forgettingRiskOf(
  state: ReviewCardState,
  now: Date,
  requestRetention: number,
): number {
  return 1 - retrievabilityOf(state, now, requestRetention);
}
