import { describe, expect, it } from 'vitest';
import {
  decodeAnswer,
  encodeAnswer,
  isTypedTier,
  questionKindFor,
  targetOfQuestionText,
  tierFor,
} from '../../src/learning/kanaDrill.js';
import { isCorrectAnswer } from '../../src/curriculum/quiz.js';
import {
  renderCost,
  renderProgress,
  renderQuestion,
  renderToday,
  renderWrong,
} from '../../src/curriculum/render.js';
import { KANA, KANA_BY_ID, type Kana } from '../../src/curriculum/kana.js';

function kana(id: string): Kana {
  const found = KANA_BY_ID.get(id);
  if (found === undefined) throw new Error(`unknown kana ${id}`);
  return found;
}

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

describe('drill tiers — §4.3 的输入分档', () => {
  // 认得 → 想得起 → 打得出。每一档都比上一档少给一点帮助。
  it('climbs from recognising to producing', () => {
    expect(tierFor(0)).toBe('RECOGNIZE');
    expect(tierFor(1)).toBe('RECOGNIZE');
    expect(tierFor(2)).toBe('RECALL');
    expect(tierFor(3)).toBe('RECALL');
    expect(tierFor(4)).toBe('PRODUCE');
    expect(tierFor(50)).toBe('PRODUCE');
  });

  it('only asks the learner to type at the last tier', () => {
    expect(isTypedTier(0)).toBe(false);
    expect(isTypedTier(3)).toBe(false);
    expect(isTypedTier(4)).toBe(true);
  });

  // 打たせるときは字を見せて読みを訊く。読みを見せて仮名を打たせるのは
  // かな入力が要るので、この段階では出さない。
  it('shows the glyph when it wants the reading typed', () => {
    expect(questionKindFor(4)).toBe('GLYPH_TO_ROMAJI');
    expect(questionKindFor(0)).toBe('GLYPH_TO_ROMAJI');
    expect(questionKindFor(2)).toBe('ROMAJI_TO_GLYPH');
  });
});

describe('targetOfQuestionText — 从被回复的消息里认出考的是哪个假名', () => {
  it('recovers the target from a typed question', () => {
    const text = renderQuestion(
      {
        kind: 'GLYPH_TO_ROMAJI',
        targetId: 'si',
        script: 'hiragana',
        prompt: 'し',
        options: [],
        correctIds: ['si'],
      },
      true,
    );
    expect(targetOfQuestionText(text)).toBe('si');
  });

  it('round-trips for every kana', () => {
    for (const kana of KANA) {
      const text = renderQuestion(
        {
          kind: 'GLYPH_TO_ROMAJI',
          targetId: kana.id,
          script: 'hiragana',
          prompt: kana.hiragana,
          options: [],
          correctIds: [kana.id],
        },
        true,
      );
      expect(targetOfQuestionText(text), kana.id).toBe(kana.id);
    }
  });

  // 普通の会話に返信しただけなら、採点してはいけない。
  it('returns nothing for a message that is not a question', () => {
    expect(targetOfQuestionText('こんにちは！今日はどうでしたか？')).toBeUndefined();
    expect(targetOfQuestionText('')).toBeUndefined();
    expect(targetOfQuestionText('📊 五十音进度\n\n已学 5/104')).toBeUndefined();
  });

  // 説明文の中に紛れた同じ字を拾わない。行全体が字形のときだけ。
  it('ignores kana that appear inside explanatory text', () => {
    expect(
      targetOfQuestionText('あ行を勉強しましょう。がんばって！'),
    ).toBeUndefined();
  });

  it('finds the glyph even with surrounding whitespace', () => {
    expect(targetOfQuestionText('这个假名怎么读？\n\n  か  \n\n直接回复')).toBe(
      'ka',
    );
  });
});

describe('renderQuestion — typed variant', () => {
  const question = {
    kind: 'GLYPH_TO_ROMAJI' as const,
    targetId: 'ka',
    script: 'hiragana' as const,
    prompt: 'か',
    options: [],
    correctIds: ['ka'],
  };

  it('tells the learner to type when there are no buttons', () => {
    const typed = renderQuestion(question, true);
    expect(typed).toContain('直接回复');
    expect(typed).toContain('か');
  });

  it('keeps the glyph on a line of its own so it can be recovered', () => {
    const lines = renderQuestion(question, true).split('\n');
    expect(lines).toContain('か');
  });

  it('says nothing about typing in the button variant', () => {
    expect(renderQuestion(question)).not.toContain('直接回复');
  });
});

describe('renderWrong — typed answers', () => {
  it('echoes what the learner typed', () => {
    const text = renderWrong(kana('si'), undefined, 'sa');
    expect(text).toContain('し');
    expect(text).toContain('「sa」');
  });

  it('does not echo an empty answer', () => {
    expect(renderWrong(kana('si'), undefined, '   ')).not.toContain('你打的是');
  });
});

describe('renderCost', () => {
  const base = {
    todayUsd: 0.0123,
    monthUsd: 0.4567,
    dailyLimitUsd: 1,
    monthlyLimitUsd: 10,
    unknownCostCalls: 0,
    topThisMonth: [] as { label: string; usd: number }[],
  };

  // 金額だけでは多いか少ないか判断できない。上限に対する割合を必ず出す。
  it('shows spend against the limit, not just the amount', () => {
    const text = renderCost(base);
    expect(text).toContain('$0.0123');
    expect(text).toContain('$1.0000');
    expect(text).toContain('1%');
    expect(text).toContain('5%');
  });

  it('lists what the month was spent on', () => {
    const text = renderCost({
      ...base,
      topThisMonth: [
        { label: 'minimax/MiniMax-M3', usd: 0.4 },
        { label: 'minimax/speech-2.8-hd', usd: 0.05 },
      ],
    });
    expect(text).toContain('minimax/MiniMax-M3');
    expect(text).toContain('speech-2.8-hd');
  });

  // 価格表に無い呼び出しを黙って落とすと、実際より安く見える。
  it('warns when some calls could not be priced', () => {
    const text = renderCost({ ...base, unknownCostCalls: 3 });
    expect(text).toContain('未计价');
    expect(text).toContain('3');
  });

  it('says nothing about unpriced calls when there are none', () => {
    expect(renderCost(base)).not.toContain('未计价');
  });

  it('does not divide by zero when no limit is set', () => {
    const text = renderCost({ ...base, dailyLimitUsd: 0, monthlyLimitUsd: 0 });
    expect(text).toContain('—');
    expect(text).not.toContain('Infinity');
    expect(text).not.toContain('NaN');
  });
});
