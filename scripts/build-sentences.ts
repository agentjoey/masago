/**
 * 例文プールの構築（docs/scenario-learning.md）。手動実行、CI では走らせない。
 *
 *   pnpm build:sentences
 *
 * 出典: Tatoeba（CC BY 2.0 FR）。**人が書いた文だけを使う**——語順や助詞を
 * 教える材料をモデルに作らせるわけにはいかない（§8）。
 *
 * 素の Tatoeba は投稿制で誤りを含む。学習者は誤りに気づけない（§15）ので、
 * 通す条件を重ねる：
 *
 *   1. 語彙が既習の範囲に収まる（N5 / N5+N4）
 *   2. 活用形も範囲内（仮定形・命令形などを使う文は読めない）
 *   3. Tatoeba の品質タグ（OK / Tanaka Corpus）が付いている
 *   4. **自前の文法規則に一つも引っかからない**
 *
 * 4 が効く。規則が見ているのは助詞と活用で、これから作る問題
 * （助詞の穴埋め・語順の並べ替え）が問うのと同じ場所だからである。
 *
 * 形態素解析の結果も一緒に書き出す。実行時に 400MB の辞書を積まずに
 * 済ませるため——問題を組むのに必要なのは品詞と読みだけで、
 * それは今ここで確定できる。
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAnalyzer, detectGrammarIssues, type Token } from '../src/nlp/index.js';
import { VOCAB } from '../src/curriculum/vocab.js';

const CACHE_DIR = join(process.cwd(), '.cache', 'tatoeba');
const OUT_PATH = join(process.cwd(), 'src', 'curriculum', 'sentences.ts');

const SOURCES = {
  sentences:
    'https://downloads.tatoeba.org/exports/per_language/jpn/jpn_sentences.tsv.bz2',
  tags: 'https://downloads.tatoeba.org/exports/tags.tar.bz2',
};

/** 一文あたりの内容語の上限。長い文は語順の練習に向かない。 */
const MAX_CONTENT_WORDS = 9;
const MIN_CONTENT_WORDS = 2;
/** 出力する上限。多すぎるとファイルが読めなくなる。 */
const MAX_OUTPUT = 2000;

/** 既習の範囲外の活用形。これを使う文は N5 では読めない。 */
const HARD_FORMS = ['仮定形', '命令', '未然ウ接続', '体言接続', '未然形'];
const FUNCTION_POS = new Set(['助詞', '助動詞', '記号', 'フィラー', '感動詞']);

