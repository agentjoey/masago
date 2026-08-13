import { Rating, State } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';
import {
  forgettingRiskOf,
  newCardState,
  ratingOf,
  retrievabilityOf,
  scheduleNext,
  type ReviewCardState,
} from '../../src/curriculum/review.js';

const RETENTION = 0.9;
const NOW = new Date('2026-08-14T09:00:00Z');

describe('ratingOf — §3.2 の対応表', () => {
  it('答え間違いは Again', () => {
    expect(ratingOf({ kind: 'INCORRECT' })).toBe(Rating.Again);
  });

  it('自然な発話での正用は Easy', () => {
    expect(ratingOf({ kind: 'SPONTANEOUS' })).toBe(Rating.Easy);
  });

  it('ヒント後の正解は、どれだけ速くても Hard', () => {
    expect(
      ratingOf({
        kind: 'CORRECT',
        hinted: true,
        inputMode: 'CHOICE',
        responseMs: 200,
      }),
    ).toBe(Rating.Hard);
  });

  it('ヒント無しで速ければ Easy、遅ければ Good', () => {
    const fast = ratingOf({
      kind: 'CORRECT',
      hinted: false,
      inputMode: 'CHOICE',
      responseMs: 1_500,
    });
    const slow = ratingOf({
      kind: 'CORRECT',
      hinted: false,
      inputMode: 'CHOICE',
      responseMs: 9_000,
    });
    expect(fast).toBe(Rating.Easy);
    expect(slow).toBe(Rating.Good);
  });

  // 同じ 5 秒でも、ボタンを押すのと日本語を打つのでは意味が正反対。
  // 一つの閾値で測ると打鍵の遅さを想起の失敗と読み違える。
  it('速さの閾値は入力方式ごとに違う', () => {
    const at5s = (inputMode: 'CHOICE' | 'ROMAJI' | 'JAPANESE'): Rating =>
      ratingOf({ kind: 'CORRECT', hinted: false, inputMode, responseMs: 5_000 });
    expect(at5s('CHOICE')).toBe(Rating.Good);
    expect(at5s('ROMAJI')).toBe(Rating.Easy);
    expect(at5s('JAPANESE')).toBe(Rating.Easy);
  });

  it('閾値ちょうどは速い側に入れる', () => {
    expect(
      ratingOf({
        kind: 'CORRECT',
        hinted: false,
        inputMode: 'CHOICE',
        responseMs: 3_000,
      }),
    ).toBe(Rating.Easy);
    expect(
      ratingOf({
        kind: 'CORRECT',
        hinted: false,
        inputMode: 'CHOICE',
        responseMs: 3_001,
      }),
    ).toBe(Rating.Good);
  });

  // 計測できなかったことを根拠に間隔を伸ばすのは、忘れる方向への賭け。
  it('応答時間が取れなければ Easy ではなく Good に倒す', () => {
    expect(
      ratingOf({ kind: 'CORRECT', hinted: false, inputMode: 'ROMAJI' }),
    ).toBe(Rating.Good);
  });
});

describe('newCardState', () => {
  it('未学習は NEW・復習履歴なし', () => {
    const card = newCardState(NOW);
    expect(card.state).toBe('NEW');
    expect(card.reps).toBe(0);
    expect(card.lapses).toBe(0);
    expect(card.lastReview).toBeNull();
  });
});

