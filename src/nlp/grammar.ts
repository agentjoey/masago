import type { Token } from './analyzer.js';

/**
 * 規則で確実に言える誤りだけを拾う（V2 §8）。
 *
 * LLM は「たぶん間違い」を大量に出せるが、根拠を再現できない。助詞の誤用や
 * 動詞の活用は規則が決まっているので、プログラムのほうが確かで安く、
 * 何より **同じ入力に同じ判定** を返す（§1.5「LLM はデータベースではない」）。
 *
 * **見逃しより誤検出のほうが害が大きい。** 正しい文を「間違い」と言われた
 * ゼロ初級者は、自分の正解を疑って直してしまう——直った先が誤りになる。
 * だから曖昧な規則は入れない。文脈次第で正しくなりうるものは全部見送る。
 * ここが拾えなかった分は従来どおり LLM 側が拾う。
 */

export type GrammarIssueKind =
  /** 存在の「ある/いる」に を を使っている（犬**を**います）。 */
  | 'WO_WITH_EXISTENCE'
  /** 終止形のまま ます を付けている（見る**ます**）。 */
  | 'PLAIN_FORM_BEFORE_MASU'
  /** イ形容詞に じゃない を付けている（おいし**いじゃない**）。 */
  | 'I_ADJECTIVE_JANAI'
  /** 格助詞が連続している（私**はが**）。 */
  | 'DOUBLE_PARTICLE';

export interface GrammarIssue {
  readonly kind: GrammarIssueKind;
  /** 誤りの部分。 */
  readonly original: string;
  /** 直した形。規則で一意に決まる場合だけ入れる。 */
  readonly recommended: string | undefined;
  /** 学習者に見せる説明（中国語）。 */
  readonly explanation: string;
  /** knowledge_items の鍵。LLM 側の検出と同じ空間に置く。 */
  readonly knowledgeKey: string;
}

const EXISTENCE_VERBS = new Set(['ある', 'いる', '居る', '有る', '在る']);
const CASE_PARTICLES = new Set(['が', 'を', 'に', 'へ', 'と', 'で', 'から', 'より']);

function isCaseParticle(token: Token): boolean {
  return token.pos === '助詞' && token.posDetail === '格助詞';
}

/**
 * 「を」＋存在動詞。
 *
 * 存在を表す ある/いる は対象を が で取る。「犬を三匹います」は必ず誤り
 * ——他動詞の ある（例：「用事がある」）でも を は取らない。
 * ただし「〜をしている」のような複合は動詞が違うので当たらない。
 */
function checkWoWithExistence(tokens: readonly Token[]): GrammarIssue[] {
  const issues: GrammarIssue[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const particle = tokens[i];
    if (particle === undefined || particle.surface !== 'を') continue;

    // を の後ろにある最初の動詞を見る。間に数詞や副詞が挟まってよい。
    for (let j = i + 1; j < tokens.length; j += 1) {
      const next = tokens[j];
      if (next === undefined) break;
      if (next.pos === '動詞') {
        if (EXISTENCE_VERBS.has(next.basicForm)) {
          issues.push({
            kind: 'WO_WITH_EXISTENCE',
            original: 'を',
            recommended: 'が',
            explanation:
              '表示存在的「ある/いる」用「が」标记主体，不用「を」。',
            knowledgeKey: 'particle_wo_ga_existence',
          });
        }
        break;
      }
      // 助詞や読点が来たら別の節。追わない。
      if (next.pos === '助詞' || next.pos === '記号') break;
    }
  }
  return issues;
}

/**
 * 終止形＋ます。
 *
 * 「見るます」「食べるます」。ます は連用形に付くので、終止形（基本形）の
 * 直後に来ることはない。kuromoji は活用形を返すので判定は一意。
 */
