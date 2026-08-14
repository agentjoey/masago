import { describe, expect, it } from 'vitest';
import { judgeReading, readingSegments } from '../../src/miniapp/reading.js';
import { renderRubyHtml } from '../../src/curriculum/furigana.js';
import { TRANSLATED, type Sentence } from '../../src/curriculum/sentences.js';

const NOTHING_KNOWN = new Set<string>();

function withKanji(): Sentence {
  const found = TRANSLATED.find((sentence) =>
    sentence.tokens.some(
      (token) => /[一-鿿]/u.test(token.s) && token.r !== undefined,
    ),
  );
  if (found === undefined) throw new Error('no sentence with kanji');
  return found;
}

describe('ruby の段', () => {
  it('puts a reading over every kanji at the first tier', () => {
    const sentence = withKanji();
    const segments = readingSegments(sentence, 'ALL', NOTHING_KNOWN);
    expect(segments.some((segment) => segment.ruby !== null)).toBe(true);
    // 本文が欠けないこと。ruby を付けるついでに字を落とすと読めなくなる。
    expect(segments.map((segment) => segment.text).join('')).toBe(sentence.text);
  });

  it('drops the reading for words the learner already knows', () => {
    const sentence = withKanji();
    const known = new Set(sentence.tokens.map((token) => token.s));
    const segments = readingSegments(sentence, 'UNKNOWN', known);
    expect(segments.every((segment) => segment.ruby === null)).toBe(true);
    expect(segments.map((segment) => segment.text).join('')).toBe(sentence.text);
  });

  it('shows the plain sentence at the last tier', () => {
    const sentence = withKanji();
    const segments = readingSegments(sentence, 'NONE', NOTHING_KNOWN);
    expect(segments).toEqual([{ text: sentence.text, ruby: null }]);
  });

  it('never loses text at any tier, across many sentences', () => {
    for (const level of ['ALL', 'UNKNOWN', 'NONE'] as const) {
      for (const sentence of TRANSLATED.slice(0, 300)) {
        const joined = readingSegments(sentence, level, NOTHING_KNOWN)
          .map((segment) => segment.text)
          .join('');
        expect(joined, `${level} ${sentence.text}`).toBe(sentence.text);
      }
    }
  });

  /**
   * 送り仮名まで読みが被らないこと。「食べる」は 食(た)べる であって
   * 食べる(たべる) ではない。
   */
  it('puts the reading only over the kanji part', () => {
    const sentence = TRANSLATED.find((s) =>
      s.tokens.some((t) => t.s.length > 1 && /[一-鿿][ぁ-ん]/u.test(t.s)),
    );
    if (sentence === undefined) return;
    for (const segment of readingSegments(sentence, 'ALL', NOTHING_KNOWN)) {
      if (segment.ruby === null) continue;
      // 読みが乗る区間に平仮名の送りが混ざっていないこと
      expect(segment.text, sentence.text).not.toMatch(/[一-鿿][ぁ-ん]+$/u);
    }
  });

  it('escapes the html it produces', () => {
    const html = renderRubyHtml(
      readingSegments(withKanji(), 'ALL', NOTHING_KNOWN).map((segment) => ({
        text: segment.text,
        ruby: segment.ruby ?? undefined,
      })),
    );
    expect(html).not.toMatch(/<script/i);
    expect(html).toMatch(/<ruby>/);
  });
});

describe('judgeReading', () => {
  it('grades on the server so the answer never reaches the page', () => {
    const target = TRANSLATED[3];
    const other = TRANSLATED[40];
    if (target === undefined || other === undefined) throw new Error('no data');
    expect(judgeReading(target.id, target.id)?.correct).toBe(true);
    const wrong = judgeReading(target.id, other.id);
    expect(wrong?.correct).toBe(false);
    expect(wrong?.answer).toBe(target.zh);
  });

  it('returns null for a sentence it does not know', () => {
    expect(judgeReading('nope', 'nope')).toBeNull();
  });
});
