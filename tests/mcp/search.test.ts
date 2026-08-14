import { describe, expect, it } from 'vitest';
import {
  describeResource,
  knowledgeKeyOf,
  parseResourceId,
  searchCurriculum,
} from '../../src/mcp/search.js';
import { VOCAB } from '../../src/curriculum/vocab.js';

const BASE = 'https://example.test/app';

describe('parseResourceId', () => {
  it('splits on the first colon only', () => {
    // 語彙 id は `医者#いしゃ`。`:` を含まないが、割り方を間違えると
    // 別の種別で同じ問題が起きる。
    expect(parseResourceId('vocab:医者#いしゃ')).toEqual({
      kind: 'vocab',
      key: '医者#いしゃ',
    });
    expect(parseResourceId('sentence:48302')).toEqual({
      kind: 'sentence',
      key: '48302',
    });
  });

  it('refuses anything it does not recognise', () => {
    expect(parseResourceId('nope:x')).toBeUndefined();
    expect(parseResourceId('kana')).toBeUndefined();
    expect(parseResourceId(':a')).toBeUndefined();
    expect(parseResourceId('kana:')).toBeUndefined();
    expect(parseResourceId('')).toBeUndefined();
  });
});

describe('searchCurriculum', () => {
  it('finds a kana by its glyph and by romaji', () => {
    for (const query of ['あ', 'a', 'ア']) {
      const hits = searchCurriculum(query, { baseUrl: BASE });
      expect(hits.some((hit) => hit.id === 'kana:a'), query).toBe(true);
    }
  });

  it('finds a word by expression, reading and meaning', () => {
    for (const query of ['医者', 'いしゃ', 'doctor']) {
      const hits = searchCurriculum(query, { baseUrl: BASE });
      expect(
        hits.some((hit) => hit.id === 'vocab:医者#いしゃ'),
        query,
      ).toBe(true);
    }
  });

  it('finds a particle', () => {
    const hits = searchCurriculum('を', { baseUrl: BASE });
    expect(hits.some((hit) => hit.id === 'particle:wo')).toBe(true);
  });

  /**
   * 例文は 3,500 件ある。混ぜて並べると知識項が埋もれる——「本」を
   * 引いたら、まず単語の「本」が出てほしい。
   */
  it('puts knowledge items above sentences', () => {
    const hits = searchCurriculum('本', { baseUrl: BASE, limit: 10 });
    const firstSentence = hits.findIndex((hit) => hit.kind === 'sentence');
    const lastItem = hits.reduce(
      (last, hit, index) => (hit.kind === 'sentence' ? last : index),
      -1,
    );
    if (firstSentence >= 0 && lastItem >= 0) {
      expect(lastItem).toBeLessThan(firstSentence);
    }
    expect(hits.some((hit) => hit.kind === 'vocab')).toBe(true);
  });

  it('still finds sentences when nothing else matches', () => {
    const hits = searchCurriculum('どこに住んでいますか', { baseUrl: BASE });
    expect(hits.some((hit) => hit.kind === 'sentence')).toBe(true);
  });

  it('ranks an exact match above a partial one', () => {
    const hits = searchCurriculum('本', { baseUrl: BASE, limit: 20 });
    const exact = hits.findIndex((hit) => hit.title.startsWith('本（'));
    if (exact < 0) return;
    expect(exact).toBeLessThan(5);
  });

  it('returns nothing for an empty query instead of everything', () => {
    expect(searchCurriculum('', { baseUrl: BASE })).toEqual([]);
    expect(searchCurriculum('   ', { baseUrl: BASE })).toEqual([]);
  });

  it('honours the limit', () => {
    const hits = searchCurriculum('い', { baseUrl: BASE, limit: 5 });
    expect(hits.length).toBeLessThanOrEqual(5);
  });

  it('builds a url that points into the mini app', () => {
    const hits = searchCurriculum('あ', { baseUrl: BASE });
    const kana = hits.find((hit) => hit.id === 'kana:a');
    expect(kana?.url).toBe(`${BASE}#kana/a`);
  });

  it('escapes an id that would otherwise break the url', () => {
    const hits = searchCurriculum('医者', { baseUrl: BASE });
    const word = hits.find((hit) => hit.id === 'vocab:医者#いしゃ');
    // `#` を生で入れるとフラグメントが二つになる
    expect(word?.url).not.toContain('医者#いしゃ');
    expect(word?.url).toContain('%23');
  });
});

describe('describeResource', () => {
  it('describes a kana with both scripts', () => {
    const detail = describeResource('kana:a', { baseUrl: BASE });
    expect(detail?.text).toContain('あ');
    expect(detail?.text).toContain('ア');
    expect(detail?.text).toContain('a');
  });

  it('describes a word with its source meaning, not an invented one', () => {
    const entry = VOCAB.find((item) => item.id === '医者#いしゃ');
    const detail = describeResource('vocab:医者#いしゃ', { baseUrl: BASE });
    expect(detail?.text).toContain(entry?.meaning ?? 'never');
  });

  it('warns about a particle that is not read as written', () => {
    const detail = describeResource('particle:wa', { baseUrl: BASE });
    expect(detail?.text).toContain('wa');
    expect(detail?.text).toContain('不按字面读');
  });

  /** Tatoeba は CC BY 2.0 FR。署名が要る。 */
  it('attributes every sentence it hands out', () => {
    const detail = describeResource('sentence:48302', { baseUrl: BASE });
    expect(detail?.text).toContain('Tatoeba');
    expect(detail?.text).toContain('CC BY 2.0 FR');
    expect(detail?.metadata['license']).toBe('CC BY 2.0 FR');
  });

  it('returns nothing for an id it does not know', () => {
    expect(describeResource('kana:zzz')).toBeUndefined();
    expect(describeResource('vocab:nope')).toBeUndefined();
    expect(describeResource('sentence:0')).toBeUndefined();
    expect(describeResource('garbage')).toBeUndefined();
  });

  it('leaves issues to the caller, which has the database', () => {
    expect(describeResource('issue:abc')).toBeUndefined();
  });
});

describe('knowledgeKeyOf', () => {
  it('maps ids onto the keys used in knowledge_items', () => {
    expect(knowledgeKeyOf('kana:a')).toBe('kana_a');
    expect(knowledgeKeyOf('vocab:医者#いしゃ')).toBe('vocab_医者#いしゃ');
    expect(knowledgeKeyOf('particle:wo')).toBe('particle_wo');
  });

  it('has no key for things that are not knowledge items', () => {
    expect(knowledgeKeyOf('sentence:48302')).toBeUndefined();
    expect(knowledgeKeyOf('issue:abc')).toBeUndefined();
  });
});