function checkPlainFormBeforeMasu(tokens: readonly Token[]): GrammarIssue[] {
  const issues: GrammarIssue[] = [];
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const verb = tokens[i];
    const aux = tokens[i + 1];
    if (verb === undefined || aux === undefined) continue;
    if (verb.pos !== '動詞') continue;
    if (verb.conjugatedForm !== '基本形') continue;
    if (aux.pos !== '助動詞') continue;
    if (!aux.surface.startsWith('ま')) continue;

    issues.push({
      kind: 'PLAIN_FORM_BEFORE_MASU',
      original: `${verb.surface}${aux.surface}`,
      recommended: undefined,
      explanation:
        '「ます」要接在动词的连用形后面，不能直接跟在辞书形之后。',
      knowledgeKey: 'verb_masu_stem',
    });
  }
  return issues;
}

/**
 * イ形容詞＋じゃない。
 *
 * 「おいしいじゃない」は「おいしくない」。ナ形容詞と名詞は じゃない でよいので、
 * 品詞が形容詞であることを確かめてから判定する。
 */
function checkIAdjectiveJanai(tokens: readonly Token[]): GrammarIssue[] {
  const issues: GrammarIssue[] = [];
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const adj = tokens[i];
    const next = tokens[i + 1];
    if (adj === undefined || next === undefined) continue;
    if (adj.pos !== '形容詞') continue;
    if (adj.conjugatedForm !== '基本形') continue;
    if (next.surface !== 'じゃ' && next.surface !== 'では') continue;

    const stem = adj.basicForm.slice(0, -1);
    issues.push({
      kind: 'I_ADJECTIVE_JANAI',
      original: `${adj.surface}${next.surface}ない`,
      recommended: `${stem}くない`,
      explanation:
        'イ形容词的否定是把「い」换成「くない」，不能用「じゃない」。',
      knowledgeKey: 'adjective_i_negation',
    });
  }
  return issues;
}

/**
 * 助詞の重なり。
 *
 * 拾うのは二通りだけ。どちらも文脈によらず誤りだと言い切れる形に絞る。
 *
 *   1. 格助詞＋格助詞（「本をに」）
 *   2. 「は」＋格助詞（「私はが」）
 *
 * **「係助詞＋格助詞」を一般に誤りとしてはいけない。** 「誰もが知っている」
 * は正しい日本語で、も[係助詞]＋が[格助詞] の並びになる。同様に
 * 「私だけが」「本までが」も副助詞＋格助詞で正しい。逆向きの
 * 「には」「では」（格助詞＋係助詞）も当然正しい。
 * ここを雑にやると、正しい文を書いた学習者に「間違い」と言うことになる。
 */
function checkDoubleParticle(tokens: readonly Token[]): GrammarIssue[] {
  const issues: GrammarIssue[] = [];
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if (a === undefined || b === undefined) continue;
    if (!isCaseParticle(b) || !CASE_PARTICLES.has(b.surface)) continue;

    const aIsCase = isCaseParticle(a) && CASE_PARTICLES.has(a.surface);
    // 「は」だけを特別扱いする。も・だけ・まで は正しく続きうる。
    const aIsWa = a.pos === '助詞' && a.posDetail === '係助詞' && a.surface === 'は';
    if (!aIsCase && !aIsWa) continue;

    // 「から」+「まで」のような範囲の組は正しい。
    if (a.surface === 'から' || b.surface === 'まで') continue;

    issues.push({
      kind: 'DOUBLE_PARTICLE',
      original: `${a.surface}${b.surface}`,
      recommended: undefined,
      explanation: '这两个助词不能连着用，这里只需要其中一个。',
      knowledgeKey: 'particle_double',
    });
  }
  return issues;
}

export function detectGrammarIssues(
  tokens: readonly Token[],
): GrammarIssue[] {
  return [
    ...checkWoWithExistence(tokens),
    ...checkPlainFormBeforeMasu(tokens),
    ...checkIAdjectiveJanai(tokens),
    ...checkDoubleParticle(tokens),
  ];
}
