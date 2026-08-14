import { describe, expect, it, vi } from 'vitest';
import {
  gradeComposition,
  nextCompositionQuestion,
  spontaneousWords,
  type JudgeDeps,
} from '../../src/learning/compositionSession.js';
import { TRANSLATED } from '../../src/curriculum/sentences.js';
import type { GrammarIssue, Token } from '../../src/nlp/index.js';

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

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

const NO_ISSUES = (): readonly GrammarIssue[] => [];
const analyzeNothing = (): Promise<readonly Token[]> => Promise.resolve([]);

function deps(overrides: Partial<JudgeDeps> = {}): JudgeDeps {
  return {
    analyze: analyzeNothing,
    detectIssues: NO_ISSUES,
    ...overrides,
  };
}

describe('出題', () => {
  it('asks in Chinese and keeps a human-written reference', () => {
    const question = nextCompositionQuestion({ random: seeded(4) });
    expect(question).toBeDefined();
    expect(question?.meaning).not.toBe('');
    expect(question?.reference).not.toBe('');
    // 出題は必ず訳のある文から
    const source = TRANSLATED.find((s) => s.id === question?.sentenceId);
    expect(source?.zh).toBe(question?.meaning);
  });

  /**
   * 読解と違い、作文は未習の語が一つでもあると手が止まる。
   * 推測で読むことはできても、知らない語は書けない。
   */
  it('only asks for sentences the learner can actually write', () => {
    const known = new Set<string>();
    for (const sentence of TRANSLATED.slice(0, 60)) {
      for (const t of sentence.tokens) known.add(t.s);
    }
    const FUNCTION_POS = new Set(['助詞', '助動詞', '記号', 'フィラー', '感動詞']);
    let checked = 0;
    for (let seed = 1; seed <= 25; seed += 1) {
      const question = nextCompositionQuestion({ random: seeded(seed), known });
      if (question === undefined) continue;
      const sentence = TRANSLATED.find((s) => s.id === question.sentenceId);
      if (sentence === undefined) continue;
      checked += 1;
      const unknown = sentence.tokens.filter(
        (t) => !FUNCTION_POS.has(t.p) && !known.has(t.s) && !known.has(t.r ?? ''),
      );
      expect(unknown, sentence.text).toEqual([]);
    }
    expect(checked).toBeGreaterThan(15);
  });

  it('can be limited to a scene', () => {
    const question = nextCompositionQuestion({
      random: seeded(9),
      sceneId: 'meal',
    });
    expect(question).toBeDefined();
  });
});

describe('三段の採点', () => {
  const first = TRANSLATED[0];
  if (first === undefined) throw new Error('no translated sentences');

  it('matches the reference without calling the model', async () => {
    const judge = vi.fn();
    const result = await gradeComposition(
      first.id,
      first.text,
      deps({ judge }),
    );
    expect(result?.correct).toBe(true);
    expect(result?.source).toBe('EXACT');
    expect(judge).not.toHaveBeenCalled();
  });

  it('ignores spacing and punctuation when matching', async () => {
    const judge = vi.fn();
    const result = await gradeComposition(
      first.id,
      ` ${first.text.replace(/[。？]/gu, '')} `,
      deps({ judge }),
    );
    expect(result?.source).toBe('EXACT');
    expect(judge).not.toHaveBeenCalled();
  });

  /**
   * 規則で決まる誤りは模型に回さない。同じ入力に同じ答えが返るほうが
   * 教材として確かで、費用もかからない（§1.5）。
   */
  it('stops at the rule layer and never calls the model', async () => {
    const judge = vi.fn();
    const issue: GrammarIssue = {
      kind: 'WO_WITH_EXISTENCE',
      original: '犬を',
      recommended: '犬が',
      explanation: '表示存在的 ある/いる 用 が，不用 を。',
      knowledgeKey: 'particle_wo_ga',
    };
    const result = await gradeComposition(
      first.id,
      '犬を三匹います。',
      deps({ detectIssues: () => [issue], judge }),
    );
    expect(result?.correct).toBe(false);
    expect(result?.source).toBe('RULE');
    expect(result?.note).toContain('ある/いる');
    expect(judge).not.toHaveBeenCalled();
  });

  it('asks the model only when the rules cannot decide', async () => {
    const judge = vi.fn().mockResolvedValue({ ok: true, note: '更自然的说法是……' });
    const result = await gradeComposition(
      first.id,
      'ぜんぜん違う文です。',
      deps({ judge }),
    );
    expect(judge).toHaveBeenCalledOnce();
    expect(result?.correct).toBe(true);
    expect(result?.source).toBe('MODEL');
    expect(result?.note).toBe('更自然的说法是……');
  });

  /**
   * どの段でも手本を返す。判定を外しても、学習者の目には
   * 正しい日本語が残るようにしておく。
   */
  it('always hands back the reference sentence', async () => {
    const cases: JudgeDeps[] = [
      deps(),
      deps({
        detectIssues: () => [
          {
            kind: 'DOUBLE_PARTICLE',
            original: 'はが',
            recommended: undefined,
            explanation: '助词连用',
            knowledgeKey: 'k',
          },
        ],
      }),
      deps({ judge: vi.fn().mockResolvedValue({ ok: false, note: 'x' }) }),
      deps({ judge: vi.fn().mockResolvedValue(undefined) }),
    ];
    for (const dep of cases) {
      const result = await gradeComposition(first.id, 'まったく別の文', dep);
      expect(result?.reference).toBe(first.text);
    }
  });

  it('does not call a sentence wrong when the model failed to answer', async () => {
    const result = await gradeComposition(
      first.id,
      'なにか別の文',
      deps({ judge: vi.fn().mockResolvedValue(undefined) }),
    );
    expect(result?.source).toBe('UNJUDGED');
    // 判定できなかっただけなので、理由を作らない
    expect(result?.note).toBe('');
  });

  it('keeps grading when the analyzer throws', async () => {
    const judge = vi.fn().mockResolvedValue({ ok: true, note: '' });
    const result = await gradeComposition(
      first.id,
      'べつの文',
      deps({
        analyze: () => Promise.reject(new Error('dictionary unavailable')),
        judge,
      }),
    );
    expect(result?.source).toBe('MODEL');
  });

  it('returns undefined for a sentence it does not know', async () => {
    expect(await gradeComposition('nope', 'x', deps())).toBeUndefined();
  });
});

describe('spontaneousWords', () => {
  it('reports the known content words the learner used', () => {
    const known = new Set(['本', '読む']);
    const tokens = [
      token('私'),
      token('は', '助詞'),
      token('本'),
      token('を', '助詞'),
      token('読み', '動詞', '読む'),
      token('ます', '助動詞'),
    ];
    expect(new Set(spontaneousWords(tokens, known))).toEqual(
      new Set(['本', '読む']),
    );
  });

  it('reports nothing when none of the words are known yet', () => {
    expect(spontaneousWords([token('本')], new Set())).toEqual([]);
  });
});
