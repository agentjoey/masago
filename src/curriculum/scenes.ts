/**
 * 場面（docs/scenario-learning.md §3）。
 *
 * 場面は新しいデータ型ではなく、**既にある語彙への見方**——語を選び直す
 * のではなく、まとめ方を一つ足すだけ。例文も既存のプールから、場面の語を
 * 含むものを拾う。新しく書き起こす材料は一つも無い。
 *
 * ## Genki の課をそのまま場面にしなかった理由
 *
 * 当初の見立て（§3「場面分けのデータはもう庫にある」）は**実測で外れた**：
 *
 * - Genki の課が付いているのは 1374 語のうち 515 語だけ
 * - 「その課の語を 2 つ以上含む文」で拾うと、第 12 課だけが 524 文を
 *   占め、第 6・15・16・19・20・23 課は 0 文になる。第 12 課に
 *   いつも・意味・痛い といった場面を選ばない語が入っているためで、
 *   拾えた文が第 12 課の場面を表しているわけではない
 *
 * 課は文法の順に組まれていて、場面の単位ではない。そこで**語の集合を
 * 場面ごとに手で束ねる**。束ね方は手書きだが、束ねている語は一つ残らず
 * 既存の語彙表にあるもので、`tests/curriculum/scenes.test.ts` が
 * 存在を検査する。無い語を書けば落ちる。
 *
 * ## ここに無い場面
 *
 * 商談・体育・芸術は入れていない。語彙が N2–N1 で、いまの学習者からは
 * 二年ほど先にある（§3）。作っても使えないうえ、本当の隘路（文の質）から
 * 手が離れる。
 */
import { VOCAB, VOCAB_BY_ID, type VocabEntry } from './vocab.js';
import { SENTENCES, type Sentence } from './sentences.js';

export interface Scene {
  readonly id: string;
  /** 中文の名前。学習者が選ぶときに見る。 */
  readonly name: string;
  /**
   * この場面の語（表記）。
   *
   * 語彙表の表記をそのまま書く。接尾辞は `～円` のように波ダッシュ付きで
   * 載っているので、照合の前に落とす（`matchFormsOf`）。
   */
  readonly words: readonly string[];
}

export const SCENES: readonly Scene[] = [
  {
    id: 'meal',
    name: '吃饭',
    words: [
      '食べる', '飲む', '食べ物', '飲み物', '御飯', '朝御飯', '昼御飯', '晩御飯',
      'お茶', '水', '肉', '魚', '野菜', '果物', 'パン', '卵', '牛乳', 'コーヒー',
      'レストラン', '料理', '美味しい', 'まずい', '甘い', '辛い', 'お腹', '店',
    ],
  },
  {
    id: 'shopping',
    name: '买东西',
    words: [
      '買う', '売る', '店', 'お金', '高い', '安い', 'いくら', '～円', '払う',
      '欲しい', '服', '靴', '本', '新しい', '古い', '買い物',
    ],
  },
  {
    id: 'travel',
    name: '出行',
    words: [
      '行く', '来る', '帰る', '駅', '電車', 'バス', '車', '自転車', '飛行機',
      '乗る', '降りる', '道', '切符', '歩く', '近い', '遠い', '早い', '遅い',
      '旅行',
    ],
  },
  {
    id: 'family',
    name: '家人',
    words: [
      '父', '母', '兄', '姉', '弟', '妹', '家族', '子供', '息子', '娘',
      'おじいさん', 'おばあさん', '奥さん', '友達', '人',
    ],
  },
  {
    id: 'school',
    name: '学校',
    words: [
      '学校', '学生', '先生', '勉強', '習う', '教える', '宿題', '試験', '教室',
      '大学', '本', '読む', '書く', '質問', '答える', '英語', '漢字',
    ],
  },
  {
    id: 'weather',
    name: '天气',
    words: [
      '天気', '雨', '雪', '風', '晴れる', '曇る', '曇り', '暑い', '寒い',
      '暖かい', '涼しい', '空',
    ],
  },
  {
    id: 'health',
    name: '身体与看病',
    words: [
      '痛い', '病気', '医者', '病院', '薬', '元気', '頭', 'お腹', '熱',
      '疲れる', '休む', '体',
    ],
  },
  {
    id: 'time',
    name: '时间',
    words: [
      '今', '今日', '明日', '昨日', '朝', '昼', '晩', '夜', '時間', '～分',
      '～時', '～週間', '～年', 'いつ', '早い', '遅い', '毎日',
    ],
  },
  {
    id: 'home',
    name: '家里',
    words: [
      '家', '部屋', '窓', 'ドア', '台所', 'お風呂', 'テーブル', '椅子', '机',
      'ベッド', '住む', '掃除', '庭',
    ],
  },
  {
    id: 'hobby',
    name: '爱好',
    words: [
      '音楽', '歌', '歌う', '映画', '絵', '写真', '撮る', '本', '読む',
      'スポーツ', '泳ぐ', '水泳', '走る', '遊ぶ',
    ],
  },
];

