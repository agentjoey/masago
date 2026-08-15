import { describe, expect, it } from 'vitest';
import {
  decodeAnswer,
  encodeAnswer,
  isTypedTier,
  questionKindFor,
  scriptFor,
  targetOfQuestionText,
  tierFor,
} from '../../src/learning/kanaDrill.js';
import { isCorrectAnswer } from '../../src/curriculum/quiz.js';
import { VOCAB_BY_ID } from '../../src/curriculum/vocab.js';
import {
  renderActivity,
  renderCorrect,
  renderCost,
  renderDaily,
  renderFullProgress,
  renderProgress,
  renderQuestion,
  renderToday,
  renderWrong,
  streakOf,
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
      for (const script of ['hiragana', 'katakana'] as const) {
        const encoded = encodeAnswer('si', 'tu', kind, script);
        expect(decodeAnswer(encoded)).toEqual({
          targetId: 'si',
          chosenId: 'tu',
          kind,
          script,
        });
      }
    }
  });

  // Telegram のコールバックは 64 バイトまで。超えると送信時に落ちる。
  it('stays within the telegram callback limit for every kana pair', () => {
    const longest = encodeAnswer('kya', 'gyo', 'GLYPH_TO_ROMAJI', 'katakana');
    expect(Buffer.byteLength(longest, 'utf8')).toBeLessThanOrEqual(64);
  });

  /**
   * 字体を載せる前に配信したボタンが会話に残っている。押しても何も
   * 起きないのは、壊れていることすら分からない壊れ方——平仮名として
   * 受ける（字体を足す前は平仮名しか出していなかった段も同じ）。
   */
  it('still accepts the payload shape used before the script was carried', () => {
    expect(decodeAnswer('kq:g:si:tu')).toEqual({
      targetId: 'si',
      chosenId: 'tu',
      kind: 'GLYPH_TO_ROMAJI',
      script: 'hiragana',
    });
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
    const text = renderWrong(kana('si'), kana('tu'), undefined, 'hiragana');
    expect(text).toContain('し');
    expect(text).toContain('つ');
    expect(text).toContain('tsu');
  });

  it('does not echo the choice when it was the right one', () => {
    const text = renderWrong(kana('si'), kana('si'), undefined, 'hiragana');
    expect(text).not.toContain('你选的');
  });

  /**
   * 判定は**出題と同じ字体**で返す。
   *
   * 実際に出た不具合：`キ` と訊いておいて「正确答案是 き」と返していた。
   * 零基礎の学習者に キ と き が同じ音だと**見抜く手立ては無い**（§15）
   * ——別の字の話をされたとしか読めないし、押した札（コ）と講評の字（こ）
   * が違うので、どれを押したのかも突き合わせられない。
   */
  it('answers in the same script the question was asked in', () => {
    const wrong = renderWrong(kana('ki'), kana('ko'), undefined, 'katakana');
    expect(wrong).toContain('キ');
    expect(wrong).toContain('コ');
    expect(wrong).not.toContain('き');
    expect(wrong).not.toContain('こ');

    expect(renderCorrect(kana('ki'), 'katakana')).toContain('キ');
    expect(renderCorrect(kana('ki'), 'katakana')).not.toContain('き');
  });

  it('still uses hiragana when that is what was asked', () => {
    const wrong = renderWrong(kana('ki'), kana('ko'), undefined, 'hiragana');
    expect(wrong).toContain('き');
    expect(wrong).toContain('こ');
    expect(renderCorrect(kana('ki'), 'hiragana')).toContain('き');
  });

  /**
   * 一日ぶんを終えた日の `/today`。
   *
   * 「今天没有到期的内容」と出して入口も /review だけにしていたので、
   * **まだ 94 字残っているのに今日はもう終わりに見えた**。一日の数は
   * 計画であって上限ではない——続けられることを言い、入口も出す。
   */
  it('says the day’s plan is done, not that there is nothing left', () => {
    const text = renderDaily({
      stage: 'S0_KANA_ONLY',
      newKana: [],
      kanaDue: 0,
      newWords: [],
      vocabDue: 0,
      newParticles: [],
      grammarDue: 0,
      heldBack: false,
      kanaProgress: { introduced: 10, total: 104 },
      vocabProgress: { introduced: 0, total: 1301 },
      grammarProgress: { introduced: 0, total: 12 },
    });
    expect(text).not.toContain('今天没有到期的内容');
    expect(text).toContain('/kana');
  });

  // 本当に全部終わっているときまで「続けられる」と言ってはいけない。
  it('does not promise more when everything really is learned', () => {
    const text = renderDaily({
      stage: 'S0_KANA_ONLY',
      newKana: [],
      kanaDue: 0,
      newWords: [],
      vocabDue: 0,
      newParticles: [],
      grammarDue: 0,
      heldBack: false,
      kanaProgress: { introduced: 104, total: 104 },
      vocabProgress: { introduced: 1301, total: 1301 },
      grammarProgress: { introduced: 12, total: 12 },
    });
    expect(text).toContain('今天没有到期的内容');
  });

  // 積み残しの保護は硬いまま。ここで「続けよう」と誘ってはいけない。
  it('still tells the learner to catch up when the backlog is holding new items', () => {
    const text = renderDaily({
      stage: 'S0_KANA_ONLY',
      newKana: [],
      kanaDue: 0,
      newWords: [],
      vocabDue: 0,
      newParticles: [],
      grammarDue: 0,
      heldBack: true,
      kanaProgress: { introduced: 10, total: 104 },
      vocabProgress: { introduced: 0, total: 1301 },
      grammarProgress: { introduced: 0, total: 12 },
    });
    expect(text).toContain('积压');
    expect(text).not.toContain('计划做完');
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
  // 认得 → 想得起 → 片假名 → 打得出。每一档都比上一档少给一点帮助。
  it('climbs from recognising to producing', () => {
    expect(tierFor(0)).toBe('RECOGNIZE');
    expect(tierFor(1)).toBe('RECOGNIZE');
    expect(tierFor(2)).toBe('RECALL');
    expect(tierFor(3)).toBe('RECALL');
    expect(tierFor(4)).toBe('KATAKANA');
    expect(tierFor(5)).toBe('KATAKANA');
    expect(tierFor(6)).toBe('PRODUCE');
    expect(tierFor(50)).toBe('PRODUCE');
  });

  it('only asks the learner to type at the last tier', () => {
    expect(isTypedTier(0)).toBe(false);
    expect(isTypedTier(4)).toBe(false);
    expect(isTypedTier(6)).toBe(true);
  });

  it('shows the glyph when it wants the reading typed', () => {
    expect(questionKindFor(6)).toBe('GLYPH_TO_ROMAJI');
    expect(questionKindFor(0)).toBe('GLYPH_TO_ROMAJI');
    expect(questionKindFor(2)).toBe('ROMAJI_TO_GLYPH');
  });
});