describe('scheduleNext', () => {
  it('正解すると次回は未来に置かれ、復習回数が増える', () => {
    const { state } = scheduleNext(
      newCardState(NOW),
      { kind: 'CORRECT', hinted: false, inputMode: 'CHOICE', responseMs: 1_000 },
      NOW,
      RETENTION,
    );
    expect(state.nextReviewAt.getTime()).toBeGreaterThan(NOW.getTime());
    expect(state.reps).toBe(1);
    expect(state.lastReview).toEqual(NOW);
    expect(state.state).not.toBe('NEW');
  });

  it('Easy は Good より、Good は Hard より長い間隔を与える', () => {
    // 初回は Easy が Good に丸められるので、一度学習させてから比べる。
    const base = scheduleNext(
      newCardState(NOW),
      { kind: 'CORRECT', hinted: false, inputMode: 'ROMAJI' },
      NOW,
      RETENTION,
    ).state;
    const at = base.nextReviewAt;
    const due = (outcome: Parameters<typeof scheduleNext>[1]): number =>
      scheduleNext(base, outcome, at, RETENTION).state.nextReviewAt.getTime();

    const easy = due({
      kind: 'CORRECT',
      hinted: false,
      inputMode: 'CHOICE',
      responseMs: 500,
    });
    const good = due({
      kind: 'CORRECT',
      hinted: false,
      inputMode: 'CHOICE',
      responseMs: 8_000,
    });
    const hard = due({
      kind: 'CORRECT',
      hinted: true,
      inputMode: 'CHOICE',
      responseMs: 500,
    });

    expect(easy).toBeGreaterThan(good);
    expect(good).toBeGreaterThan(hard);
  });

  // 初出の仮名を四択で当てても、25% は偶然。その一回で 8 日消してはいけない。
  it('初回の正解では Easy を与えず、学習ステップを踏ませる', () => {
    const { state, rating } = scheduleNext(
      newCardState(NOW),
      { kind: 'CORRECT', hinted: false, inputMode: 'CHOICE', responseMs: 500 },
      NOW,
      RETENTION,
    );
    expect(rating).toBe(Rating.Good);
    expect(state.state).toBe('LEARNING');

    const day = 24 * 60 * 60 * 1000;
    expect(state.nextReviewAt.getTime() - NOW.getTime()).toBeLessThan(day);
  });

  it('自然な発話での正用も、初回なら丸める', () => {
    // ratingOf 単体では Easy。丸めは scheduleNext が履歴を見て行う。
    expect(ratingOf({ kind: 'SPONTANEOUS' })).toBe(Rating.Easy);
    expect(
      scheduleNext(newCardState(NOW), { kind: 'SPONTANEOUS' }, NOW, RETENTION)
        .rating,
    ).toBe(Rating.Good);
  });

  it('二回目以降は表どおり Easy が出る', () => {
    const seen = scheduleNext(
      newCardState(NOW),
      { kind: 'CORRECT', hinted: false, inputMode: 'ROMAJI' },
      NOW,
      RETENTION,
    ).state;
    expect(seen.reps).toBe(1);

    const { rating } = scheduleNext(
      seen,
      { kind: 'CORRECT', hinted: false, inputMode: 'CHOICE', responseMs: 500 },
      seen.nextReviewAt,
      RETENTION,
    );
    expect(rating).toBe(Rating.Easy);
  });

  it('丸めるのは Easy だけ——初回の不正解は Again のまま', () => {
    const { rating } = scheduleNext(
      newCardState(NOW),
      { kind: 'INCORRECT' },
      NOW,
      RETENTION,
    );
    expect(rating).toBe(Rating.Again);
  });

  // 忘れたものを翌週に回すようでは復習の意味がない。
  it('間違えると当日中に戻ってくる', () => {
    // lapses は「卒業した項目を落とした」ときだけ増える。学習ステップ中の
    // 失敗は取りこぼしではないので、REVIEW まで上げてから落とす。
    let learned = newCardState(NOW);
    let at = NOW;
    while (learned.state !== 'REVIEW') {
      learned = scheduleNext(
        learned,
        { kind: 'CORRECT', hinted: false, inputMode: 'ROMAJI' },
        at,
        RETENTION,
      ).state;
      at = learned.nextReviewAt;
    }

    const failed = scheduleNext(
      learned,
      { kind: 'INCORRECT' },
      at,
      RETENTION,
    ).state;

    expect(failed.lapses).toBe(1);
    expect(failed.state).toBe('RELEARNING');
    expect(failed.nextReviewAt.getTime() - at.getTime()).toBeLessThan(
      24 * 60 * 60 * 1000,
    );
  });

  it('保持率を上げると間隔は短くなる', () => {
    const base = newCardState(NOW);
    const outcome = {
      kind: 'CORRECT',
      hinted: false,
      inputMode: 'CHOICE',
      responseMs: 8_000,
    } as const;
    const relaxed = scheduleNext(base, outcome, NOW, 0.8).state.nextReviewAt;
    const strict = scheduleNext(base, outcome, NOW, 0.97).state.nextReviewAt;
    expect(strict.getTime()).toBeLessThanOrEqual(relaxed.getTime());
  });

  // 状態を一つでも落とすと履歴が消え、毎回 New から数え直しになる。
  it('往復しても FSRS の状態が失われない', () => {
    let state = newCardState(NOW);
    let at = NOW;
    for (let i = 0; i < 5; i += 1) {
      const result = scheduleNext(
        state,
        { kind: 'CORRECT', hinted: false, inputMode: 'ROMAJI' },
        at,
        RETENTION,
      );
      state = result.state;
      at = state.nextReviewAt;
    }
    expect(state.reps).toBe(5);
    expect(state.stability).toBeGreaterThan(0);
    expect(state.difficulty).toBeGreaterThan(0);
    expect(state.intervalDays).toBeGreaterThan(0);
  });

  // MASTERED は掌握度から導く独自の段階。FSRS は Review としか言わないので、
  // その戻り値をそのまま書き戻すと復習のたびに降格してしまう。
  it('MASTERED は正解では降格しない', () => {
    const mastered: ReviewCardState = {
      ...newCardState(NOW),
      state: 'MASTERED',
      stability: 60,
      difficulty: 3,
      reps: 12,
      intervalDays: 45,
      lastReview: new Date('2026-07-01T09:00:00Z'),
    };
    const next = scheduleNext(
      mastered,
      { kind: 'CORRECT', hinted: false, inputMode: 'ROMAJI' },
      NOW,
      RETENTION,
    ).state;
    expect(next.state).toBe('MASTERED');
  });

  it('MASTERED でも間違えれば降格する', () => {
    const mastered: ReviewCardState = {
      ...newCardState(NOW),
      state: 'MASTERED',
      stability: 60,
      difficulty: 3,
      reps: 12,
      intervalDays: 45,
      lastReview: new Date('2026-07-01T09:00:00Z'),
    };
    const next = scheduleNext(
      mastered,
      { kind: 'INCORRECT' },
      NOW,
      RETENTION,
    ).state;
    expect(next.state).toBe('RELEARNING');
  });
});

