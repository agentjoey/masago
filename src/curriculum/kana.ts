/**
 * 五十音の静的データ（S0）。
 *
 * 設計上の要点：
 * - `id` は訓令式ベースの ASCII 一意識別子、`romaji` は学習者に見せるヘボン式。
 *   じ/ぢ と ず/づ はヘボン式では同じ ji / zu になるため、ローマ字を鍵にすると
 *   衝突する。知識項目の鍵は一意でなければ §3.3 の集計が壊れる。
 * - 教える順序は五十音順（行単位）。清音 → 濁音 → 半濁音 → 拗音。
 * - このデータは LLM に生成させない（§1.5「データ優先」）。仮名の読みは
 *   権威ある事実であり、幻覚の混入を許す理由がない。
 */

export type KanaGroup = 'seion' | 'dakuon' | 'handakuon' | 'youon';
export type KanaScript = 'hiragana' | 'katakana';

export interface Kana {
  /** knowledge_items.key に入る安定鍵。訓令式ベースで一意。 */
  readonly id: string;
  readonly hiragana: string;
  readonly katakana: string;
  /** 学習者に提示する読み（ヘボン式）。 */
  readonly romaji: string;
  /** 行。あ行・か行… 拗音は基になる行を持つ。 */
  readonly row: string;
  readonly group: KanaGroup;
}

function make(
  group: KanaGroup,
  row: string,
  entries: readonly (readonly [id: string, hira: string, kata: string, romaji: string])[],
): Kana[] {
  return entries.map(([id, hiragana, katakana, romaji]) => ({
    id,
    hiragana,
    katakana,
    romaji,
    row,
    group,
  }));
}

const SEION: readonly Kana[] = [
  ...make('seion', 'あ', [
    ['a', 'あ', 'ア', 'a'],
    ['i', 'い', 'イ', 'i'],
    ['u', 'う', 'ウ', 'u'],
    ['e', 'え', 'エ', 'e'],
    ['o', 'お', 'オ', 'o'],
  ]),
  ...make('seion', 'か', [
    ['ka', 'か', 'カ', 'ka'],
    ['ki', 'き', 'キ', 'ki'],
    ['ku', 'く', 'ク', 'ku'],
    ['ke', 'け', 'ケ', 'ke'],
    ['ko', 'こ', 'コ', 'ko'],
  ]),
  ...make('seion', 'さ', [
    ['sa', 'さ', 'サ', 'sa'],
    ['si', 'し', 'シ', 'shi'],
    ['su', 'す', 'ス', 'su'],
    ['se', 'せ', 'セ', 'se'],
    ['so', 'そ', 'ソ', 'so'],
  ]),
  ...make('seion', 'た', [
    ['ta', 'た', 'タ', 'ta'],
    ['ti', 'ち', 'チ', 'chi'],
    ['tu', 'つ', 'ツ', 'tsu'],
    ['te', 'て', 'テ', 'te'],
    ['to', 'と', 'ト', 'to'],
  ]),
  ...make('seion', 'な', [
    ['na', 'な', 'ナ', 'na'],
    ['ni', 'に', 'ニ', 'ni'],
    ['nu', 'ぬ', 'ヌ', 'nu'],
    ['ne', 'ね', 'ネ', 'ne'],
    ['no', 'の', 'ノ', 'no'],
  ]),
  ...make('seion', 'は', [
    ['ha', 'は', 'ハ', 'ha'],
    ['hi', 'ひ', 'ヒ', 'hi'],
    ['hu', 'ふ', 'フ', 'fu'],
    ['he', 'へ', 'ヘ', 'he'],
    ['ho', 'ほ', 'ホ', 'ho'],
  ]),
  ...make('seion', 'ま', [
    ['ma', 'ま', 'マ', 'ma'],
    ['mi', 'み', 'ミ', 'mi'],
    ['mu', 'む', 'ム', 'mu'],
    ['me', 'め', 'メ', 'me'],
    ['mo', 'も', 'モ', 'mo'],
  ]),
  ...make('seion', 'や', [
    ['ya', 'や', 'ヤ', 'ya'],
    ['yu', 'ゆ', 'ユ', 'yu'],
    ['yo', 'よ', 'ヨ', 'yo'],
  ]),
  ...make('seion', 'ら', [
    ['ra', 'ら', 'ラ', 'ra'],
    ['ri', 'り', 'リ', 'ri'],
    ['ru', 'る', 'ル', 'ru'],
    ['re', 'れ', 'レ', 're'],
    ['ro', 'ろ', 'ロ', 'ro'],
  ]),
  ...make('seion', 'わ', [
    ['wa', 'わ', 'ワ', 'wa'],
    // を は助詞専用。発音は「お」と同じだが字は別物として教える。
    ['wo', 'を', 'ヲ', 'wo'],
  ]),
  ...make('seion', 'ん', [['n', 'ん', 'ン', 'n']]),
];