export const SCENE_BY_ID: ReadonlyMap<string, Scene> = new Map(
  SCENES.map((scene) => [scene.id, scene]),
);

/** 接尾辞の波ダッシュを落とす。文中には `円` としか現れない。 */
function stripAffix(expression: string): string {
  return expression.replace(/^～/, '').replace(/～$/, '');
}

/** 場面の語に当たる語彙表の項目。 */
export function sceneVocab(scene: Scene): VocabEntry[] {
  const wanted = new Set(scene.words);
  return VOCAB.filter((entry) => wanted.has(entry.expression));
}

/**
 * 文と突き合わせる表記の集合（表記と読みの両方）。
 *
 * 読みも入れるのは、同じ語が仮名で書かれることがあるため
 * （「たべる」と「食べる」）。
 */
export function matchFormsOf(scene: Scene): Set<string> {
  const forms = new Set<string>();
  for (const entry of sceneVocab(scene)) {
    forms.add(stripAffix(entry.expression));
    forms.add(stripAffix(entry.reading));
  }
  return forms;
}

/** 場面の語をいくつ含むか。 */
export function sceneHits(sentence: Sentence, forms: ReadonlySet<string>): number {
  const seen = new Set<string>();
  for (const token of sentence.tokens) {
    if (forms.has(token.s)) seen.add(token.s);
  }
  return seen.size;
}

const sentenceCache = new Map<string, readonly Sentence[]>();

/**
 * その場面の文。語を多く含む順に並べる。
 *
 * 一語しか当たらない文は「たまたま出てきた」ことが多いので後ろへ回す。
 * 完全に外すほどでもない——場面の文は多いほうがよく、二語以上を要求すると
 * 場面によっては一桁になる。
 */
export function sceneSentences(scene: Scene): readonly Sentence[] {
  const cached = sentenceCache.get(scene.id);
  if (cached !== undefined) return cached;

  const forms = matchFormsOf(scene);
  const scored = SENTENCES.map((sentence) => ({
    sentence,
    hits: sceneHits(sentence, forms),
  }))
    .filter((entry) => entry.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .map((entry) => entry.sentence);

  sentenceCache.set(scene.id, scored);
  return scored;
}

export interface SceneProgress {
  readonly scene: Scene;
  readonly learned: number;
  readonly total: number;
}

/** 場面ごとの進み具合。`introducedIds` は既に導入した語彙 id。 */
export function sceneProgress(
  introducedIds: ReadonlySet<string>,
): SceneProgress[] {
  return SCENES.map((scene) => {
    const words = sceneVocab(scene);
    return {
      scene,
      learned: words.filter((entry) => introducedIds.has(entry.id)).length,
      total: words.length,
    };
  });
}

/** 語彙 id からその語が属する場面を引く。複数に属することがある。 */
export function scenesOfVocab(vocabId: string): Scene[] {
  const entry = VOCAB_BY_ID.get(vocabId);
  if (entry === undefined) return [];
  return SCENES.filter((scene) => scene.words.includes(entry.expression));
}