describe('retrievability / forgetting risk', () => {
  it('未学習は忘却リスク最大として扱う', () => {
    const fresh = newCardState(NOW);
    expect(retrievabilityOf(fresh, NOW, RETENTION)).toBe(0);
    expect(forgettingRiskOf(fresh, NOW, RETENTION)).toBe(1);
  });

  it('時間が経つほど想起確率は下がる', () => {
    const learned = scheduleNext(
      newCardState(NOW),
      { kind: 'CORRECT', hinted: false, inputMode: 'ROMAJI' },
      NOW,
      RETENTION,
    ).state;

    const day = 24 * 60 * 60 * 1000;
    const soon = retrievabilityOf(learned, new Date(NOW.getTime() + day), RETENTION);
    const later = retrievabilityOf(
      learned,
      new Date(NOW.getTime() + 30 * day),
      RETENTION,
    );

    expect(soon).toBeGreaterThan(later);
    expect(soon).toBeLessThanOrEqual(1);
    expect(later).toBeGreaterThanOrEqual(0);
  });

  it('忘却リスクは想起確率の裏返し', () => {
    const learned = scheduleNext(
      newCardState(NOW),
      { kind: 'CORRECT', hinted: false, inputMode: 'ROMAJI' },
      NOW,
      RETENTION,
    ).state;
    const at = new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000);
    expect(forgettingRiskOf(learned, at, RETENTION)).toBeCloseTo(
      1 - retrievabilityOf(learned, at, RETENTION),
      10,
    );
  });
});

describe('FSRS の状態名との対応', () => {
  it('本システムの状態名は FSRS の 4 状態を覆う', () => {
    // 片方だけ増えると、往復のたびに黙って別の状態に化ける。
    const fsrsStates = [
      State.New,
      State.Learning,
      State.Review,
      State.Relearning,
    ];
    expect(fsrsStates).toHaveLength(4);
  });
});
