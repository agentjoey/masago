import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Token } from '../../src/nlp/analyzer.js';
import { detectGrammarIssues } from '../../src/nlp/grammar.js';

/**
 * 実際の kuromoji が返した解析結果を録って使う。
 *
 * 辞書は 400MB あるので、規則の試験のたびに読み込むのは重すぎる。
 * とはいえ品詞や活用形を手で書くと、実物とずれた前提で緑になる——
 * それでは何も守れない。実物の出力をそのまま固定して回す。
 *
 * 録り直しは analyzer 経由で（scripts の生成手順は commit を参照）。
 */
const FIXTURES = JSON.parse(
  readFileSync(new URL('./tokens.fixture.json', import.meta.url), 'utf8'),
) as Record<string, Token[]>;

function tokensOf(sentence: string): Token[] {
  const found = FIXTURES[sentence];
  if (found === undefined) {
    throw new Error(`no recorded tokens for: ${sentence}`);
  }
  return found;
}

function kinds(sentence: string): string[] {
  return detectGrammarIssues(tokensOf(sentence)).map((issue) => issue.kind);
}

describe('を + 存在動詞', () => {
  it('flags を with あります / います', () => {
    expect(kinds('犬を三匹あります')).toContain('WO_WITH_EXISTENCE');
    expect(kinds('公園に猫をいます')).toContain('WO_WITH_EXISTENCE');
  });

  it('suggests が, because the rule fixes it uniquely', () => {
    const [issue] = detectGrammarIssues(tokensOf('犬を三匹あります'));
    expect(issue?.original).toBe('を');
    expect(issue?.recommended).toBe('が');
  });

  it('leaves を with an ordinary transitive verb alone', () => {
    expect(kinds('本を読みます')).toEqual([]);
  });

  // 「用事があります」は が なので当然無罪。を を使っていないものを
  // 存在動詞だけで拾わないことの確認。
  it('does not fire on existence verbs used correctly', () => {
    expect(kinds('用事があります')).toEqual([]);
    expect(kinds('時間がありません')).toEqual([]);
  });
});

describe('終止形 + ます', () => {
  it('flags 見るました', () => {
    expect(kinds('昨日、友達と映画を見るました')).toContain(
      'PLAIN_FORM_BEFORE_MASU',
    );
  });

  it('leaves the correct 見ました alone', () => {
    expect(kinds('昨日、友達と映画を見ました')).toEqual([]);
  });
});

describe('イ形容詞 + じゃない', () => {
  it('flags おいしいじゃない and gives the fixed form', () => {
    const issues = detectGrammarIssues(
      tokensOf('このりんごはおいしいじゃないです'),
    );
    const issue = issues.find((i) => i.kind === 'I_ADJECTIVE_JANAI');
    expect(issue).toBeDefined();
    expect(issue?.recommended).toBe('おいしくない');
  });

  it('leaves おいしくない alone', () => {
    expect(kinds('このりんごはおいしくないです')).toEqual([]);
  });

  // ナ形容詞は じゃない でよい。品詞を見ずに文字だけで判定すると誤検出する。
  it('does not touch na-adjectives, which take じゃない correctly', () => {
    expect(kinds('この部屋はしずかじゃないです')).toEqual([]);
  });
});

describe('助詞の重なり', () => {
  it('flags a binding particle followed by a case particle', () => {
    expect(kinds('私はが学生です')).toContain('DOUBLE_PARTICLE');
  });

  it('flags two case particles in a row', () => {
    expect(kinds('本をに置きます')).toContain('DOUBLE_PARTICLE');
  });

  // ここが本当の分かれ目。「誰もが」は正しい日本語で、
  // も[係助詞]+が[格助詞] という **誤りと同じ並び** になる。
  // 係助詞をまとめて禁じると、正しい文を書いた学習者に間違いだと言うことになる。
  it('never flags 誰もが, which is correct Japanese', () => {
    expect(kinds('誰もが知っている')).toEqual([]);
  });

  it('never flags 副助詞 + 格助詞', () => {
    expect(kinds('私だけが行きます')).toEqual([]);
    expect(kinds('本までが高い')).toEqual([]);
  });

  it('never flags 格助詞 + 係助詞 (には)', () => {
    expect(kinds('部屋には猫がいます')).toEqual([]);
  });

  it('never flags から…まで', () => {
    expect(kinds('駅から学校まで歩きます')).toEqual([]);
  });
});

describe('全体として', () => {
  // 見逃しより誤検出のほうが害が大きい。正しい文で一つも鳴らないことが
  // この層の存在条件。
  it('is silent on every correct sentence in the fixtures', () => {
    const correct = [
      '本を読みます',
      '昨日、友達と映画を見ました',
      'このりんごはおいしくないです',
      'この部屋はしずかじゃないです',
      '誰もが知っている',
      '私だけが行きます',
      '本までが高い',
      '部屋には猫がいます',
      '駅から学校まで歩きます',
      '毎朝七時に学校で勉強します',
      '用事があります',
      '時間がありません',
    ];
    for (const sentence of correct) {
      expect(kinds(sentence), sentence).toEqual([]);
    }
  });

  it('gives every issue a knowledge key and a chinese explanation', () => {
    for (const sentence of Object.keys(FIXTURES)) {
      for (const issue of detectGrammarIssues(tokensOf(sentence))) {
        expect(issue.knowledgeKey, sentence).toMatch(/^[a-z_]+$/);
        expect(issue.explanation, sentence).toMatch(/[一-鿿]/);
      }
    }
  });

  it('handles an empty analysis', () => {
    expect(detectGrammarIssues([])).toEqual([]);
  });
});
