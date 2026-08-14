import { describe, expect, it } from 'vitest';
import { VOCAB, VOCAB_BY_ID, type VocabEntry } from '../../src/curriculum/vocab.js';
import {
  buildVocabQuestion,
  isCorrectVocabAnswer,
  isCorrectVocabTyped,
  type VocabQuestionKind,
} from '../../src/curriculum/vocabQuiz.js';

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

function word(id: string): VocabEntry {
  const found = VOCAB_BY_ID.get(id);
  if (found === undefined) throw new Error(`unknown vocab ${id}`);
  return found;
}

const KINDS: VocabQuestionKind[] = ['WORD_TO_MEANING', 'MEANING_TO_WORD'];

describe('buildVocabQuestion', () => {
  it('produces distinct options including the target', () => {
    const target = word('今#いま');
    const q = buildVocabQuestion(target, {
      kind: 'WORD_TO_MEANING',
      optionCount: 4,
      random: seeded(1),
    });
    expect(q.options).toHaveLength(4);
    expect(new Set(q.options.map((o) => o.vocabId)).size).toBe(4);
    expect(q.options.map((o) => o.vocabId)).toContain(target.id);
    expect(q.prompt).toBe('今');
  });

  // 読めない字は覚えようが無い。語を見せるときは必ず読みを添える。
  it('shows the reading when it shows the word', () => {
    const q = buildVocabQuestion(word('今#いま'), {
      kind: 'WORD_TO_MEANING',
      optionCount: 4,
      random: seeded(2),
    });
    expect(q.promptReading).toBe('いま');
  });

  it('does not leak the reading when asking for the word', () => {
    const q = buildVocabQuestion(word('今#いま'), {
      kind: 'MEANING_TO_WORD',
      optionCount: 4,
      random: seeded(2),
    });
    expect(q.promptReading).toBeUndefined();
    expect(q.prompt).toBe('now');
    for (const option of q.options) {
      expect(option.label).toBe(VOCAB_BY_ID.get(option.vocabId)?.expression);
    }
  });

  // 青 と 青い はどちらも "blue"。同じ問題に並べたら答えが二つになる。
  it('never offers two options that mean the same thing', () => {
    for (const kind of KINDS) {
      for (const target of VOCAB.slice(0, 250)) {
        for (let seed = 1; seed <= 2; seed += 1) {
          const q = buildVocabQuestion(target, {
            kind,
            optionCount: 4,
            random: seeded(seed * 17 + target.expression.length),
          });
          expect(
            q.correctIds,
            `${kind}/${target.id}/seed${String(seed)}`,
          ).toHaveLength(1);
          const labels = q.options.map((o) => o.label);
          expect(new Set(labels).size, `${kind}/${target.id}`).toBe(
            labels.length,
          );
        }
      }
    }
  });

  it('keeps same-meaning words out of each other’s options', () => {
    const pairs = [
      ['青#あお', '青い#あおい'],
      ['赤#あか', '赤い#あかい'],
      ['辞書#じしょ', '字引#じびき'],
    ] as const;
    for (const [a, b] of pairs) {
      for (let seed = 1; seed <= 30; seed += 1) {
        for (const kind of KINDS) {
          const q = buildVocabQuestion(word(a), {
            kind,
            optionCount: 5,
            random: seeded(seed),
          });
          expect(q.options.map((o) => o.vocabId), `${kind} ${a}`).not.toContain(
            b,
          );
        }
      }
    }
  });

  // 無関係な語ばかりだと、意味を知らなくても消去法で当たる。
  it('prefers distractors from the same lesson', () => {
    const target = word('今#いま');
    const seen = new Set<number | undefined>();
    for (let seed = 1; seed <= 30; seed += 1) {
      const q = buildVocabQuestion(target, {
        kind: 'WORD_TO_MEANING',
        optionCount: 4,
        random: seeded(seed),
      });
      for (const option of q.options) {
        if (option.vocabId === target.id) continue;
        seen.add(VOCAB_BY_ID.get(option.vocabId)?.genkiLesson);
      }
    }
    expect(seen.has(target.genkiLesson)).toBe(true);
  });

  it('never offers an affix as a distractor', () => {
    const affixIds = new Set(
      VOCAB.filter((entry) => entry.isAffix === true).map((e) => e.id),
    );
    for (let seed = 1; seed <= 40; seed += 1) {
      const q = buildVocabQuestion(word('今#いま'), {
        kind: 'WORD_TO_MEANING',
        optionCount: 5,
        random: seeded(seed),
      });
      for (const option of q.options) {
        expect(affixIds.has(option.vocabId), option.vocabId).toBe(false);
      }
    }
  });

  it('draws only from the taught pool', () => {
    const taught = VOCAB.slice(0, 12);
    for (let seed = 1; seed <= 20; seed += 1) {
      const q = buildVocabQuestion(taught[0] as VocabEntry, {
        kind: 'WORD_TO_MEANING',
        optionCount: 4,
        random: seeded(seed),
        pool: taught,
      });
      for (const option of q.options) {
        expect(taught.map((e) => e.id)).toContain(option.vocabId);
      }
    }
  });

  it('degrades gracefully when the pool is tiny', () => {
    const taught = VOCAB.slice(0, 2);
    const q = buildVocabQuestion(taught[0] as VocabEntry, {
      kind: 'WORD_TO_MEANING',
      optionCount: 4,
      random: seeded(3),
      pool: taught,
    });
    expect(q.options.length).toBeLessThanOrEqual(2);
    expect(q.correctIds).toHaveLength(1);
  });

  it('is deterministic for a given seed', () => {
    const build = (): string[] =>
      buildVocabQuestion(word('今#いま'), {
        kind: 'WORD_TO_MEANING',
        optionCount: 4,
        random: seeded(77),
      }).options.map((o) => o.vocabId);
    expect(build()).toEqual(build());
  });

  it('does not always put the answer in the same slot', () => {
    const positions = new Set<number>();
    for (let seed = 1; seed <= 30; seed += 1) {
      const q = buildVocabQuestion(word('今#いま'), {
        kind: 'WORD_TO_MEANING',
        optionCount: 4,
        random: seeded(seed),
      });
      positions.add(q.options.findIndex((o) => o.vocabId === '今#いま'));
    }
    expect(positions.size).toBeGreaterThan(1);
  });
});

describe('vocab answer checking', () => {
  it('accepts the target and rejects the rest', () => {
    expect(isCorrectVocabAnswer('今#いま', '今#いま')).toBe(true);
    expect(isCorrectVocabAnswer('今#いま', '妹#いもうと')).toBe(false);
  });

  // "blue" と訊かれて 青 でも 青い でも、意味は合っている。
  it('accepts a word that means the same thing', () => {
    expect(isCorrectVocabAnswer('青#あお', '青い#あおい')).toBe(true);
    expect(isCorrectVocabAnswer('辞書#じしょ', '字引#じびき')).toBe(true);
  });

  it('rejects an unknown id', () => {
    expect(isCorrectVocabAnswer('nope', '今#いま')).toBe(false);
  });

  it('accepts either the written form or the reading when typed', () => {
    expect(isCorrectVocabTyped('今#いま', '今')).toBe(true);
    expect(isCorrectVocabTyped('今#いま', 'いま')).toBe(true);
    expect(isCorrectVocabTyped('今#いま', ' いま ')).toBe(true);
    expect(isCorrectVocabTyped('今#いま', 'いもうと')).toBe(false);
    expect(isCorrectVocabTyped('今#いま', '')).toBe(false);
  });
});
