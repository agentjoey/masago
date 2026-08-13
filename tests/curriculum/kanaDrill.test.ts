import { describe, expect, it } from 'vitest';
import {
  decodeAnswer,
  encodeAnswer,
  questionKindFor,
} from '../../src/learning/kanaDrill.js';
import { isCorrectAnswer } from '../../src/curriculum/quiz.js';
import {
  renderProgress,
  renderQuestion,
  renderToday,
  renderWrong,
} from '../../src/curriculum/render.js';
import { KANA_BY_ID, type Kana } from '../../src/curriculum/kana.js';

function kana(id: string): Kana {
  const found = KANA_BY_ID.get(id);
  if (found === undefined) throw new Error(`unknown kana ${id}`);
  return found;
}

describe('questionKindFor', () => {
  // 字を知らないうちに「a はどれ？」は総当たりにしかならない。
  it('shows the glyph first, asks for it later', () => {
    expect(questionKindFor(0)).toBe('GLYPH_TO_ROMAJI');
    expect(questionKindFor(1)).toBe('GLYPH_TO_ROMAJI');
    expect(questionKindFor(2)).toBe('ROMAJI_TO_GLYPH');
    expect(questionKindFor(20)).toBe('ROMAJI_TO_GLYPH');
  });
});

describe('callback encoding', () => {
  it('round-trips', () => {
    for (const kind of [
      'GLYPH_TO_ROMAJI',
      'ROMAJI_TO_GLYPH',
      'AUDIO_TO_GLYPH',
    ] as const) {
      const encoded = encodeAnswer('si', 'tu', kind);
      expect(decodeAnswer(encoded)).toEqual({
        targetId: 'si',
        chosenId: 'tu',
        kind,
      });
    }
  });

  // Telegram のコールバックは 64 バイトまで。超えると送信時に落ちる。
  it('stays within the telegram callback limit for every kana pair', () => {
    const longest = encodeAnswer('kya', 'gyo', 'GLYPH_TO_ROMAJI');
    expect(Buffer.byteLength(longest, 'utf8')).toBeLessThanOrEqual(64);
  });

  it('rejects anything malformed', () => {
    expect(decodeAnswer('')).toBeUndefined();
    expect(decodeAnswer('kq:g:si')).toBeUndefined();
    expect(decodeAnswer('xx:g:si:tu')).toBeUndefined();
    expect(decodeAnswer('kq:z:si:tu')).toBeUndefined();
    expect(decodeAnswer('kq:g:si:tu:extra')).toBeUndefined();
  });

  // 外から来る文字列をそのまま採点に渡さない。
  it('rejects kana ids that do not exist', () => {
    expect(decodeAnswer('kq:g:nope:tu')).toBeUndefined();
    expect(decodeAnswer('kq:g:si:nope')).toBeUndefined();
  });
});

describe('isCorrectAnswer — 出題を保持せずに採点する', () => {
  it('accepts the target and rejects others', () => {
    expect(isCorrectAnswer('si', 'si', 'GLYPH_TO_ROMAJI')).toBe(true);
    expect(isCorrectAnswer('si', 'tu', 'GLYPH_TO_ROMAJI')).toBe(false);
  });

  // 「ji」と読める字は じ と ぢ の二つ。どちらを選んでも読みは合っている。
  it('accepts a kana that is genuinely indistinguishable in that format', () => {
    expect(isCorrectAnswer('zi', 'di', 'GLYPH_TO_ROMAJI')).toBe(true);
    expect(isCorrectAnswer('zu', 'du', 'ROMAJI_TO_GLYPH')).toBe(true);
    // 音で出したなら を と お は区別できない
    expect(isCorrectAnswer('wo', 'o', 'AUDIO_TO_GLYPH')).toBe(true);
    // だが字で出したなら別の字
    expect(isCorrectAnswer('wo', 'o', 'ROMAJI_TO_GLYPH')).toBe(false);
  });

  it('rejects an unknown target', () => {
    expect(isCorrectAnswer('nope', 'a', 'GLYPH_TO_ROMAJI')).toBe(false);
  });
});

describe('render', () => {
  it('lists today’s new kana with their readings', () => {
    const text = renderToday({
      newKana: [kana('a'), kana('i')],
      reviewCount: 3,
      newHeldBackForBacklog: false,
      progress: { introduced: 0, total: 104 },
    });
    expect(text).toContain('あ(a)');
    expect(text).toContain('い(i)');
    expect(text).toContain('复习 3 个');
    expect(text).toContain('0/104');
  });

  // 何も出ないときに理由を書かないと「壊れた」と受け取られる。
  it('explains why new kana were held back', () => {
    const text = renderToday({
      newKana: [],
      reviewCount: 40,
      newHeldBackForBacklog: true,
      progress: { introduced: 30, total: 104 },
    });
    expect(text).toContain('暂停');
    expect(text).toContain('积压');
  });

  it('says so when the syllabary is finished', () => {
    const text = renderToday({
      newKana: [],
      reviewCount: 2,
      newHeldBackForBacklog: false,
      progress: { introduced: 104, total: 104 },
    });
    expect(text).toContain('已全部学过');
  });

  it('asks the question in the direction being tested', () => {
    expect(
      renderQuestion({
        kind: 'GLYPH_TO_ROMAJI',
        targetId: 'a',
        script: 'hiragana',
        prompt: 'あ',
        options: [],
        correctIds: ['a'],
      }),
    ).toContain('あ');

    expect(
      renderQuestion({
        kind: 'ROMAJI_TO_GLYPH',
        targetId: 'a',
        script: 'hiragana',
        prompt: 'a',
        options: [],
        correctIds: ['a'],
      }),
    ).toContain('哪个是 a');
  });

  it('tells the learner what they picked when wrong', () => {
    const text = renderWrong(kana('si'), kana('tu'));
    expect(text).toContain('し');
    expect(text).toContain('つ');
    expect(text).toContain('tsu');
  });

  it('does not echo the choice when it was the right one', () => {
    const text = renderWrong(kana('si'), kana('si'));
    expect(text).not.toContain('你选的');
  });

  it('renders a progress bar of fixed width', () => {
    for (const introduced of [0, 1, 52, 103, 104]) {
      const text = renderProgress({
        introduced,
        total: 104,
        dueNow: 0,
        mastered: 0,
      });
      const bar = text.split('\n')[2] ?? '';
      const cells = [...bar].filter((c) => c === '█' || c === '░').length;
      expect(cells, `introduced=${String(introduced)}`).toBe(20);
    }
  });

  it('does not divide by zero on an empty syllabary', () => {
    expect(() =>
      renderProgress({ introduced: 0, total: 0, dueNow: 0, mastered: 0 }),
    ).not.toThrow();
  });
});
