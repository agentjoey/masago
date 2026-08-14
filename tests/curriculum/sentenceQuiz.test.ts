import { describe, expect, it } from 'vitest';
import {
  buildSentenceQuestion,
  isCorrectSentenceAnswer,
} from '../../src/curriculum/sentenceQuiz.js';
import { TRANSLATED, type Sentence } from '../../src/curriculum/sentences.js';

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

function normalize(text: string): string {
  return text.replace(/[\s。，、．,.！!？?；;：:]/gu, '');
}

/** 試験側も id 引きを O(1) にする。O(n) の find を回すと本体の遅さが霞む。 */
const BY_ID = new Map(TRANSLATED.map((sentence) => [sentence.id, sentence]));

describe('buildSentenceQuestion', () => {
  it('builds a question from a real sentence and its human translation', () => {
    const target = TRANSLATED[0];
    if (target === undefined) throw new Error('no translated sentences');
    const question = buildSentenceQuestion(target, {
      kind: 'ZH_TO_JA',
      optionCount: 4,
      random: seeded(3),
    });
    expect(question).toBeDefined();
    expect(question?.prompt).toBe(target.zh);
    expect(question?.options).toHaveLength(4);
    expect(question?.options.map((o) => o.sentenceId)).toContain(target.id);
    expect(question?.correctIds).toContain(target.id);
  });

  it('shows Japanese and asks for the meaning in the other direction', () => {
    const target = TRANSLATED[5];
    if (target === undefined) throw new Error('no sentence');
    const question = buildSentenceQuestion(target, {
      kind: 'JA_TO_ZH',
      optionCount: 4,
      random: seeded(8),
    });
    expect(question?.prompt).toBe(target.text);
    expect(question?.options.map((o) => o.label)).toContain(target.zh);
  });

  /**
   * 「目が痛いです。」と「目が痛い。」はどちらも「我的眼睛疼」。
   * 同じ意味の文を誤答に混ぜると、正しく読めた学習者に ❌ が出る。
   */
  it('never puts two sentences with the same meaning in one question', () => {
    for (const [index, target] of TRANSLATED.slice(0, 400).entries()) {
      const question = buildSentenceQuestion(target, {
        kind: 'ZH_TO_JA',
        optionCount: 4,
        random: seeded(index + 1),
      });
      if (question === undefined) continue;
      const meanings = question.options.map((option) =>
        normalize(BY_ID.get(option.sentenceId)?.zh ?? ''),
      );
      expect(new Set(meanings).size, question.prompt).toBe(meanings.length);
    }
  });

  it('never repeats the same option label', () => {
    for (const kind of ['ZH_TO_JA', 'JA_TO_ZH'] as const) {
      for (const [index, target] of TRANSLATED.slice(0, 300).entries()) {
        const question = buildSentenceQuestion(target, {
          kind,
          optionCount: 4,
          random: seeded(index * 3 + 2),
        });
        if (question === undefined) continue;
        const labels = question.options.map((option) => option.label);
        expect(new Set(labels).size, labels.join(' | ')).toBe(labels.length);
      }
    }
  });

  it('grades only the options that really mean the same thing', () => {
    const target = TRANSLATED[12];
    if (target === undefined) throw new Error('no sentence');
    const question = buildSentenceQuestion(target, {
      kind: 'ZH_TO_JA',
      optionCount: 4,
      random: seeded(21),
    });
    if (question === undefined) throw new Error('no question');
    expect(isCorrectSentenceAnswer(question, target.id)).toBe(true);
    for (const option of question.options) {
      if (question.correctIds.includes(option.sentenceId)) continue;
      expect(isCorrectSentenceAnswer(question, option.sentenceId)).toBe(false);
    }
  });

  /**
   * 全く無関係な文を並べると、知っている単語が一つあるだけで当たる。
   * 内容語が重なる文を優先しているかを、無作為な選び方と比べて確かめる。
   */
  it('prefers distractors that share words with the target', () => {
    const CONTENT = new Set(['名詞', '動詞', '形容詞', '副詞', '連体詞']);
    const words = (sentence: Sentence): Set<string> =>
      new Set(
        sentence.tokens.filter((t) => CONTENT.has(t.p)).map((t) => t.s),
      );

    let overlapping = 0;
    let considered = 0;
    for (const [index, target] of TRANSLATED.slice(0, 200).entries()) {
      const question = buildSentenceQuestion(target, {
        kind: 'ZH_TO_JA',
        optionCount: 4,
        random: seeded(index + 100),
      });
      if (question === undefined) continue;
      considered += 1;
      const targetWords = words(target);
      const shares = question.options.some((option) => {
        if (option.sentenceId === target.id) return false;
        const other = BY_ID.get(option.sentenceId);
        if (other === undefined) return false;
        return [...words(other)].some((word) => targetWords.has(word));
      });
      if (shares) overlapping += 1;
    }
    expect(considered).toBeGreaterThan(100);
    // 無作為に選べばほぼ 0 になる。半分以上で重なっていれば効いている。
    expect(overlapping / considered).toBeGreaterThan(0.5);
  });

  it('refuses to build a question without a translation', () => {
    const untranslated: Sentence = {
      id: 'x',
      level: 'N5',
      text: 'テスト。',
      tokens: [],
    };
    expect(
      buildSentenceQuestion(untranslated, {
        kind: 'ZH_TO_JA',
        optionCount: 4,
        random: seeded(1),
      }),
    ).toBeUndefined();
  });

  it('refuses rather than building a question with too few options', () => {
    const target = TRANSLATED[0];
    if (target === undefined) throw new Error('no sentence');
    const question = buildSentenceQuestion(target, {
      kind: 'ZH_TO_JA',
      optionCount: 4,
      random: seeded(1),
      pool: [target],
    });
    expect(question).toBeUndefined();
  });
});
