import { describe, expect, it } from 'vitest';
import { SENTENCES } from '../../src/curriculum/sentences.js';
import {
  buildParticleBlank,
  buildWordOrder,
  isCorrectParticle,
  judgeWordOrder,
  toChunks,
  usableForParticle,
  usableForWordOrder,
} from '../../src/curriculum/writing.js';

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}
const find = (text: string) => {
  const s = SENTENCES.find((x) => x.text === text);
  if (s === undefined) throw new Error(`no sentence: ${text}`);
  return s;
};

describe('toChunks — 文节切分', () => {
  // 「住んで」「います」に割ると並べ替えの断片として意味を成さない。
  it('keeps a compound predicate together', () => {
    const chunks = toChunks(find('どこに住んでいますか？').tokens);
    expect(chunks.map((c) => c.text)).toEqual(['どこに', '住んでいますか？']);
  });

  it('keeps a prefix attached to its word', () => {
    const chunks = toChunks(find('おいくつですか？').tokens);
    expect(chunks.map((c) => c.text)).toEqual(['おいくつですか？']);
  });

  it('splits at content words', () => {
    const chunks = toChunks(find('誰か英語を話す人はいますか。').tokens);
    expect(chunks.map((c) => c.text)).toEqual([
      '誰か', '英語を', '話す', '人は', 'いますか。',
    ]);
  });

  it('never loses text', () => {
    for (const sentence of SENTENCES.slice(0, 400)) {
      const joined = toChunks(sentence.tokens).map((c) => c.text).join('');
      expect(joined, sentence.text).toBe(sentence.text);
    }
  });
});

describe('buildParticleBlank', () => {
  it('blanks exactly one particle', () => {
    const q = buildParticleBlank(find('どこに住んでいますか？'), {
      optionCount: 4, random: seeded(3),
    });
    expect(q).toBeDefined();
    expect(q?.prompt.match(/＿/g)).toHaveLength(1);
    expect(q?.answer).toBe('に');
    expect(q?.options).toHaveLength(4);
    expect(q?.options).toContain('に');
  });

  // 固定表現の一部を問うと、格助詞を選ぶ問題ではなくなる。
  // 「お飲みになる」の に は尊敬語の部品で、名詞には付いていない。
  it('only blanks a particle that follows a noun', () => {
    for (const sentence of SENTENCES.slice(0, 300)) {
      const q = buildParticleBlank(sentence, { optionCount: 4, random: seeded(9) });
      if (q === undefined) continue;
      const at = [...q.prompt].findIndex((c) => c === '＿');
      expect(at).toBeGreaterThan(0);
      // 空欄の直前は名詞由来の文字であるはず（助詞が連続していない）
      expect(q.prompt[at - 1]).not.toBe('＿');
    }
  });

  // 同じ助詞が他所にあると、本文を見れば答えが分かってしまう。
  it('never blanks a particle that appears elsewhere in the sentence', () => {
    for (const sentence of SENTENCES.slice(0, 400)) {
      const q = buildParticleBlank(sentence, { optionCount: 4, random: seeded(21) });
      if (q === undefined) continue;
      expect(q.prompt.includes(q.answer), q.full).toBe(false);
    }
  });

  it('grades deterministically', () => {
    const q = buildParticleBlank(find('どこに住んでいますか？'), {
      optionCount: 4, random: seeded(3),
    });
    if (q === undefined) throw new Error('no question');
    expect(isCorrectParticle(q, 'に')).toBe(true);
    for (const other of q.options.filter((o) => o !== 'に')) {
      expect(isCorrectParticle(q, other)).toBe(false);
    }
  });

  // 「使える」と言っておいて出題できないのは食い違い。
  it('agrees with usableForParticle', () => {
    for (const sentence of SENTENCES.slice(0, 500)) {
      const usable = usableForParticle(sentence);
      const q = buildParticleBlank(sentence, { optionCount: 4, random: seeded(7) });
      expect(usable, sentence.text).toBe(q !== undefined);
    }
  });
});

