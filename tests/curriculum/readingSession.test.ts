import { describe, expect, it } from 'vitest';
import {
  buildReadingQuestion,
  decodeReadingAnswer,
  encodeReadingAnswer,
  gradeReading,
  readingKindFor,
} from '../../src/learning/readingSession.js';
import { TRANSLATED } from '../../src/curriculum/sentences.js';

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

const NOTHING_KNOWN = new Set<string>();

describe('nextReadingQuestion の出題', () => {
  it('builds a four-option question from real sentences', () => {
    const next = buildReadingQuestion(NOTHING_KNOWN, {
      optionCount: 4,
      random: seeded(6),
    });
    expect(next).toBeDefined();
    expect(next?.question.options).toHaveLength(4);
    expect(next?.sentence.zh).toBeDefined();
  });

  /**
   * 既習の語だけで読める文を優先する。読めない文ばかり出しても
   * 「知っている字があるほう」を選ぶだけで、読んだことにならない。
   */
  it('prefers sentences the learner can actually read', () => {
    // プールの上位の文からよく出る語を集めて既習とみなす
    const known = new Set<string>();
    for (const sentence of TRANSLATED.slice(0, 40)) {
      for (const token of sentence.tokens) known.add(token.s);
    }

    let readable = 0;
    const FUNCTION_POS = new Set(['助詞', '助動詞', '記号', 'フィラー', '感動詞']);
    for (let seed = 1; seed <= 40; seed += 1) {
      const next = buildReadingQuestion(known, {
        optionCount: 4,
        random: seeded(seed),
      });
      if (next === undefined) continue;
      const unknown = next.sentence.tokens.filter(
        (t) => !FUNCTION_POS.has(t.p) && !known.has(t.s),
      ).length;
      if (unknown <= 1) readable += 1;
    }
    expect(readable).toBeGreaterThan(30);
  });

  it('alternates the direction so the learner both reads and produces', () => {
    const kinds = [0, 1, 2, 3, 4, 5].map(readingKindFor);
    expect(kinds).toContain('JA_TO_ZH');
    expect(kinds).toContain('ZH_TO_JA');
  });
});

describe('採点', () => {
  it('round-trips the callback payload inside the 64-byte limit', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const next = buildReadingQuestion(NOTHING_KNOWN, {
        optionCount: 4,
        random: seeded(seed),
      });
      if (next === undefined) continue;
      for (const option of next.question.options) {
        const data = encodeReadingAnswer(
          next.question.targetId,
          option.sentenceId,
        );
        expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
        expect(decodeReadingAnswer(data)).toEqual({
          targetId: next.question.targetId,
          chosenId: option.sentenceId,
        });
      }
    }
  });

  it('rejects a payload that does not name real sentences', () => {
    expect(decodeReadingAnswer('rq:nope:nope')).toBeUndefined();
    expect(decodeReadingAnswer('vq:1:2')).toBeUndefined();
    expect(decodeReadingAnswer('rq:1')).toBeUndefined();
  });

  it('marks the target correct and a different meaning wrong', () => {
    const next = buildReadingQuestion(NOTHING_KNOWN, {
      optionCount: 4,
      random: seeded(6),
    });
    if (next === undefined) throw new Error('no question');
    const targetId = next.question.targetId;

    const right = gradeReading({ targetId, chosenId: targetId });
    expect(right?.correct).toBe(true);

    const other = next.question.options.find(
      (option) => !next.question.correctIds.includes(option.sentenceId),
    );
    if (other === undefined) throw new Error('no wrong option');
    const wrong = gradeReading({ targetId, chosenId: other.sentenceId });
    expect(wrong?.correct).toBe(false);
    expect(wrong?.chosen?.id).toBe(other.sentenceId);
  });

  /**
   * 「目が痛いです。」と「目が痛い。」はどちらも「我的眼睛疼」。
   * 取り違えたのは、読めていないこととは違う。
   */
  it('accepts a different sentence that means the same thing', () => {
    const byMeaning = new Map<string, string[]>();
    for (const sentence of TRANSLATED) {
      const key = (sentence.zh ?? '').replace(/[\s。，、．,.！!？?；;：:]/gu, '');
      const list = byMeaning.get(key) ?? [];
      list.push(sentence.id);
      byMeaning.set(key, list);
    }
    const pair = [...byMeaning.values()].find((list) => list.length > 1);
    expect(pair, 'pool has no two sentences sharing a meaning').toBeDefined();
    if (pair === undefined) return;
    const [first, second] = pair;
    if (first === undefined || second === undefined) return;

    const graded = gradeReading({ targetId: first, chosenId: second });
    expect(graded?.correct).toBe(true);
  });
});