async function ensureFile(url: string, name: string): Promise<string> {
  await mkdir(CACHE_DIR, { recursive: true });
  const path = join(CACHE_DIR, name);
  if (existsSync(path)) {
    console.log(`  キャッシュ利用: ${name}`);
    return path;
  }
  console.log(`  取得中: ${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`fetch failed: ${String(response.status)}`);
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
  return path;
}

/** N5 と N5+N4 の既習語彙。表記と読みの両方を鍵にする。 */
function knownSets(): { n5: Set<string>; all: Set<string> } {
  const n5 = new Set<string>();
  const all = new Set<string>();
  for (const entry of VOCAB) {
    all.add(entry.expression);
    all.add(entry.reading);
    if (entry.level === 'N5') {
      n5.add(entry.expression);
      n5.add(entry.reading);
    }
  }
  return { n5, all };
}

export interface StoredToken {
  readonly s: string;
  readonly p: string;
  readonly d: string;
  readonly r?: string;
}

interface Candidate {
  id: string;
  text: string;
  level: 'N5' | 'N4';
  tokens: StoredToken[];
}

function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function tokenLiteral(token: StoredToken): string {
  const reading = token.r === undefined ? '' : `,r:${quote(token.r)}`;
  return `{s:${quote(token.s)},p:${quote(token.p)},d:${quote(token.d)}${reading}}`;
}

async function main(): Promise<void> {
  console.log('例文プールを作ります\n');

  const sentencesBz2 = await ensureFile(SOURCES.sentences, 'jpn_sentences.tsv.bz2');
  const tagsBz2 = await ensureFile(SOURCES.tags, 'tags.tar.bz2');

  // bunzip2 / tar は環境に任せる。Node に持ち込むと依存が増える。
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  if (!existsSync(join(CACHE_DIR, 'jpn_sentences.tsv'))) {
    await run('bunzip2', ['-kf', sentencesBz2]);
  }
  if (!existsSync(join(CACHE_DIR, 'tags.csv'))) {
    await run('tar', ['xjf', tagsBz2, '-C', CACHE_DIR]);
  }

  const text = new Map<string, string>();
  for (const line of (
    await readFile(join(CACHE_DIR, 'jpn_sentences.tsv'), 'utf8')
  ).split('\n')) {
    const parts = line.split('\t');
    if (parts.length >= 3 && parts[0] !== undefined && parts[2] !== undefined) {
      text.set(parts[0], parts[2]);
    }
  }
  console.log(`\n  日本語の文 ${String(text.size)} 件`);

  const trusted = new Set<string>();
  for (const line of (await readFile(join(CACHE_DIR, 'tags.csv'), 'utf8')).split(
    '\n',
  )) {
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    if (parts[1] === 'OK' || parts[1] === 'Tanaka Corpus') {
      if (parts[0] !== undefined) trusted.add(parts[0]);
    }
  }
  console.log(`  品質タグ付き ${String(trusted.size)} 件`);

  const { n5, all } = knownSets();
  const analyzer = createAnalyzer({
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as never,
    idleMs: 600_000,
  });

  const stats = {
    seen: 0,
    noTag: 0,
    tooLong: 0,
    unknownWord: 0,
    hardGrammar: 0,
    ruleFlagged: 0,
    kept: 0,
  };
  const kept: Candidate[] = [];

  for (const [id, sentence] of text) {
    stats.seen += 1;
    // 品質タグを最初に見る。ここで大半が落ちるので解析の回数が減る。
    if (!trusted.has(id)) {
      stats.noTag += 1;
      continue;
    }
    if (sentence.length > 40) {
      stats.tooLong += 1;
      continue;
    }

    const tokens = await analyzer.tokenize(sentence);
    const content = tokens.filter((token) => !FUNCTION_POS.has(token.pos));
    if (content.length < MIN_CONTENT_WORDS || content.length > MAX_CONTENT_WORDS) {
      stats.tooLong += 1;
      continue;
    }

    const inN5 = content.every(
      (token) => n5.has(token.basicForm) || n5.has(token.surface),
    );
    const inAll = content.every(
      (token) => all.has(token.basicForm) || all.has(token.surface),
    );
    if (!inAll) {
      stats.unknownWord += 1;
      continue;
    }
    if (
      tokens.some((token) =>
        HARD_FORMS.some((form) => token.conjugatedForm.includes(form)),
      )
    ) {
      stats.hardGrammar += 1;
      continue;
    }

    // 自前の規則に引っかかる文は捨てる。規則が見ているのは助詞と活用で、
    // これから作る問題が問うのと同じ場所——素材が誤っていたら問題も誤る。
    if (detectGrammarIssues(tokens).length > 0) {
      stats.ruleFlagged += 1;
      continue;
    }

    kept.push({
      id,
      text: sentence,
      level: inN5 ? 'N5' : 'N4',
      tokens: tokens.map((token) => store(token)),
    });
    stats.kept += 1;
  }

  analyzer.shutdown();

  // N5 を優先して残す。初級者に要るのは易しい文で、
  // 先着順だと数の多い N4 で埋まってしまう。
  kept.sort((a, b) => (a.level === b.level ? 0 : a.level === 'N5' ? -1 : 1));
  const selected = kept.slice(0, MAX_OUTPUT);

  console.log('\n  絞り込み');
  console.log(`    見た文            ${String(stats.seen)}`);
  console.log(`    品質タグ無し      -${String(stats.noTag)}`);
  console.log(`    長さ/語数が範囲外  -${String(stats.tooLong)}`);
  console.log(`    未習の語を含む    -${String(stats.unknownWord)}`);
  console.log(`    活用形が範囲外    -${String(stats.hardGrammar)}`);
  console.log(`    規則に抵触        -${String(stats.ruleFlagged)}`);
  console.log(`    採用              ${String(stats.kept)}`);
  const n5Total = kept.filter((entry) => entry.level === 'N5').length;
  console.log(`      うち N5 ${String(n5Total)} / N4 ${String(kept.length - n5Total)}`);
  const n5Count = selected.filter((entry) => entry.level === 'N5').length;
  console.log(`    書き出し ${String(selected.length)} 件（N5 ${String(n5Count)} / N4 ${String(selected.length - n5Count)}）`);

  const body = selected
    .map(
      (entry) =>
        `  { id: ${quote(entry.id)}, level: ${quote(entry.level)}, text: ${quote(entry.text)}, tokens: [${entry.tokens.map(tokenLiteral).join(',')}] },`,
    )
    .join('\n');

  const file = `/**
 * 例文プール（docs/scenario-learning.md）。**自動生成。手で編集しない。**
 *
 *   pnpm build:sentences
 *
 * 出典: Tatoeba（CC BY 2.0 FR）https://tatoeba.org/
 *       品質タグ OK / Tanaka Corpus が付いた文のみ。
 *
 * 通した条件：既習語彙のみ・活用形も既習範囲・品質タグあり・
 * 自前の文法規則に非抵触。素の Tatoeba は投稿制で誤りを含み、
 * 学習者は誤りに気づけない（§15）ので、重ねられる条件は全部重ねてある。
 *
 * **それでも「正しさが保証された集合」ではない。** 規則が見ていない
 * 種類の誤りは通り抜ける。ここを詰めるには人手か、モデルによる
 * 否決（生成ではなく）の層が要る——docs/scenario-learning.md §2。
 *
 * 形態素解析の結果を同梱してあるので、実行時に辞書は要らない。
 */

/** 解析済みの一語。s=表層 p=品詞 d=品詞細分類 r=読み（片仮名）。 */
export interface StoredToken {
  readonly s: string;
  readonly p: string;
  readonly d: string;
  readonly r?: string;
}

export interface Sentence {
  /** Tatoeba の文 id。出典を辿れるようにしておく。 */
  readonly id: string;
  readonly level: 'N5' | 'N4';
  readonly text: string;
  readonly tokens: readonly StoredToken[];
}

export const SENTENCES: readonly Sentence[] = [
${body}
];

export const SENTENCES_BY_ID: ReadonlyMap<string, Sentence> = new Map(
  SENTENCES.map((entry) => [entry.id, entry]),
);
`;

  await writeFile(OUT_PATH, file, 'utf8');
  console.log(`\n  書き出し: ${OUT_PATH}`);
}

function store(token: Token): StoredToken {
  return {
    s: token.surface,
    p: token.pos,
    d: token.posDetail,
    ...(token.reading === undefined ? {} : { r: token.reading }),
  };
}

await main();