const DAKUON: readonly Kana[] = [
  ...make('dakuon', 'が', [
    ['ga', 'が', 'ガ', 'ga'],
    ['gi', 'ぎ', 'ギ', 'gi'],
    ['gu', 'ぐ', 'グ', 'gu'],
    ['ge', 'げ', 'ゲ', 'ge'],
    ['go', 'ご', 'ゴ', 'go'],
  ]),
  ...make('dakuon', 'ざ', [
    ['za', 'ざ', 'ザ', 'za'],
    ['zi', 'じ', 'ジ', 'ji'],
    ['zu', 'ず', 'ズ', 'zu'],
    ['ze', 'ぜ', 'ゼ', 'ze'],
    ['zo', 'ぞ', 'ゾ', 'zo'],
  ]),
  ...make('dakuon', 'だ', [
    ['da', 'だ', 'ダ', 'da'],
    // ぢ・づ はヘボン式で じ・ず と同表記。id で区別する。
    ['di', 'ぢ', 'ヂ', 'ji'],
    ['du', 'づ', 'ヅ', 'zu'],
    ['de', 'で', 'デ', 'de'],
    ['do', 'ど', 'ド', 'do'],
  ]),
  ...make('dakuon', 'ば', [
    ['ba', 'ば', 'バ', 'ba'],
    ['bi', 'び', 'ビ', 'bi'],
    ['bu', 'ぶ', 'ブ', 'bu'],
    ['be', 'べ', 'ベ', 'be'],
    ['bo', 'ぼ', 'ボ', 'bo'],
  ]),
];

const HANDAKUON: readonly Kana[] = make('handakuon', 'ぱ', [
  ['pa', 'ぱ', 'パ', 'pa'],
  ['pi', 'ぴ', 'ピ', 'pi'],
  ['pu', 'ぷ', 'プ', 'pu'],
  ['pe', 'ぺ', 'ペ', 'pe'],
  ['po', 'ぽ', 'ポ', 'po'],
]);

const YOUON: readonly Kana[] = [
  ...make('youon', 'き', [
    ['kya', 'きゃ', 'キャ', 'kya'],
    ['kyu', 'きゅ', 'キュ', 'kyu'],
    ['kyo', 'きょ', 'キョ', 'kyo'],
  ]),
  ...make('youon', 'し', [
    ['sya', 'しゃ', 'シャ', 'sha'],
    ['syu', 'しゅ', 'シュ', 'shu'],
    ['syo', 'しょ', 'ショ', 'sho'],
  ]),
  ...make('youon', 'ち', [
    ['tya', 'ちゃ', 'チャ', 'cha'],
    ['tyu', 'ちゅ', 'チュ', 'chu'],
    ['tyo', 'ちょ', 'チョ', 'cho'],
  ]),
  ...make('youon', 'に', [
    ['nya', 'にゃ', 'ニャ', 'nya'],
    ['nyu', 'にゅ', 'ニュ', 'nyu'],
    ['nyo', 'にょ', 'ニョ', 'nyo'],
  ]),
  ...make('youon', 'ひ', [
    ['hya', 'ひゃ', 'ヒャ', 'hya'],
    ['hyu', 'ひゅ', 'ヒュ', 'hyu'],
    ['hyo', 'ひょ', 'ヒョ', 'hyo'],
  ]),
  ...make('youon', 'み', [
    ['mya', 'みゃ', 'ミャ', 'mya'],
    ['myu', 'みゅ', 'ミュ', 'myu'],
    ['myo', 'みょ', 'ミョ', 'myo'],
  ]),
  ...make('youon', 'り', [
    ['rya', 'りゃ', 'リャ', 'rya'],
    ['ryu', 'りゅ', 'リュ', 'ryu'],
    ['ryo', 'りょ', 'リョ', 'ryo'],
  ]),
  ...make('youon', 'ぎ', [
    ['gya', 'ぎゃ', 'ギャ', 'gya'],
    ['gyu', 'ぎゅ', 'ギュ', 'gyu'],
    ['gyo', 'ぎょ', 'ギョ', 'gyo'],
  ]),
  ...make('youon', 'じ', [
    ['zya', 'じゃ', 'ジャ', 'ja'],
    ['zyu', 'じゅ', 'ジュ', 'ju'],
    ['zyo', 'じょ', 'ジョ', 'jo'],
  ]),
  ...make('youon', 'び', [
    ['bya', 'びゃ', 'ビャ', 'bya'],
    ['byu', 'びゅ', 'ビュ', 'byu'],
    ['byo', 'びょ', 'ビョ', 'byo'],
  ]),
  ...make('youon', 'ぴ', [
    ['pya', 'ぴゃ', 'ピャ', 'pya'],
    ['pyu', 'ぴゅ', 'ピュ', 'pyu'],
    ['pyo', 'ぴょ', 'ピョ', 'pyo'],
  ]),
];

