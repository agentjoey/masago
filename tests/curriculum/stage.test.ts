import { describe, expect, it } from 'vitest';
import { KANA } from '../../src/curriculum/kana.js';
import {
  conversationLevel,
  planVocabLesson,
  SEION_COUNT,
  stageOf,
  teachesVocab,
  vocabProgress,
} from '../../src/curriculum/stage.js';
import { VOCAB } from '../../src/curriculum/vocab.js';

const BASE = {
  introducedIds: [] as string[],
  dueIds: [] as string[],
  newPerDay: 5,
  maxReviews: 20,
  backlogThreshold: 20,
};

describe('stageOf', () => {
  it('counts the seion correctly', () => {
    expect(SEION_COUNT).toBe(46);
  });

  // 清音の途中で語彙を混ぜると、読めない字だらけになる。
  it('stays on kana until the seion are done', () => {
    expect(stageOf(0)).toBe('S0_KANA_ONLY');
    expect(stageOf(45)).toBe('S0_KANA_ONLY');
    expect(teachesVocab(stageOf(45))).toBe(false);
  });

  // 濁音・拗音まで待つ必要は無い。Genki も一課から語彙を出す。
  it('starts vocabulary once the seion are done, with kana continuing', () => {
    expect(stageOf(46)).toBe('S1_VOCAB');
    expect(stageOf(103)).toBe('S1_VOCAB');
    expect(teachesVocab(stageOf(46))).toBe(true);
  });

  it('switches to vocabulary alone once every kana is introduced', () => {
    expect(stageOf(KANA.length)).toBe('S1_VOCAB_ONLY');
    expect(teachesVocab(stageOf(KANA.length))).toBe(true);
  });
});

describe('planVocabLesson', () => {
  it('starts at the beginning of the textbook', () => {
    const plan = planVocabLesson(BASE);
    expect(plan.newWords).toHaveLength(5);
    for (const word of plan.newWords) {
      expect(word.genkiLesson).toBe(1);
    }
  });

  it('moves on once the first words are known', () => {
    const known = VOCAB.slice(0, 3).map((entry) => entry.id);
    const plan = planVocabLesson({ ...BASE, introducedIds: known });
    for (const word of plan.newWords) {
      expect(known).not.toContain(word.id);
    }
  });

  // 「～円」という単語がある、と覚えられると後で解くのが面倒。
  it('never introduces an affix as a standalone word', () => {
    const affixIds = VOCAB.filter((entry) => entry.isAffix === true).map(
      (entry) => entry.id,
    );
    // 接辞が先頭に来る位置まで進めてもなお出さない
    const introduced = VOCAB.filter((entry) => entry.isAffix !== true)
      .slice(0, 200)
      .map((entry) => entry.id);
    const plan = planVocabLesson({ ...BASE, introducedIds: introduced });
    for (const word of plan.newWords) {
      expect(affixIds, word.id).not.toContain(word.id);
    }
  });

  it('caps reviews and returns them in the order given', () => {
    const dueIds = VOCAB.slice(0, 30).map((entry) => entry.id);
    const plan = planVocabLesson({ ...BASE, dueIds, maxReviews: 8 });
    expect(plan.reviewWords).toHaveLength(8);
    expect(plan.reviewWords[0]?.id).toBe(dueIds[0]);
  });

  it('ignores due ids that are not vocabulary', () => {
    const plan = planVocabLesson({ ...BASE, dueIds: ['kana_a', 'nope'] });
    expect(plan.reviewWords).toEqual([]);
  });

  // 復習が溜まったまま新語を足すと、雪だるまになって続かなくなる。
  it('holds back new words when the backlog is deep', () => {
    const dueIds = VOCAB.slice(0, 25).map((entry) => entry.id);
    const plan = planVocabLesson({ ...BASE, dueIds, backlogThreshold: 20 });
    expect(plan.newWords).toEqual([]);
    expect(plan.newHeldBackForBacklog).toBe(true);
    expect(plan.reviewWords.length).toBeGreaterThan(0);
  });

  it('measures the backlog before the display cap', () => {
    const dueIds = VOCAB.slice(0, 40).map((entry) => entry.id);
    const plan = planVocabLesson({
      ...BASE,
      dueIds,
      maxReviews: 5,
      backlogThreshold: 20,
    });
    expect(plan.reviewWords).toHaveLength(5);
    expect(plan.newHeldBackForBacklog).toBe(true);
  });

  it('introduces nothing once the whole list is known', () => {
    const all = VOCAB.map((entry) => entry.id);
    expect(planVocabLesson({ ...BASE, introducedIds: all }).newWords).toEqual(
      [],
    );
  });
});

describe('vocabProgress', () => {
  it('counts against the teachable words, not the affixes', () => {
    const progress = vocabProgress([]);
    expect(progress.introduced).toBe(0);
    expect(progress.total).toBeLessThan(VOCAB.length);
    expect(progress.total).toBeGreaterThan(600);
  });

  it('counts what has been introduced', () => {
    const teachable = VOCAB.filter((entry) => entry.isAffix !== true);
    const ids = teachable.slice(0, 7).map((entry) => entry.id);
    expect(vocabProgress(ids).introduced).toBe(7);
  });

  it('does not count an affix even if it somehow got introduced', () => {
    const affix = VOCAB.find((entry) => entry.isAffix === true);
    expect(affix).toBeDefined();
    if (affix === undefined) return;
    expect(vocabProgress([affix.id]).introduced).toBe(0);
  });
});

describe('conversationLevel', () => {
  it('is zero until the seion are readable', () => {
    expect(conversationLevel(0)).toBe('zero');
    expect(conversationLevel(45)).toBe('zero');
  });

  it('becomes beginner once the seion are done', () => {
    expect(conversationLevel(46)).toBe('beginner');
    expect(conversationLevel(104)).toBe('beginner');
  });
});
