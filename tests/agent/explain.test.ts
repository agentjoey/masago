import { describe, expect, it } from 'vitest';
import { stripMarkdown } from '../../src/agent/explain.js';

describe('stripMarkdown', () => {
  // 方針で禁じても実際は `**し**` が返ってくる。素のテキストで送るので
  // 記号がそのまま見えてしまう（2026-08-14 実測）。
  it('removes bold markers the model emits anyway', () => {
    expect(stripMarkdown('**し**：平假名')).toBe('し：平假名');
    expect(stripMarkdown('**ノート**（罗马音：nooto）')).toBe(
      'ノート（罗马音：nooto）',
    );
  });

  it('removes headings and bullets', () => {
    expect(stripMarkdown('## 说明\n- 第一点\n- 第二点')).toBe(
      '说明\n第一点\n第二点',
    );
  });

  it('leaves ordinary japanese and chinese untouched', () => {
    const text = '「いま」是时间副词，意思是"现在"。\n今、ねます。';
    expect(stripMarkdown(text)).toBe(text);
  });

  // 日本語の文中に出る記号を巻き込まない。
  it('does not mangle text that merely contains an asterisk', () => {
    expect(stripMarkdown('2 * 3 = 6')).toBe('2 * 3 = 6');
    expect(stripMarkdown('a_b_c')).toBe('a_b_c');
  });

  it('trims surrounding whitespace', () => {
    expect(stripMarkdown('\n\n  こんにちは  \n')).toBe('こんにちは');
  });
});
