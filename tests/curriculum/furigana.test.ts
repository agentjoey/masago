import { describe, expect, it } from 'vitest';
import {
  assignRuby,
  escapeHtml,
  hasKanji,
  katakanaToHiragana,
  renderRubyHtml,
  toRubySegments,
} from '../../src/curriculum/furigana.js';

describe('katakanaToHiragana', () => {
  it('converts readings for display', () => {
    expect(katakanaToHiragana('タベル')).toBe('たべる');
    expect(katakanaToHiragana('ジテンシャ')).toBe('じてんしゃ');
  });

  it('leaves長音 and non-katakana alone', () => {
    expect(katakanaToHiragana('ノート')).toBe('のーと');
    expect(katakanaToHiragana('abc')).toBe('abc');
  });
});

describe('assignRuby — 送り仮名を巻き込まない', () => {
  // 語全体に振ると「食べる(たべる)」になり、送り仮名にまで読みが被る。
  it('puts ruby only on the kanji of 食べる', () => {
    expect(assignRuby('食べる', 'タベル')).toEqual([
      { text: '食', ruby: 'た' },
      { text: 'べる', ruby: undefined },
    ]);
  });

  it('handles a leading kana (お茶)', () => {
    expect(assignRuby('お茶', 'オチャ')).toEqual([
      { text: 'お', ruby: undefined },
      { text: '茶', ruby: 'ちゃ' },
    ]);
  });

  it('handles an all-kanji word', () => {
    expect(assignRuby('自転車', 'ジテンシャ')).toEqual([
      { text: '自転車', ruby: 'じてんしゃ' },
    ]);
  });

  it('handles a single kanji', () => {
    expect(assignRuby('見', 'ミ')).toEqual([{ text: '見', ruby: 'み' }]);
  });

  it('handles kana on both sides (お誕生日)', () => {
    const segments = assignRuby('お誕生日', 'オタンジョウビ');
    expect(segments[0]).toEqual({ text: 'お', ruby: undefined });
    expect(segments[1]?.text).toBe('誕生日');
    expect(segments[1]?.ruby).toBe('たんじょうび');
  });

  it('leaves kana-only words untouched', () => {
    expect(assignRuby('たべる', 'タベル')).toEqual([
      { text: 'たべる', ruby: undefined },
    ]);
  });

  // 間違った読みを振るくらいなら振らない。零基础学习者は誤りに気づけない。
  it('gives up rather than guessing when the reading does not fit', () => {
    expect(assignRuby('見る', '')).toEqual([{ text: '見る', ruby: undefined }]);
    // 読みが表層と噛み合わない場合も、無理に当てない
    const odd = assignRuby('本', 'マッタクチガウ');
    expect(odd).toHaveLength(1);
    expect(odd[0]?.text).toBe('本');
  });

  it('never loses any of the original text', () => {
    for (const [surface, reading] of [
      ['食べる', 'タベル'],
      ['お茶', 'オチャ'],
      ['自転車', 'ジテンシャ'],
      ['見ました', 'ミマシタ'],
      ['お誕生日', 'オタンジョウビ'],
    ] as const) {
      const joined = assignRuby(surface, reading)
        .map((s) => s.text)
        .join('');
      expect(joined, surface).toBe(surface);
    }
  });
});

describe('toRubySegments', () => {
  it('walks a whole sentence', () => {
    const segments = toRubySegments([
      { surface: '私', reading: 'ワタシ' },
      { surface: 'は', reading: 'ハ' },
      { surface: '本', reading: 'ホン' },
      { surface: 'を', reading: 'ヲ' },
      { surface: '読み', reading: 'ヨミ' },
      { surface: 'ます', reading: 'マス' },
    ]);
    const text = segments.map((s) => s.text).join('');
    expect(text).toBe('私は本を読みます');
    // 仮名だけの語には振らない
    expect(segments.find((s) => s.text === 'は')?.ruby).toBeUndefined();
    expect(segments.find((s) => s.text === '私')?.ruby).toBe('わたし');
  });

  it('handles tokens with no reading', () => {
    const segments = toRubySegments([{ surface: '？', reading: undefined }]);
    expect(segments).toEqual([{ text: '？', ruby: undefined }]);
  });
});

describe('renderRubyHtml', () => {
  it('wraps kanji in ruby tags', () => {
    const html = renderRubyHtml([
      { text: '私', ruby: 'わたし' },
      { text: 'は', ruby: undefined },
    ]);
    expect(html).toBe('<ruby>私<rt>わたし</rt></ruby>は');
  });

  // 本文には利用者の入力が混ざる。逃がさないと注入になる。
  it('escapes html in both the text and the reading', () => {
    const html = renderRubyHtml([
      { text: '<script>', ruby: undefined },
      { text: '本', ruby: '"><img>' },
    ]);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('helpers', () => {
  it('detects kanji', () => {
    expect(hasKanji('本')).toBe(true);
    expect(hasKanji('ほん')).toBe(false);
    expect(hasKanji('々')).toBe(true);
  });

  it('escapes every dangerous character', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});
