import { describe, expect, it } from 'vitest';
import {
  VOCAB_N5,
  VOCAB_N5_BY_ID,
  vocabKey,
  vocabOfKey,
} from '../../src/curriculum/vocabN5.js';

const KANA_ONLY = /^[ぁ-ゟ゠-ヿー]+$/;

describe('N5 vocabulary dataset', () => {
  it('has a usable amount of N5 vocabulary', () => {
    expect(VOCAB_N5.length).toBeGreaterThan(700);
    expect(VOCAB_N5_BY_ID.size).toBe(VOCAB_N5.length);
  });

  // 鍵が衝突すると、片方の学習履歴がもう片方を上書きする。
  it('ids are unique', () => {
    const ids = VOCAB_N5.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // 同表記異読は別の語。一つにまとめると読みを取り違える。
  it('keeps homographs apart', () => {
    const oneDay = VOCAB_N5.filter((entry) => entry.expression === '一日');
    expect(oneDay.length).toBe(2);
    expect(new Set(oneDay.map((entry) => entry.reading))).toEqual(
      new Set(['いちにち', 'ついたち']),
    );

    const nine = VOCAB_N5.filter((entry) => entry.expression === '九');
    expect(new Set(nine.map((entry) => entry.reading))).toEqual(
      new Set(['きゅう', 'く']),
    );
  });

  // 読みは振り仮名にも音声合成にも使う。記号が混ざると両方壊れる。
  it('every reading is kana only', () => {
    for (const entry of VOCAB_N5) {
      expect(KANA_ONLY.test(entry.reading), `${entry.id}: ${entry.reading}`).toBe(
        true,
      );
    }
  });

  it('nothing is missing an expression or a meaning', () => {
    for (const entry of VOCAB_N5) {
      expect(entry.expression.length, entry.id).toBeGreaterThan(0);
      expect(entry.meaning.length, entry.id).toBeGreaterThan(0);
    }
  });

  // 出典の記法（～、"いく; ゆく"）は表示用に残し、読みからは落としてある。
  it('keeps the source spelling when it differs from the normalised reading', () => {
    const iku = VOCAB_N5_BY_ID.get('行く#いく');
    expect(iku).toBeDefined();
    expect(iku?.reading).toBe('いく');
    expect(iku?.displayReading).toBe('いく; ゆく');
  });

  it('flags affixes so they are not taught as standalone words', () => {
    const affixes = VOCAB_N5.filter((entry) => entry.isAffix === true);
    expect(affixes.length).toBeGreaterThan(20);
    for (const entry of affixes) {
      // 印が付いているものは、表記か出典の読みに ～ を含む
      const raw = `${entry.expression}${entry.displayReading ?? ''}`;
      expect(/[～〜~]/.test(raw), entry.id).toBe(true);
    }
    // 逆に、印の無い語に ～ が残っていない
    for (const entry of VOCAB_N5.filter((e) => e.isAffix !== true)) {
      expect(/[～〜~]/.test(entry.expression), entry.id).toBe(false);
    }
  });
});

describe('teaching order', () => {
  // 教科書の課順で進む。頻度順を自作するより確かで、五十音の直後から
  // そのまま繋がる。
  it('starts with Genki lesson 1', () => {
    expect(VOCAB_N5[0]?.genkiLesson).toBe(1);
  });

  it('never goes back to an earlier lesson', () => {
    let previous = 0;
    for (const entry of VOCAB_N5) {
      if (entry.genkiLesson === undefined) break;
      expect(entry.genkiLesson, entry.id).toBeGreaterThanOrEqual(previous);
      previous = entry.genkiLesson;
    }
  });

  it('puts every lesson-tagged word before the untagged remainder', () => {
    const firstUntagged = VOCAB_N5.findIndex(
      (entry) => entry.genkiLesson === undefined,
    );
    expect(firstUntagged).toBeGreaterThan(0);
    for (const entry of VOCAB_N5.slice(firstUntagged)) {
      expect(entry.genkiLesson, entry.id).toBeUndefined();
    }
  });

  it('covers the whole textbook', () => {
    const lessons = new Set(
      VOCAB_N5.map((entry) => entry.genkiLesson).filter(
        (lesson): lesson is number => lesson !== undefined,
      ),
    );
    expect(Math.min(...lessons)).toBe(1);
    expect(lessons.size).toBeGreaterThanOrEqual(20);
  });
});

describe('knowledge keys', () => {
  it('round-trips', () => {
    for (const entry of VOCAB_N5.slice(0, 50)) {
      expect(vocabOfKey(vocabKey(entry.id))?.id).toBe(entry.id);
    }
  });

  it('does not collide with kana keys', () => {
    expect(vocabOfKey('kana_a')).toBeUndefined();
    expect(vocabKey('今#いま').startsWith('vocab_')).toBe(true);
  });

  it('returns nothing for an unknown key', () => {
    expect(vocabOfKey('vocab_nope#nope')).toBeUndefined();
  });
});
