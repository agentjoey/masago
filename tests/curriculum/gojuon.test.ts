import { describe, expect, it } from 'vitest';
import { KANA } from '../../src/curriculum/kana.js';
import { gojuonGrid, vowelOf } from '../../src/curriculum/gojuon.js';

const grid = gojuonGrid();
const section = (group: string) => {
  const found = grid.find((s) => s.group === group);
  if (found === undefined) throw new Error(`no section ${group}`);
  return found;
};

describe('vowelOf', () => {
  // ヘボン式で判定すると shi/chi/tsu/fu が例外になり列がずれる。
  it('uses the kunrei id, not the hepburn reading', () => {
    expect(vowelOf(KANA.find((k) => k.id === 'si') as never)).toBe('i');
    expect(vowelOf(KANA.find((k) => k.id === 'tu') as never)).toBe('u');
    expect(vowelOf(KANA.find((k) => k.id === 'hu') as never)).toBe('u');
  });

  it('has no vowel for ん', () => {
    expect(vowelOf(KANA.find((k) => k.id === 'n') as never)).toBeUndefined();
  });
});

describe('gojuon grid', () => {
  it('lays out the four groups', () => {
    expect(grid.map((s) => s.group)).toEqual([
      'seion',
      'dakuon',
      'handakuon',
      'youon',
    ]);
  });

  it('gives every row the same number of columns', () => {
    for (const s of grid) {
      for (const row of s.rows) {
        expect(row.cells.length, `${s.group}/${row.row}`).toBe(s.columns.length);
      }
    }
  });

  // 表の位置で覚えるので、ずれた表はそれ自体が誤りになる。
  it('aligns や row under あ / う / お, leaving い and え empty', () => {
    const ya = section('seion').rows.find((r) => r.row === 'や');
    expect(ya).toBeDefined();
    expect(ya?.cells[0]?.id).toBe('ya');
    expect(ya?.cells[1]).toBeUndefined(); // い列は空
    expect(ya?.cells[2]?.id).toBe('yu');
    expect(ya?.cells[3]).toBeUndefined(); // え列は空
    expect(ya?.cells[4]?.id).toBe('yo');
  });

  it('puts を in the お column of the わ row', () => {
    const wa = section('seion').rows.find((r) => r.row === 'わ');
    expect(wa?.cells[0]?.id).toBe('wa');
    expect(wa?.cells[4]?.id).toBe('wo');
    expect(wa?.cells[1]).toBeUndefined();
  });

  it('keeps あ row fully populated', () => {
    const a = section('seion').rows.find((r) => r.row === 'あ');
    expect(a?.cells.map((c) => c?.id)).toEqual(['a', 'i', 'u', 'e', 'o']);
  });

  it('gives youon three columns', () => {
    const youon = section('youon');
    expect(youon.columns).toEqual(['a', 'u', 'o']);
    const kya = youon.rows.find((r) => r.row === 'き');
    expect(kya?.cells.map((c) => c?.id)).toEqual(['kya', 'kyu', 'kyo']);
  });

  // 一つでも落ちると学習者の表から字が消える。
  it('contains every kana exactly once', () => {
    const seen: string[] = [];
    for (const s of grid) {
      for (const row of s.rows) {
        for (const cell of row.cells) {
          if (cell !== undefined) seen.push(cell.id);
        }
      }
    }
    expect(seen).toHaveLength(KANA.length);
    expect(new Set(seen).size).toBe(KANA.length);
  });

  it('places ん somewhere', () => {
    const n = section('seion').rows.find((r) => r.row === 'ん');
    expect(n?.cells.some((c) => c?.id === 'n')).toBe(true);
  });
});
