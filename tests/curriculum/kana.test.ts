import { describe, expect, it } from 'vitest';
import {
  CONFUSABLES,
  HOMOPHONE_PAIRS,
  KANA,
  KANA_BY_ID,
  kanaGlyph,
  kanaKey,
  kanaOfKey,
} from '../../src/curriculum/kana.js';

describe('kana dataset', () => {
  it('has the expected counts per group', () => {
    const count = (g: string): number =>
      KANA.filter((k) => k.group === g).length;
    expect(count('seion')).toBe(46);
    expect(count('dakuon')).toBe(20);
    expect(count('handakuon')).toBe(5);
    expect(count('youon')).toBe(33);
    expect(KANA).toHaveLength(104);
  });

  it('ids are unique — a collision would break mastery aggregation', () => {
    const ids = KANA.map((k) => k.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(KANA_BY_ID.size).toBe(KANA.length);
  });

  it('hiragana and katakana glyphs are each unique', () => {
    const hira = KANA.map((k) => k.hiragana);
    const kata = KANA.map((k) => k.katakana);
    expect(new Set(hira).size).toBe(hira.length);
    expect(new Set(kata).size).toBe(kata.length);
  });

  // じ/ぢ と ず/づ はヘボン式で同表記。ローマ字を鍵にすると衝突するため
  // id を訓令式ベースにしている。その前提が崩れていないことを固定する。
  it('keeps distinct ids for kana that share a hepburn romaji', () => {
    expect(KANA_BY_ID.get('zi')?.romaji).toBe('ji');
    expect(KANA_BY_ID.get('di')?.romaji).toBe('ji');
    expect(KANA_BY_ID.get('zi')?.hiragana).not.toBe(
      KANA_BY_ID.get('di')?.hiragana,
    );
    expect(KANA_BY_ID.get('zu')?.romaji).toBe('zu');
    expect(KANA_BY_ID.get('du')?.romaji).toBe('zu');
  });

  it('uses hepburn for the readings a learner is taught', () => {
    const romajiOf = (id: string): string | undefined =>
      KANA_BY_ID.get(id)?.romaji;
    expect(romajiOf('si')).toBe('shi');
    expect(romajiOf('ti')).toBe('chi');
    expect(romajiOf('tu')).toBe('tsu');
    expect(romajiOf('hu')).toBe('fu');
    expect(romajiOf('sya')).toBe('sha');
    expect(romajiOf('tya')).toBe('cha');
    expect(romajiOf('zya')).toBe('ja');
  });

  it('every youon is a two-character glyph', () => {
    for (const kana of KANA.filter((k) => k.group === 'youon')) {
      expect([...kana.hiragana], kana.id).toHaveLength(2);
      expect([...kana.katakana], kana.id).toHaveLength(2);
    }
  });

  it('teaching order starts with the あ row and ends with youon', () => {
    expect(KANA[0]?.id).toBe('a');
    expect(KANA[0]?.group).toBe('seion');
    expect(KANA[KANA.length - 1]?.group).toBe('youon');
  });

  it('round-trips keys', () => {
    for (const kana of KANA) {
      expect(kanaOfKey(kanaKey(kana.id))?.id).toBe(kana.id);
    }
    expect(kanaOfKey('vocab_inu')).toBeUndefined();
  });

  it('selects the glyph for the requested script', () => {
    const ka = KANA_BY_ID.get('ka');
    expect(ka).toBeDefined();
    if (ka === undefined) return;
    expect(kanaGlyph(ka, 'hiragana')).toBe('か');
    expect(kanaGlyph(ka, 'katakana')).toBe('カ');
  });
});

describe('confusable sets', () => {
  it('reference only ids that exist', () => {
    for (const set of CONFUSABLES) {
      for (const id of set.ids) {
        expect(KANA_BY_ID.has(id), `${set.script}:${id}`).toBe(true);
      }
    }
  });

  it('cover the classic beginner traps', () => {
    const katakanaSets = CONFUSABLES.filter((s) => s.script === 'katakana').map(
      (s) => [...s.ids].sort().join(','),
    );
    expect(katakanaSets).toContain(['si', 'tu'].sort().join(',')); // シ/ツ
    expect(katakanaSets).toContain(['so', 'n'].sort().join(',')); // ソ/ン

    const hiraganaSets = CONFUSABLES.filter((s) => s.script === 'hiragana').map(
      (s) => [...s.ids].sort().join(','),
    );
    expect(hiraganaSets).toContain(['ne', 'wa', 're'].sort().join(',')); // ね/わ/れ
    expect(hiraganaSets).toContain(['ru', 'ro'].sort().join(',')); // る/ろ
  });

  it('each set has at least two members and a note', () => {
    for (const set of CONFUSABLES) {
      expect(set.ids.length).toBeGreaterThanOrEqual(2);
      expect(set.note.length).toBeGreaterThan(0);
    }
  });
});

describe('homophone pairs', () => {
  it('reference existing ids and really share a reading', () => {
    for (const [left, right] of HOMOPHONE_PAIRS) {
      const a = KANA_BY_ID.get(left);
      const b = KANA_BY_ID.get(right);
      expect(a, left).toBeDefined();
      expect(b, right).toBeDefined();
      expect(a?.hiragana).not.toBe(b?.hiragana);
    }
  });
});
