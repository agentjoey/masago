/**
 * 五十音図の配置（V3 Mini App）。
 *
 * 表として見せるには、あ・い・う・え・お の列を揃える必要がある。
 * や行は や・ゆ・よ しか無く、わ行は わ・を しか無いので、
 * 単に順番に並べると列がずれて別の字の下に来る——学習者は表の位置で
 * 覚えるので、ずれた表はそれ自体が誤りになる。
 */
import { KANA, type Kana, type KanaGroup } from './kana.js';

export type Vowel = 'a' | 'i' | 'u' | 'e' | 'o';

const VOWELS: readonly Vowel[] = ['a', 'i', 'u', 'e', 'o'];

/**
 * その字が入る列。訓令式 id の末尾母音で決める——ヘボン式だと
 * shi/chi/tsu/fu が例外になり、判定が崩れる。
 */
export function vowelOf(kana: Kana): Vowel | undefined {
  const last = kana.id.at(-1);
  return VOWELS.find((vowel) => vowel === last);
}

export interface GojuonRow {
  /** 行の名前（あ・か・…）。 */
  readonly row: string;
  /** 列ごとの字。無い所は undefined（や行の い・え など）。 */
  readonly cells: readonly (Kana | undefined)[];
}

export interface GojuonSection {
  readonly group: KanaGroup;
  readonly title: string;
  /** 列見出し。清音は 5 列、拗音は 3 列。 */
  readonly columns: readonly Vowel[];
  readonly rows: readonly GojuonRow[];
}

const TITLES: Record<KanaGroup, string> = {
  seion: '清音',
  dakuon: '浊音',
  handakuon: '半浊音',
  youon: '拗音',
};

/** 拗音は や・ゆ・よ の三列しか無い。 */
const YOUON_COLUMNS: readonly Vowel[] = ['a', 'u', 'o'];

function buildSection(group: KanaGroup): GojuonSection {
  const columns = group === 'youon' ? YOUON_COLUMNS : VOWELS;
  const rows: GojuonRow[] = [];

  for (const kana of KANA) {
    if (kana.group !== group) continue;
    let row = rows.find((entry) => entry.row === kana.row);
    if (row === undefined) {
      row = { row: kana.row, cells: Array.from(columns, () => undefined) };
      rows.push(row);
    }
    const vowel = vowelOf(kana);
    const index = vowel === undefined ? -1 : columns.indexOf(vowel);
    // ん は母音を持たない。あ列に置く（表では単独行になる）。
    const target = index >= 0 ? index : 0;
    (row.cells as (Kana | undefined)[])[target] = kana;
  }

  return { group, title: TITLES[group], columns, rows };
}

/** 表示用の五十音図。清音 → 浊音 → 半浊音 → 拗音。 */
export function gojuonGrid(): GojuonSection[] {
  return (['seion', 'dakuon', 'handakuon', 'youon'] as const).map(buildSection);
}
