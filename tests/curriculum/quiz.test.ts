import { describe, expect, it } from 'vitest';
import { KANA, KANA_BY_ID, type Kana } from '../../src/curriculum/kana.js';
import {
  buildQuestion,
  isCorrectChoice,
  isCorrectRomaji,
  type QuestionKind,
} from '../../src/curriculum/quiz.js';

/** 決定的な乱数。同じ入力からは必ず同じ問題が出る。 */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

function kana(id: string): Kana {
  const found = KANA_BY_ID.get(id);
  if (found === undefined) throw new Error(`unknown kana ${id}`);
  return found;
}

const KINDS: QuestionKind[] = [
  'GLYPH_TO_ROMAJI',
  'ROMAJI_TO_GLYPH',
  'AUDIO_TO_GLYPH',
];

describe('buildQuestion', () => {
  it('produces the requested number of distinct options, including the target', () => {
    const q = buildQuestion(kana('ka'), {
      kind: 'GLYPH_TO_ROMAJI',
      script: 'hiragana',
      optionCount: 4,
      random: seeded(1),
    });
    expect(q.options).toHaveLength(4);
    expect(new Set(q.options.map((o) => o.kanaId)).size).toBe(4);
    expect(q.options.map((o) => o.kanaId)).toContain('ka');
    expect(q.prompt).toBe('か');
  });

  it('labels options by what the learner must choose', () => {
    const toRomaji = buildQuestion(kana('ka'), {
      kind: 'GLYPH_TO_ROMAJI',
      script: 'hiragana',
      optionCount: 4,
      random: seeded(2),
    });
    for (const option of toRomaji.options) {
      expect(option.label).toBe(KANA_BY_ID.get(option.kanaId)?.romaji);
    }

    const toGlyph = buildQuestion(kana('ka'), {
      kind: 'ROMAJI_TO_GLYPH',
      script: 'katakana',
      optionCount: 4,
      random: seeded(2),
    });
    expect(toGlyph.prompt).toBe('ka');
    for (const option of toGlyph.options) {
      expect(option.label).toBe(KANA_BY_ID.get(option.kanaId)?.katakana);
    }
  });

  it('gives no visible prompt for audio questions', () => {
    const q = buildQuestion(kana('ka'), {
      kind: 'AUDIO_TO_GLYPH',
      script: 'hiragana',
      optionCount: 4,
      random: seeded(3),
    });
    expect(q.prompt).toBe('');
    expect(q.options.map((o) => o.label)).toContain('か');
  });

  // 一番効く誤答は、実際に間違える字。無作為だとシ/ツ が一生並ばない。
  it('prefers confusable kana as distractors', () => {
    const q = buildQuestion(kana('si'), {
      kind: 'ROMAJI_TO_GLYPH',
      script: 'katakana',
      optionCount: 4,
      random: seeded(7),
    });
    expect(q.options.map((o) => o.kanaId)).toContain('tu'); // シ と ツ
  });

  it('never offers two options that are both right', () => {
    for (const kind of KINDS) {
      for (const target of KANA) {
        for (let seed = 1; seed <= 3; seed += 1) {
          const q = buildQuestion(target, {
            kind,
            script: 'hiragana',
            optionCount: 4,
            random: seeded(seed * 31 + target.id.length),
          });
          expect(
            q.correctIds,
            `${kind}/${target.id}/seed${String(seed)}`,
          ).toHaveLength(1);
          expect(q.correctIds[0]).toBe(target.id);
        }
      }
    }
  });

  // じ/ぢ も ず/づ も「ji」「zu」。片方を誤答に入れた瞬間、答えが二つになる。
  //
  // 全仮名を誤答候補にした場合は同行が先に埋まるので、この衝突は起きない。
  // だが実際の学習順では だ行 に入る時点で ざ行 は習い終えており、
  // ぢ の誤答候補に じ が入りうる。起きうる状況をそのまま組んで確かめる。
  it('keeps same-reading kana out of each other’s options', () => {
    const taught = KANA.filter(
      (k) =>
        ['あ', 'か', 'さ', 'ざ'].includes(k.row) ||
        // だ行 は学び始めたばかり——同行の誤答が足りず、他行から取ることになる
        ['da', 'di'].includes(k.id),
    );

    for (const [target, twin] of [
      ['di', 'zi'],
      ['du', 'zu'],
    ] as const) {
      for (let seed = 1; seed <= 30; seed += 1) {
        for (const kind of ['GLYPH_TO_ROMAJI', 'ROMAJI_TO_GLYPH'] as const) {
          const q = buildQuestion(kana(target), {
            kind,
            script: 'hiragana',
            optionCount: 5,
            random: seeded(seed),
            pool: taught,
          });
          expect(
            q.options.map((o) => o.kanaId),
            `${kind} ${target} seed${String(seed)}`,
          ).not.toContain(twin);
          expect(q.correctIds).toEqual([target]);
        }
      }
    }
  });

  // 上の状況で誤答候補が本当に他行まで届いていることを固定する。
  // ここが崩れると、同音の除外を消しても気づけない試験になる。
  it('really does reach other rows for distractors in that scenario', () => {
    const taught = KANA.filter(
      (k) =>
        ['あ', 'か', 'さ', 'ざ'].includes(k.row) || ['da', 'di'].includes(k.id),
    );
    const seen = new Set<string>();
    for (let seed = 1; seed <= 30; seed += 1) {
      for (const o of buildQuestion(kana('di'), {
        kind: 'ROMAJI_TO_GLYPH',
        script: 'hiragana',
        optionCount: 5,
        random: seeded(seed),
        pool: taught,
      }).options) {
        seen.add(o.kanaId);
      }
    }
    // ざ行 から誤答が来ている＝じ も届く範囲にいた、ということ
    expect([...seen].some((id) => ['za', 'ze', 'zo'].includes(id))).toBe(true);
  });

  // を と お は綴りが違うので文字問題では並べてよいが、音では区別できない。
  it('separates homophones only where they are actually ambiguous', () => {
    const audioOptions = new Set<string>();
    const textOptions = new Set<string>();
    for (let seed = 1; seed <= 40; seed += 1) {
      for (const o of buildQuestion(kana('wo'), {
        kind: 'AUDIO_TO_GLYPH',
        script: 'hiragana',
        optionCount: 5,
        random: seeded(seed),
      }).options) {
        audioOptions.add(o.kanaId);
      }
      for (const o of buildQuestion(kana('wo'), {
        kind: 'ROMAJI_TO_GLYPH',
        script: 'hiragana',
        optionCount: 5,
        random: seeded(seed),
      }).options) {
        textOptions.add(o.kanaId);
      }
    }
    expect(audioOptions.has('o')).toBe(false);
    expect(textOptions.has('o')).toBe(true);
  });

  it('draws distractors only from the taught pool', () => {
    const taught = KANA.filter((k) =>
      ['a', 'i', 'u', 'e', 'o', 'ka', 'ki'].includes(k.id),
    );
    for (let seed = 1; seed <= 20; seed += 1) {
      const q = buildQuestion(kana('a'), {
        kind: 'GLYPH_TO_ROMAJI',
        script: 'hiragana',
        optionCount: 4,
        random: seeded(seed),
        pool: taught,
      });
      for (const option of q.options) {
        expect(taught.map((k) => k.id)).toContain(option.kanaId);
      }
    }
  });

  it('degrades gracefully when the pool is smaller than optionCount', () => {
    const taught = KANA.filter((k) => ['a', 'i'].includes(k.id));
    const q = buildQuestion(kana('a'), {
      kind: 'GLYPH_TO_ROMAJI',
      script: 'hiragana',
      optionCount: 4,
      random: seeded(5),
      pool: taught,
    });
    expect(q.options).toHaveLength(2);
    expect(q.correctIds).toEqual(['a']);
  });

  it('is deterministic for a given seed', () => {
    const build = (): string[] =>
      buildQuestion(kana('mo'), {
        kind: 'GLYPH_TO_ROMAJI',
        script: 'hiragana',
        optionCount: 4,
        random: seeded(99),
      }).options.map((o) => o.kanaId);
    expect(build()).toEqual(build());
  });

  it('does not always put the answer in the same slot', () => {
    const positions = new Set<number>();
    for (let seed = 1; seed <= 30; seed += 1) {
      const q = buildQuestion(kana('ka'), {
        kind: 'GLYPH_TO_ROMAJI',
        script: 'hiragana',
        optionCount: 4,
        random: seeded(seed),
      });
      positions.add(q.options.findIndex((o) => o.kanaId === 'ka'));
    }
    expect(positions.size).toBeGreaterThan(1);
  });
});

