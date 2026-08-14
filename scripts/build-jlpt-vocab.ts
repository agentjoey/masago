/**
 * N5 語彙データの取り込み（V2 §8）。手動実行、CI では走らせない。
 *
 *   pnpm build:vocab
 *
 * 語義・読み・JLPT 等級は事実なので、モデルに書かせず公開データから取る
 * （§8 の原則）。出典は elzup/jlpt-word-list（MIT）。生成物はコミットして
 * 版に固定する——実行のたびに上流が変わると、学習履歴の指す語が動く。
 *
 * ここでやる正規化は三つ。どれも「そのまま使うと教え間違える」もの：
 *   1. 同表記異読（一日 いちにち／ついたち）は別語として扱う。
 *      表記だけを鍵にすると、片方の学習履歴がもう片方を上書きする。
 *   2. 読みに混ざる出典側の記法（～、"いく; ゆく"、"(〜を) とお"）を
 *      仮名だけの「主たる読み」に落とす。振り仮名や音声合成に使うため。
 *   3. 接辞（～円、～時）は語ではないので印を付ける。単独で出題すると
 *      「～円」という単語があると誤解させる。
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SOURCE_BASE =
  'https://raw.githubusercontent.com/elzup/jlpt-word-list/master/src';

/** 教える順。N5 を終えてから N4（V2 §2.1 の S1 → S2）。 */
const LEVELS = [
  { level: 'N5', file: 'n5.csv', out: 'vocabN5.ts', constant: 'VOCAB_N5' },
  { level: 'N4', file: 'n4.csv', out: 'vocabN4.ts', constant: 'VOCAB_N4' },
] as const;

interface RawRow {
  expression: string;
  reading: string;
  meaning: string;
  tags: string;
}

/** RFC4180 の最小限。引用符付きフィールドとその中のカンマを扱う。 */
function parseCsv(text: string): RawRow[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows;
  if (header === undefined) return [];
  const index = (name: string): number => header.indexOf(name);
  const iExpr = index('expression');
  const iRead = index('reading');
  const iMean = index('meaning');
  const iTags = index('tags');

  return body
    .filter((cells) => cells.length >= 3 && (cells[iExpr] ?? '') !== '')
    .map((cells) => ({
      expression: (cells[iExpr] ?? '').trim(),
      reading: (cells[iRead] ?? '').trim(),
      meaning: (cells[iMean] ?? '').trim(),
      tags: (cells[iTags] ?? '').trim(),
    }));
}

const KANA_ONLY = /^[ぁ-ゟ゠-ヿーー]+$/;

/**
 * 出典の読みから、仮名だけの主たる読みを取り出す。
 *
 * 「いく; ゆく」→ いく（最初の候補）
 * 「～えん」→ えん（接辞の印を落とす）
 * 「(〜を) とお」→ とお（補足の括弧を落とす）
 */
function primaryReading(raw: string): string | undefined {
  const first = (raw.split(';')[0] ?? '').trim();
  const stripped = first
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[～〜~]/g, '')
    .replace(/\s+/g, '')
    .trim();
  return KANA_ONLY.test(stripped) ? stripped : undefined;
}

function genkiLessonOf(tags: string): number | undefined {
  const match = /Genki_Ln\.(\d+)/.exec(tags);
  if (match === null) return undefined;
  const lesson = Number.parseInt(match[1] ?? '', 10);
  return Number.isNaN(lesson) ? undefined : lesson;
}

interface Entry {
  id: string;
  level: string;
  expression: string;
  reading: string;
  displayReading: string;
  meaning: string;
  genkiLesson: number | undefined;
  isAffix: boolean;
}

function toEntry(row: RawRow, level: string): Entry | undefined {
  const reading = primaryReading(row.reading);
  if (reading === undefined) return undefined;
  // 表記も読みも鍵に入れる。同表記異読を一つにまとめると、
  // 片方の学習履歴がもう片方を上書きしてしまう。
  const expression = row.expression.split(';')[0]?.trim() ?? row.expression;
  return {
    id: `${expression}#${reading}`,
    level,
    expression,
    reading,
    displayReading: row.reading,
    meaning: row.meaning,
    genkiLesson: genkiLessonOf(row.tags),
    isAffix: /[～〜~]/.test(row.expression) || /[～〜~]/.test(row.reading),
  };
}

