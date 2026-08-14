import { describe, expect, it } from 'vitest';
import { creditableWords } from '../../src/learning/vocabReflow.js';
import type { Token } from '../../src/nlp/index.js';

function token(surface: string, pos = '名詞', basicForm = surface): Token {
  return {
    surface,
    pos,
    posDetail: '一般',
    basicForm,
    conjugatedForm: '',
    reading: undefined,
  } as Token;
}

/** 私は本を読みます。 */
const SENTENCE: Token[] = [
  token('私'),
  token('は', '助詞'),
  token('本'),
  token('を', '助詞'),
  token('読み', '動詞', '読む'),
  token('ます', '助動詞'),
  token('。', '記号'),
];

describe('creditableWords', () => {
  it('credits the known content words that were used', () => {
    const known = new Set(['本', '読む', '私']);
    expect(new Set(creditableWords(SENTENCE, known))).toEqual(
      new Set(['本', '読む', '私']),
    );
  });

  it('credits nothing when no word has been introduced yet', () => {
    expect(creditableWords(SENTENCE, new Set())).toEqual([]);
  });

  it('never credits particles or auxiliaries', () => {
    // 助詞まで既習に入れても数えない。文法は別の軸（GRAMMAR 型）。
    const known = new Set(['は', 'を', 'ます', '。']);
    expect(creditableWords(SENTENCE, known)).toEqual([]);
  });

  /**
   * 誤りに巻き込まれた語は「使えた」ではない。
   *
   * 「読むます」と書いた学習者は 読む を思い出せてはいるが、
   * 使えてはいない——ここを数えると、間違った使い方をしたものが
   * 掌握済みへ寄っていく。
   */
  it('does not credit a word caught up in a detected error', () => {
    const known = new Set(['本', '読む']);
    const credited = creditableWords(SENTENCE, known, [
      { original: '読みます' },
    ]);
    expect(credited).toEqual(['本']);
  });

  it('still credits the words outside the error', () => {
    const known = new Set(['本', '読む', '私']);
    const credited = creditableWords(SENTENCE, known, [{ original: 'は本を' }]);
    // 本 は誤りの断片に含まれるので外れ、私 と 読む は残る
    expect(new Set(credited)).toEqual(new Set(['私', '読む']));
  });

  it('ignores an empty error fragment instead of dropping everything', () => {
    const known = new Set(['本']);
    expect(creditableWords(SENTENCE, known, [{ original: '   ' }])).toEqual([
      '本',
    ]);
  });

  it('matches a conjugated verb through its dictionary form', () => {
    // 表層は「読み」だが、既習として登録されているのは「読む」
    expect(creditableWords(SENTENCE, new Set(['読む']))).toEqual(['読む']);
  });

  it('reports each word once however many times it appears', () => {
    const repeated = [...SENTENCE, token('本'), token('本')];
    expect(creditableWords(repeated, new Set(['本']))).toEqual(['本']);
  });
});