/** 教える順序どおりに並んだ全仮名。 */
export const KANA: readonly Kana[] = [
  ...SEION,
  ...DAKUON,
  ...HANDAKUON,
  ...YOUON,
];

export const KANA_BY_ID: ReadonlyMap<string, Kana> = new Map(
  KANA.map((kana) => [kana.id, kana]),
);

/** knowledge_items.key に使う形。型が KANA なので接頭辞で衝突は避けられる。 */
export function kanaKey(id: string): string {
  return `kana_${id}`;
}

export function kanaOfKey(key: string): Kana | undefined {
  return key.startsWith('kana_')
    ? KANA_BY_ID.get(key.slice('kana_'.length))
    : undefined;
}

export function kanaGlyph(kana: Kana, script: KanaScript): string {
  return script === 'hiragana' ? kana.hiragana : kana.katakana;
}

/**
 * 字形が紛らわしい組。零基礎の最大の詰まりどころであり、
 * ランダム出題で偶然当たるのを待つのでは足りない（V2 §2.2）。
 * 混同は字体ごとに起きるため、スクリプトを分けて持つ。
 */
export interface ConfusableSet {
  readonly script: KanaScript;
  /** 仮名 id の組。 */
  readonly ids: readonly string[];
  /** なぜ紛らわしいか。出題時のヒントにも使う。 */
  readonly note: string;
}

export const CONFUSABLES: readonly ConfusableSet[] = [
  { script: 'katakana', ids: ['si', 'tu'], note: 'シとツ。点の向きと払いの角度だけが違う' },
  { script: 'katakana', ids: ['so', 'n'], note: 'ソとン。点の向きと払いの角度だけが違う' },
  { script: 'katakana', ids: ['ku', 'wa'], note: 'クとワ。左上の角の有無' },
  { script: 'katakana', ids: ['su', 'nu'], note: 'スとヌ。交差の有無' },
  { script: 'katakana', ids: ['na', 'me'], note: 'ナとメ。払いの方向' },
  { script: 'katakana', ids: ['ma', 'mu'], note: 'マとム。上部の形' },
  { script: 'katakana', ids: ['ti', 'te'], note: 'チとテ。中央の縦画の有無' },
  { script: 'katakana', ids: ['wo', 'hu'], note: 'ヲとフ。横画の本数' },
  { script: 'katakana', ids: ['ro', 'ko'], note: 'ロとコ。下辺の閉じ' },
  { script: 'hiragana', ids: ['ne', 'wa', 're'], note: 'ね・わ・れ。右側の結びの違い' },
  { script: 'hiragana', ids: ['ru', 'ro'], note: 'るとろ。末尾の結びの有無' },
  { script: 'hiragana', ids: ['a', 'o'], note: 'あとお。左の払いと結び' },
  { script: 'hiragana', ids: ['ki', 'sa'], note: 'きとさ。横画の本数' },
  { script: 'hiragana', ids: ['ha', 'ho'], note: 'はとほ。横画の本数' },
  { script: 'hiragana', ids: ['nu', 'me'], note: 'ぬとめ。末尾の結びの有無' },
  { script: 'hiragana', ids: ['i', 'ri'], note: 'いとり。二画目の向き' },
  { script: 'hiragana', ids: ['ti', 'sa'], note: 'ちとさ。左右の向き' },
];

/** 音は同じだが字が違う組。読みだけで教えると必ず混乱する。 */
export const HOMOPHONE_PAIRS: readonly (readonly [string, string])[] = [
  ['zi', 'di'], // じ / ぢ — どちらも ji
  ['zu', 'du'], // ず / づ — どちらも zu
  ['o', 'wo'], // お / を — を は助詞専用
];
