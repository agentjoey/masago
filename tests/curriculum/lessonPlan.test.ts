import { describe, expect, it } from 'vitest';
import { KANA } from '../../src/curriculum/kana.js';
import {
  kanaProgress,
  planLesson,
  taughtPool,
} from '../../src/curriculum/lessonPlan.js';

const BASE = {
  introducedIds: [] as string[],
  dueIds: [] as string[],
  newPerDay: 5,
  maxReviews: 20,
  backlogThreshold: 20,
};

describe('planLesson — new kana', () => {
  it('starts a beginner at the あ row', () => {
    const plan = planLesson(BASE);
    expect(plan.newKana.map((k) => k.id)).toEqual(['a', 'i', 'u', 'e', 'o']);
  });

  it('moves to the next row once one is done', () => {
    const plan = planLesson({
      ...BASE,
      introducedIds: ['a', 'i', 'u', 'e', 'o'],
    });
    expect(plan.newKana.map((k) => k.id)).toEqual([
      'ka',
      'ki',
      'ku',
      'ke',
      'ko',
    ]);
  });

  // あいうえお は一組。機械的に 5 個ずつ切ると翌日「えお＋かき」になる。
  it('does not span two rows in one day', () => {
    const plan = planLesson({
      ...BASE,
      introducedIds: ['a', 'i', 'u'],
    });
    expect(plan.newKana.map((k) => k.id)).toEqual(['e', 'o']);
  });

  it('splits a row only when it exceeds the daily limit', () => {
    const plan = planLesson({ ...BASE, newPerDay: 3 });
    expect(plan.newKana.map((k) => k.id)).toEqual(['a', 'i', 'u']);
  });

  it('introduces nothing once every kana is known', () => {
    const plan = planLesson({
      ...BASE,
      introducedIds: KANA.map((k) => k.id),
    });
    expect(plan.newKana).toEqual([]);
    expect(plan.newHeldBackForBacklog).toBe(false);
  });

  it('honours a zero daily limit', () => {
    expect(planLesson({ ...BASE, newPerDay: 0 }).newKana).toEqual([]);
  });

  it('reaches dakuon and youon after the seion rows', () => {
    const seion = KANA.filter((k) => k.group === 'seion').map((k) => k.id);
    const afterSeion = planLesson({ ...BASE, introducedIds: seion });
    expect(afterSeion.newKana[0]?.group).toBe('dakuon');

    const throughHandakuon = KANA.filter(
      (k) => k.group !== 'youon',
    ).map((k) => k.id);
    const atYouon = planLesson({ ...BASE, introducedIds: throughHandakuon });
    expect(atYouon.newKana[0]?.group).toBe('youon');
  });
});

describe('planLesson — reviews and backlog', () => {
  it('returns due kana in the order given', () => {
    const plan = planLesson({ ...BASE, dueIds: ['ki', 'a', 'so'] });
    expect(plan.reviewKana.map((k) => k.id)).toEqual(['ki', 'a', 'so']);
  });

  it('caps the review list', () => {
    const plan = planLesson({
      ...BASE,
      dueIds: KANA.slice(0, 30).map((k) => k.id),
      maxReviews: 8,
    });
    expect(plan.reviewKana).toHaveLength(8);
  });

  it('ignores due ids that are not kana', () => {
    const plan = planLesson({ ...BASE, dueIds: ['a', 'particle_wa_ga', 'ki'] });
    expect(plan.reviewKana.map((k) => k.id)).toEqual(['a', 'ki']);
  });

  // 溜まった復習を放って新出を足し続けると雪だるまになり、必ず続かなくなる。
  it('holds back new kana when the backlog is too deep', () => {
    const plan = planLesson({
      ...BASE,
      dueIds: KANA.slice(0, 25).map((k) => k.id),
      backlogThreshold: 20,
    });
    expect(plan.newKana).toEqual([]);
    expect(plan.newHeldBackForBacklog).toBe(true);
    // 復習そのものは出す。止めるのは新出だけ。
    expect(plan.reviewKana.length).toBeGreaterThan(0);
  });

  it('still introduces when the backlog is at the threshold', () => {
    const plan = planLesson({
      ...BASE,
      dueIds: KANA.slice(0, 20).map((k) => k.id),
      backlogThreshold: 20,
    });
    expect(plan.newKana.length).toBeGreaterThan(0);
    expect(plan.newHeldBackForBacklog).toBe(false);
  });

  // 表示上限で切った後の数で判定すると、何件溜まっても閾値に届かない。
  it('measures the backlog before the display cap, not after', () => {
    const plan = planLesson({
      ...BASE,
      dueIds: KANA.slice(0, 40).map((k) => k.id),
      maxReviews: 5,
      backlogThreshold: 20,
    });
    expect(plan.reviewKana).toHaveLength(5);
    expect(plan.newHeldBackForBacklog).toBe(true);
    expect(plan.newKana).toEqual([]);
  });
});

describe('taughtPool', () => {
  it('keeps only introduced kana, in teaching order', () => {
    const pool = taughtPool(['ki', 'a', 'ka']);
    expect(pool.map((k) => k.id)).toEqual(['a', 'ka', 'ki']);
  });

  it('is empty for a fresh learner', () => {
    expect(taughtPool([])).toEqual([]);
  });

  it('ignores unknown ids', () => {
    expect(taughtPool(['a', 'nope']).map((k) => k.id)).toEqual(['a']);
  });
});

describe('kanaProgress', () => {
  it('counts against the full syllabary', () => {
    expect(kanaProgress([])).toEqual({ introduced: 0, total: KANA.length });
    expect(kanaProgress(['a', 'i'])).toEqual({
      introduced: 2,
      total: KANA.length,
    });
  });

  it('does not count ids that are not kana', () => {
    expect(kanaProgress(['a', 'vocab_inu']).introduced).toBe(1);
  });
});
