/**
 * 助詞——GRAMMAR 型の知識項（V2 §3.1 / docs/scenario-learning.md §5）。
 *
 * 語彙や仮名と違い、助詞には「一覧」の権威ある開放データが見つからない（§8 の
 * 積み残し）。そこで**採録する集合そのものを例文プールから決める**：
 * `sentences.ts` の中で実際に穴埋めとして問える箇所が十分にある助詞だけを
 * 載せる。数は `tests/curriculum/particles.test.ts` が下限を検査していて、
 * 材料の無い助詞を足すと落ちる。
 *
 * 中国語のラベルだけは手書きで、出典が無い。これは「模型に現場で作らせる」
 * のとは別物——committed で、人が読んで直せる。**例文は一切書き起こさない。**
 * 教材になる文は全部プール（Tatoeba, CC BY 2.0 FR）から採る。
 *
 * 並び順は例文プールでの出題可能数の降順。読めるようになるために先に要る順、
 * という意味で、根拠が数字で辿れる。教科書の課順を真似ると出典を示せない。
 */
import type { StoredToken } from './sentences.js';

export interface Particle {
  /** knowledge_items.key に入る識別子。 */
  readonly id: string;
  /** 表記。これが問題の答えになる。 */
  readonly surface: string;
  /**
   * 助詞としての読み。
   *
   * は→wa、へ→e、を→o と、表記どおりに読まない三つがある。ゼロ初級が
   * 最初につまずくのはここで、仮名を覚えた直後ほど「は」を ha と読む。
   */
  readonly reading: string;
  /** 中文の一行説明。手書き（出典無し）。 */
  readonly label: string;
  /** 例文プールで穴埋めとして問える箇所の数（実測。`tests/curriculum/particles.test.ts` が突き合わせる）。 */
  readonly blankable: number;
}

/**
 * 採録した助詞。
 *
 * ここに無い助詞——ね・よ・か などの終助詞——は、名詞に付かないので
 * 現行の穴埋めでは問えない。問えない項目を復習キューに積むと、期限が来ても
 * 出す問題が無いという状態になるので、載せない。
 */
export const PARTICLES: readonly Particle[] = [
  { id: 'wa', surface: 'は', reading: 'wa', label: '主题：说的是关于它的事', blankable: 1950 },
  { id: 'ga', surface: 'が', reading: 'ga', label: '主语：动作或状态的主体', blankable: 843 },
  { id: 'wo', surface: 'を', reading: 'o', label: '宾语：动作作用的对象', blankable: 846 },
  { id: 'ni', surface: 'に', reading: 'ni', label: '时间点、到达点、动作的对象', blankable: 792 },
  { id: 'no', surface: 'の', reading: 'no', label: '连接两个名词：的', blankable: 559 },
  { id: 'de', surface: 'で', reading: 'de', label: '动作发生的场所、使用的手段', blankable: 210 },
  { id: 'he', surface: 'へ', reading: 'e', label: '方向：朝着某处', blankable: 79 },
  { id: 'kara', surface: 'から', reading: 'kara', label: '起点：从……开始', blankable: 72 },
  { id: 'mo', surface: 'も', reading: 'mo', label: '也：和前面提到的一样', blankable: 55 },
  { id: 'yori', surface: 'より', reading: 'yori', label: '比较的基准：比……', blankable: 50 },
  { id: 'made', surface: 'まで', reading: 'made', label: '终点：到……为止', blankable: 50 },
  { id: 'to', surface: 'と', reading: 'to', label: '和：并列，或一起做的对象', blankable: 38 },
];

export const PARTICLE_BY_ID: ReadonlyMap<string, Particle> = new Map(
  PARTICLES.map((entry) => [entry.id, entry]),
);

export const PARTICLE_BY_SURFACE: ReadonlyMap<string, Particle> = new Map(
  PARTICLES.map((entry) => [entry.surface, entry]),
);

/** 出題・誤答の選択肢に使う表記の一覧。答えも誤答も同じ集合から採る。 */
export const PARTICLE_SURFACES: readonly string[] = PARTICLES.map(
  (entry) => entry.surface,
);

/** knowledge_items.key に入る形。型が GRAMMAR なので接頭辞で衝突しない。 */
export function particleKey(id: string): string {
  return `particle_${id}`;
}

export function particleOfKey(key: string): Particle | undefined {
  return key.startsWith('particle_')
    ? PARTICLE_BY_ID.get(key.slice('particle_'.length))
    : undefined;
}

/**
 * 助詞として採録済みの語かどうか。
 *
 * 細分類まで見る。同じ「と」でも格助詞（一緒にする相手）と接続助詞
 * （〜すると）は別物で、後者は名詞に付かないので穴埋めの対象にならない。
 */
const BLANKABLE_DETAILS = new Set([
  '格助詞',
  '副助詞',
  '連体化',
  // は・も は係助詞だが名詞に付いて役割を示す点は格助詞と同じで、
  // 初級では が/を との使い分けが最大の難所。含める。
  '係助詞',
]);

export function isBlankableParticle(token: StoredToken): boolean {
  if (token.p !== '助詞') return false;
  if (!BLANKABLE_DETAILS.has(token.d)) return false;
  if (token.d === '係助詞' && token.s !== 'は' && token.s !== 'も') return false;
  return PARTICLE_BY_SURFACE.has(token.s);
}