describe('answer checking', () => {
  it('accepts the target option and rejects the rest', () => {
    const q = buildQuestion(kana('ka'), {
      kind: 'GLYPH_TO_ROMAJI',
      script: 'hiragana',
      optionCount: 4,
      random: seeded(11),
    });
    expect(isCorrectChoice(q, 'ka')).toBe(true);
    for (const option of q.options) {
      if (option.kanaId === 'ka') continue;
      expect(isCorrectChoice(q, option.kanaId)).toBe(false);
    }
  });

  it('accepts hepburn and kunrei spellings', () => {
    expect(isCorrectRomaji('si', 'shi')).toBe(true);
    expect(isCorrectRomaji('si', 'si')).toBe(true);
    expect(isCorrectRomaji('tu', 'tsu')).toBe(true);
    expect(isCorrectRomaji('tu', 'tu')).toBe(true);
    expect(isCorrectRomaji('sya', 'sha')).toBe(true);
  });

  it('is forgiving about case and whitespace, strict about the reading', () => {
    expect(isCorrectRomaji('ka', ' KA ')).toBe(true);
    expect(isCorrectRomaji('ka', 'ga')).toBe(false);
    expect(isCorrectRomaji('ka', '')).toBe(false);
  });

  // 「ji」と打った人を不正解にはできない——ローマ字では本当に同じ。
  it('accepts a genuinely ambiguous romaji for either kana', () => {
    expect(isCorrectRomaji('zi', 'ji')).toBe(true);
    expect(isCorrectRomaji('di', 'ji')).toBe(true);
    expect(isCorrectRomaji('zu', 'zu')).toBe(true);
    expect(isCorrectRomaji('du', 'zu')).toBe(true);
    // 訓令式で区別して打った場合も通す
    expect(isCorrectRomaji('di', 'di')).toBe(true);
  });

  it('rejects an unknown kana id', () => {
    expect(isCorrectRomaji('nope', 'a')).toBe(false);
  });
});