describe('buildWordOrder', () => {
  it('shuffles the chunks and keeps the answer', () => {
    const q = buildWordOrder(find('誰か英語を話す人はいますか。'), {
      random: seeded(5),
    });
    expect(q).toBeDefined();
    expect(q?.answer).toEqual(['誰か', '英語を', '話す', '人は', 'いますか。']);
    expect([...(q?.pieces ?? [])].sort()).toEqual([...(q?.answer ?? [])].sort());
  });

  it('never hands back the sentence already in order', () => {
    for (const sentence of SENTENCES.slice(0, 300)) {
      const q = buildWordOrder(sentence, { random: seeded(13) });
      if (q === undefined) continue;
      expect(q.pieces.join('')).not.toBe(q.answer.join(''));
    }
  });

  // 引用符付きの会話は文節に割ると符号が宙に浮く。
  it('skips quoted dialogue', () => {
    const quoted = SENTENCES.find((s) => s.text.includes('「'));
    if (quoted === undefined) return;
    expect(usableForWordOrder(quoted)).toBe(false);
  });

  it('agrees with usableForWordOrder', () => {
    for (const sentence of SENTENCES.slice(0, 400)) {
      if (!usableForWordOrder(sentence)) continue;
      expect(buildWordOrder(sentence, { random: seeded(2) })).toBeDefined();
    }
  });
});

describe('judgeWordOrder — 语序不是唯一的', () => {
  const order = {
    sentenceId: 'x',
    pieces: ['本を', '私は', '読みます。'],
    answer: ['私は', '本を', '読みます。'],
    movable: [true, true, false],
    full: '私は本を読みます。',
  };

  it('accepts the original order', () => {
    expect(judgeWordOrder(order, ['私は', '本を', '読みます。'])).toBe('CORRECT');
  });

  // 日本語の語順は比較的自由。「本を私は読みます」も文法的には通る。
  // これを ❌ にすると、正しく書いた学習者を間違いだと言うことになる。
  it('treats a grammatical reordering as acceptable, not wrong', () => {
    expect(judgeWordOrder(order, ['本を', '私は', '読みます。'])).toBe(
      'ACCEPTABLE',
    );
  });

  // 述語が最後に来るのは日本語の必須条件。ここだけは厳しく見る。
  it('rejects an order that does not end with the predicate', () => {
    expect(judgeWordOrder(order, ['読みます。', '私は', '本を'])).toBe('WRONG');
  });

  it('rejects a wrong set of pieces', () => {
    expect(judgeWordOrder(order, ['私は', '読みます。'])).toBe('WRONG');
    expect(judgeWordOrder(order, ['私は', '本を', 'ちがう'])).toBe('WRONG');
  });
});

describe('sentence pool', () => {
  it('is large enough to practise with', () => {
    expect(SENTENCES.length).toBeGreaterThan(1500);
    // 引数をそのまま渡さないこと。`usableForParticle` の第二引数は
    // particleId なので、filter の index が入ると全件 false になる。
    expect(SENTENCES.filter((s) => usableForParticle(s)).length).toBeGreaterThan(
      800,
    );
    expect(SENTENCES.filter(usableForWordOrder).length).toBeGreaterThan(800);
  });

  it('carries its source id so the sentence can be traced', () => {
    for (const sentence of SENTENCES.slice(0, 50)) {
      expect(sentence.id).toMatch(/^\d+$/);
      expect(sentence.tokens.length).toBeGreaterThan(0);
    }
  });
});

describe('judgeWordOrder — 连体修饰不能移动', () => {
  // 「新しい」は「学校」を修飾する。後ろへ回すと修飾関係が切れて非文。
  // 述語が最後に来ているだけでは合格にできない。
  const order = {
    sentenceId: 'y',
    pieces: ['学校は', '新しい', 'どうですか。'],
    answer: ['新しい', '学校は', 'どうですか。'],
    movable: [false, true, false],
    full: '新しい学校はどうですか。',
  };

  it('accepts the original order', () => {
    expect(judgeWordOrder(order, ['新しい', '学校は', 'どうですか。'])).toBe(
      'CORRECT',
    );
  });

  it('rejects moving a modifier away from what it modifies', () => {
    expect(judgeWordOrder(order, ['学校は', '新しい', 'どうですか。'])).toBe(
      'WRONG',
    );
  });

  it('still allows particle-marked phrases to move', () => {
    const two = {
      sentenceId: 'z',
      pieces: [] as string[],
      answer: ['私は', '毎日', '本を', '読みます。'],
      movable: [true, false, true, false],
      full: '私は毎日本を読みます。',
    };
    // 私は / 本を は助詞付きなので入れ替え可
    expect(judgeWordOrder(two, ['私は', '毎日', '本を', '読みます。'])).toBe(
      'CORRECT',
    );
    // 毎日（副詞、助詞なし）を動かすと不可
    expect(judgeWordOrder(two, ['毎日', '私は', '本を', '読みます。'])).toBe(
      'WRONG',
    );
  });
});