/**
 * 指導順。Genki の課順を骨にする——実際に使われている教科書の並びで、
 * 挨拶・数・身の回りの名詞から始まる。頻度順を自作するより確かで、
 * 五十音を終えたばかりの人がそのまま進める。
 *
 * Genki に無い語はその後ろ。出典の並び（読みの五十音順）を保つので、
 * 生成のたびに順序が動くことはない。
 */
function teachingOrder(entries: readonly Entry[]): Entry[] {
  const withLesson = entries.filter((entry) => entry.genkiLesson !== undefined);
  const without = entries.filter((entry) => entry.genkiLesson === undefined);
  withLesson.sort((a, b) => (a.genkiLesson ?? 0) - (b.genkiLesson ?? 0));
  return [...withLesson, ...without];
}

function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

async function buildLevel(spec: (typeof LEVELS)[number]): Promise<number> {
  const url = `${SOURCE_BASE}/${spec.file}`;
  console.log(`\n取得中: ${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    throw new Error(`fetch failed: ${String(response.status)}`);
  }
  const rows = parseCsv(await response.text());
  console.log(`  取得 ${String(rows.length)} 行`);

  const entries: Entry[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const entry = toEntry(row, spec.level);
    if (entry === undefined) {
      skipped.push(`${row.expression}(${row.reading})`);
      continue;
    }
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }

  const ordered = teachingOrder(entries);
  const withLesson = ordered.filter((e) => e.genkiLesson !== undefined).length;
  console.log(`  採用 ${String(ordered.length)} 語（Genki 課順あり ${String(withLesson)}）`);
  if (skipped.length > 0) {
    console.log(`  読みを仮名化できず除外 ${String(skipped.length)} 語`);
  }

  const body = ordered
    .map((entry) => {
      const lesson =
        entry.genkiLesson === undefined
          ? ''
          : `, genkiLesson: ${String(entry.genkiLesson)}`;
      const affix = entry.isAffix ? ', isAffix: true' : '';
      const display =
        entry.displayReading === entry.reading
          ? ''
          : `, displayReading: ${quote(entry.displayReading)}`;
      return `  { id: ${quote(entry.id)}, level: ${quote(entry.level)}, expression: ${quote(entry.expression)}, reading: ${quote(entry.reading)}, meaning: ${quote(entry.meaning)}${display}${lesson}${affix} },`;
    })
    .join('\n');

  const file = `/**
 * JLPT ${spec.level} 語彙（V2 §8）。**自動生成。手で編集しない。**
 *
 *   pnpm build:vocab
 *
 * 出典: elzup/jlpt-word-list（MIT License, © 2020 Jamie Sinclair / elzup）
 *       ${url}
 *
 * 語義は出典どおりの英語。中国語に機械翻訳して取り込むと、確かめようの
 * 無い誤りが「正解データ」として混ざる——語義は事実なので出典に委ねる
 * （§8）。学習者への中国語の説明は、必要なときにチューターが行う。
 *
 * 並びは Genki の課順を骨にし、その後ろに Genki に無い語を出典の並びの
 * まま置く。詳細は scripts/build-jlpt-vocab.ts を参照。
 */
import type { VocabEntry } from './vocabTypes.js';

export const ${spec.constant}: readonly VocabEntry[] = [
${body}
];
`;

  await writeFile(join(process.cwd(), 'src', 'curriculum', spec.out), file, 'utf8');
  console.log(`  書き出し: src/curriculum/${spec.out}`);
  return ordered.length;
}

async function main(): Promise<void> {
  let total = 0;
  for (const spec of LEVELS) {
    total += await buildLevel(spec);
  }
  console.log(`\n合計 ${String(total)} 語`);
}
await main();