describe('scriptFor — 片假名什么时候进来', () => {
  // 一上来就两种字体一起记太重。先把平假名坐实。
  it('stays on hiragana while the glyph is still new', () => {
    expect(scriptFor(0)).toBe('hiragana');
    expect(scriptFor(3)).toBe('hiragana');
  });

  // シ/ツ、ソ/ン 是片假名独有的坑，得有选项并排才逼得出区分。
  it('introduces katakana with options, not by typing', () => {
    expect(scriptFor(4)).toBe('katakana');
    expect(scriptFor(5)).toBe('katakana');
    expect(isTypedTier(4)).toBe(false);
  });

  // 只会一种字体等于只读得懂一半。
  it('alternates both scripts once producing', () => {
    const seen = new Set([scriptFor(6), scriptFor(7), scriptFor(8)]);
    expect(seen).toEqual(new Set(['hiragana', 'katakana']));
  });

  it('covers both scripts across a long history', () => {
    const scripts = new Set(
      Array.from({ length: 20 }, (_, reps) => scriptFor(reps)),
    );
    expect(scripts).toEqual(new Set(['hiragana', 'katakana']));
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
    const text = renderWrong(kana('si'), undefined, 'sa', 'hiragana');
    expect(text).toContain('し');
    expect(text).toContain('「sa」');
  });

  it('does not echo an empty answer', () => {
    expect(
      renderWrong(kana('si'), undefined, '   ', 'hiragana'),
    ).not.toContain('你打的是');
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

describe('renderFullProgress', () => {
  const kana = { introduced: 46, total: 104, dueNow: 3, mastered: 10 };
  const vocab = { introduced: 15, total: 671, dueNow: 4, mastered: 0 };

  // 語彙を始める前に 0/671 を並べても、今日やることは変わらない。
  it('hides vocabulary until it has begun', () => {
    const text = renderFullProgress({
      kana,
      vocab: { ...vocab, introduced: 0 },
      showVocab: false,
    });
    expect(text).toContain('五十音');
    expect(text).not.toContain('N5 单词');
  });

  it('shows both once vocabulary has begun', () => {
    const text = renderFullProgress({ kana, vocab, showVocab: true });
    expect(text).toContain('五十音');
    expect(text).toContain('单词');
    expect(text).toContain('46/104');
    expect(text).toContain('15/671');
  });

  // 合計だけだと「1375 のうち 90」で、いまどの等級のどこかが分からない。
  it('shows where the learner is inside the current level', () => {
    const text = renderFullProgress({
      kana,
      vocab: { ...vocab, total: 1329 },
      showVocab: true,
      vocabLevel: 'N5',
      levelProgress: { introduced: 15, total: 671 },
    });
    expect(text).toContain('N5 单词');
    expect(text).toContain('N5 15/671');
    expect(text).toContain('合计 15/1329');
  });

  it('keeps every bar the same width', () => {
    const text = renderFullProgress({ kana, vocab, showVocab: true });
    const bars = text
      .split('\n')
      .filter((line) => line.includes('█') || line.includes('░'));
    expect(bars).toHaveLength(2);
    for (const line of bars) {
      const cells = [...line].filter((c) => c === '█' || c === '░').length;
      expect(cells).toBe(20);
    }
  });

  it('does not divide by zero', () => {
    expect(() =>
      renderFullProgress({
        kana: { introduced: 0, total: 0, dueNow: 0, mastered: 0 },
        vocab: { introduced: 0, total: 0, dueNow: 0, mastered: 0 },
        showVocab: true,
      }),
    ).not.toThrow();
  });
});

describe('renderDaily', () => {
  const wordsOf = (ids: string[]) =>
    ids.map((id) => {
      const found = VOCAB_BY_ID.get(id);
      if (found === undefined) throw new Error(`unknown ${id}`);
      return found;
    });

  const base = {
    stage: 'S1_VOCAB',
    newKana: [] as never[],
    kanaDue: 0,
    newWords: [] as never[],
    vocabDue: 0,
    grammarDue: 0,
    newParticles: [] as never[],
    kanaProgress: { introduced: 46, total: 104 },
    vocabProgress: { introduced: 10, total: 671 },
    grammarProgress: { introduced: 0, total: 12 },
    heldBack: false,
  };

  // 仮名だけの語は表記と読みが同じ。「ノート(ノート)」は壊れて見える。
  it('does not repeat the reading for kana-only words', () => {
    const text = renderDaily({
      ...base,
      newWords: wordsOf(['ノート#ノート', '大学#だいがく']),
    });
    expect(text).not.toContain('ノート(ノート)');
    expect(text).toContain('大学(だいがく)');
  });

  /**
   * この夹具は 46/104——**まだ 58 字残っている**。ここで
   * 「今天没有到期的内容」と出していたので、一日ぶんを終えただけで
   * 今日はもう終わりに見えた。残りがあるなら、そう言う。
   */
  it('says the plan is done while there is still material left', () => {
    const text = renderDaily(base);
    expect(text).toContain('计划做完');
    expect(text).not.toContain('今天没有到期的内容');
  });

  it('explains a hold-back instead of looking empty', () => {
    expect(renderDaily({ ...base, heldBack: true })).toContain('积压');
  });

  it('lists both progress lines', () => {
    const text = renderDaily(base);
    expect(text).toContain('46/104');
    expect(text).toContain('10/671');
  });

  /**
   * 助詞は FSRS で排程されているのに /today が触れていなかった。
   * 期限が来たことに気づく手立てが無く、/write を自分で思い出すしかない。
   */
  it('surfaces due particles and points at /write', () => {
    const text = renderDaily({ ...base, grammarDue: 3 });
    expect(text).toContain('助词复习 3 个');
    expect(text).toContain('/write');
    expect(text).not.toContain('今天没有到期的内容');
  });

  it('names the new particles the way it names new kana', () => {
    const text = renderDaily({
      ...base,
      newParticles: [
        { id: 'wa', surface: 'は', reading: 'wa', label: '主题', blankable: 1950 },
        { id: 'wo', surface: 'を', reading: 'o', label: '宾语', blankable: 846 },
      ] as never,
    });
    expect(text).toContain('新助词 2 个');
    // 読みが表記と違う三つは、ここで気づける形にしておく
    expect(text).toContain('は(wa)');
    expect(text).toContain('を(o)');
  });

  /** 助詞をまだ始めていない段階で 0/12 を突きつけない（語彙と同じ）。 */
  it('hides the particle progress line before the learner starts', () => {
    expect(renderDaily(base)).not.toContain('助词 0/12');
    expect(renderDaily({ ...base, grammarProgress: { introduced: 4, total: 12 } }))
      .toContain('助词 4/12');
  });

  /**
   * 案内は「今日やることがある入口」だけ。全部並べるとどれを押せば
   * いいのか分からない。
   */
  it('only offers the entries that have something to do', () => {
    const onlyKana = renderDaily({ ...base, kanaDue: 5 });
    expect(onlyKana).toContain('/kana');
    expect(onlyKana).not.toContain('/vocab');
    expect(onlyKana).not.toContain('/write');

    const onlyGrammar = renderDaily({ ...base, grammarDue: 2 });
    expect(onlyGrammar).toContain('/write');
    expect(onlyGrammar).not.toContain('/kana 练假名');
  });
});

describe('activity and streak', () => {
  const dayBefore = (key: string, back: number): string => {
    const [y, m, d] = key.split('-').map((p) => Number.parseInt(p, 10));
    const at = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) - back));
    return `${String(at.getUTCFullYear())}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-${String(at.getUTCDate()).padStart(2, '0')}`;
  };

  it('shows which days were practised at a glance', () => {
    const text = renderActivity({
      days: [
        { day: '2026-08-08', count: 0 },
        { day: '2026-08-09', count: 5 },
        { day: '2026-08-10', count: 20 },
        { day: '2026-08-11', count: 0 },
        { day: '2026-08-12', count: 12 },
        { day: '2026-08-13', count: 8 },
        { day: '2026-08-14', count: 3 },
      ],
      streak: 3,
    });
    expect(text).toContain('· ▪ ■ · ■ ▪ ▪');
    expect(text).toContain('共 48 题');
    expect(text).toContain('连续 3 天');
  });

  it('does not brag about a streak of one', () => {
    expect(
      renderActivity({ days: [{ day: '2026-08-14', count: 2 }], streak: 1 }),
    ).not.toContain('连续');
  });

  it('counts a streak ending today', () => {
    const counts = new Map([
      ['2026-08-12', 5],
      ['2026-08-13', 3],
      ['2026-08-14', 7],
    ]);
    expect(streakOf(counts, '2026-08-14', dayBefore)).toBe(3);
  });

  // 夜にまとめてやる人の連続を、日中に見ただけで 0 に見せない。
  it('still counts the streak before today’s practice', () => {
    const counts = new Map([
      ['2026-08-12', 5],
      ['2026-08-13', 3],
    ]);
    expect(streakOf(counts, '2026-08-14', dayBefore)).toBe(2);
  });

  it('breaks the streak on a missed day', () => {
    const counts = new Map([
      ['2026-08-10', 5],
      ['2026-08-11', 5],
      ['2026-08-13', 3],
      ['2026-08-14', 7],
    ]);
    expect(streakOf(counts, '2026-08-14', dayBefore)).toBe(2);
  });

  // 二週間前の連続を今日の連続として見せない。
  it('is zero when nothing was done recently', () => {
    const counts = new Map([['2026-07-01', 30]]);
    expect(streakOf(counts, '2026-08-14', dayBefore)).toBe(0);
  });

  it('crosses a month boundary', () => {
    const counts = new Map([
      ['2026-07-30', 4],
      ['2026-07-31', 4],
      ['2026-08-01', 4],
    ]);
    expect(streakOf(counts, '2026-08-01', dayBefore)).toBe(3);
  });
});
