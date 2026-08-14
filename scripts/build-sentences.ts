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
import {
  isBlankableParticle,
  PARTICLE_SURFACES,
} from '../src/curriculum/particles.js';

const CACHE_DIR = join(process.cwd(), '.cache', 'tatoeba');
const OUT_PATH = join(process.cwd(), 'src', 'curriculum', 'sentences.ts');

const SOURCES = {
  sentences:
    'https://downloads.tatoeba.org/exports/per_language/jpn/jpn_sentences.tsv.bz2',
  tags: 'https://downloads.tatoeba.org/exports/tags.tar.bz2',
  chinese:
    'https://downloads.tatoeba.org/exports/per_language/cmn/cmn_sentences.tsv.bz2',
  links: 'https://downloads.tatoeba.org/exports/links.tar.bz2',
};

/** 一文あたりの内容語の上限。長い文は語順の練習に向かない。 */
const MAX_CONTENT_WORDS = 9;
const MIN_CONTENT_WORDS = 2;
/** 出力する上限。多すぎるとファイルが読めなくなる。 */
const MAX_OUTPUT = 3500;

/**
 * 繁体字にしか無い字（高頻度のものだけ）。
 *
 * 訳が複数あるときに簡体字のほうを選ぶための目安で、字種の判定器ではない。
 * 繁体字しか無ければそれを使う——読みにくいのと、意味が分からないのとでは
 * 後者のほうが困る。
 */
const TRADITIONAL_ONLY =
  /[買賣說個們來這對還會學國東氣長點種樣現實體開關聞語頭馬鳥龍魚車門風飛時間問題經過發現數樂視聽讀寫書愛親歸鄉黃綠紅藍銀鐵錢價億萬歲點燈熱冷靜運動輪轉遠邊進連遲選適達違鄰陽階際隨險雞離難雲電需靜韓題顏願風飄飯飲養館馬駅騎驗體髮鬥鳥鳴鹽麗麵黃齒]/u;

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
  /** 人が書いた中国語訳（Tatoeba の対訳）。無い文のほうが多い。 */
  zh?: string;
}

/**
 * 日本語文 id → 中国語訳。
 *
 * **模型に訳させない**（§8）。ここで拾えなかった文の意味は、その場で
 * tutor が説明する——訳文そのものを作り置きするのとは別の話で、
 * 教材として残るのは人が書いた訳だけにしておく。
 */
async function loadTranslations(): Promise<Map<string, string>> {
  const cmn = new Map<string, string>();
  for (const line of (
    await readFile(join(CACHE_DIR, 'cmn_sentences.tsv'), 'utf8')
  ).split('\n')) {
    const parts = line.split('\t');
    if (parts.length >= 3 && parts[0] !== undefined && parts[2] !== undefined) {
      cmn.set(parts[0], parts[2]);
    }
  }

  // links は双方向に張られている。日本語側だけを拾う。
  const candidates = new Map<string, string[]>();
  for (const line of (
    await readFile(join(CACHE_DIR, 'links.csv'), 'utf8')
  ).split('\n')) {
    const parts = line.split('\t');
    const from = parts[0];
    const to = parts[1];
    if (from === undefined || to === undefined) continue;
    const translation = cmn.get(to);
    if (translation === undefined) continue;
    const list = candidates.get(from) ?? [];
    list.push(translation);
    candidates.set(from, list);
  }

  const chosen = new Map<string, string>();
  for (const [id, list] of candidates) {
    // 簡体字の訳があればそちらを採る。
    const simplified = list.find((text) => !TRADITIONAL_ONLY.test(text));
    const pick = simplified ?? list[0];
    if (pick !== undefined) chosen.set(id, pick);
  }
  return chosen;
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
  const chineseBz2 = await ensureFile(SOURCES.chinese, 'cmn_sentences.tsv.bz2');
  const linksBz2 = await ensureFile(SOURCES.links, 'links.tar.bz2');

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
  if (!existsSync(join(CACHE_DIR, 'cmn_sentences.tsv'))) {
    await run('bunzip2', ['-kf', chineseBz2]);
  }
  if (!existsSync(join(CACHE_DIR, 'links.csv'))) {
    // 300MB 近い。展開に少し時間がかかる。
    await run('tar', ['xjf', linksBz2, '-C', CACHE_DIR], {
      maxBuffer: 64 * 1024 * 1024,
    });
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

  const translations = await loadTranslations();
  console.log(`  中国語訳あり ${String(translations.size)} 件`);

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

    const zh = translations.get(id);
    kept.push({
      id,
      text: sentence,
      level: inN5 ? 'N5' : 'N4',
      tokens: tokens.map((token) => store(token)),
      ...(zh === undefined ? {} : { zh }),
    });
    stats.kept += 1;
  }

  analyzer.shutdown();

  /**
   * 残す順。訳のある文を先に取る。
   *
   * 上限で切るので、並べ方がそのまま「何が使えるか」を決める。前は N5 か
   * どうかだけで並べていて、訳のある文が上限の外へ押し出されていた
   * ——プール 2000 件のうち訳が付いていたのは 246 件だけで、読解も
   * 選択式応答も材料不足で作れなかった。訳の有無は自前では作れない
   * （模型に訳させない・§8）ので、こちらを優先する。
   */
  const rank = (entry: Candidate): number =>
    (entry.zh === undefined ? 2 : 0) + (entry.level === 'N5' ? 0 : 1);
  kept.sort((a, b) => rank(a) - rank(b));
  const selected = kept.slice(0, MAX_OUTPUT);
  // 出力は教える順（N5 が先）に戻す。
  selected.sort((a, b) => (a.level === b.level ? 0 : a.level === 'N5' ? -1 : 1));

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
  const translated = selected.filter((entry) => entry.zh !== undefined).length;
  console.log(`      うち中国語訳あり ${String(translated)}`);

  /**
   * 助詞を差し替えても実在の文になってしまう位置を洗い出す。
   *
   * 穴埋めは「元の文と違えば誤り」で採点するが、日本語の助詞には
   * 入れ替えても通る場所がある——「日曜日は何をしますか」と
   * 「日曜日に何をしますか」はどちらも実在の文で、どちらを選んでも
   * 正しい。片方だけを正解にすると、正しく書いた学習者に ❌ を出す
   * ことになる（§15 の裏返し）。
   *
   * 判定はコーパスに実在するかどうかだけで行う。**実在すれば通ることの
   * 証明になるが、実在しなくても通らない証明にはならない**——だから
   * これは曖昧な位置を全部見つける仕掛けではなく、見つかった分だけ
   * 確実に減らす仕掛け。外す方向に間違えても材料が減るだけで、
   * 誤ったことは教えない。
   *
   * 実測 5584 箇所中 40 箇所（0.7%）。
   */
  const attested = new Set<string>();
  for (const sentence of text.values()) {
    attested.add(stripTail(sentence));
  }
  const ambiguous = new Map<string, number[]>();
  let checked = 0;
  for (const entry of selected) {
    let offset = 0;
    entry.tokens.forEach((token, index) => {
      const start = offset;
      offset += token.s.length;
      if (!isBlankableParticle(token)) return;
      const previous = entry.tokens[index - 1];
      if (previous === undefined || previous.p !== '名詞') return;
      checked += 1;
      const head = entry.text.slice(0, start);
      const tail = entry.text.slice(start + token.s.length);
      const alternative = PARTICLE_SURFACES.some(
        (particle) =>
          particle !== token.s && attested.has(stripTail(head + particle + tail)),
      );
      if (!alternative) return;
      const list = ambiguous.get(entry.id) ?? [];
      list.push(index);
      ambiguous.set(entry.id, list);
    });
  }
  const ambiguousCount = [...ambiguous.values()].reduce(
    (sum, list) => sum + list.length,
    0,
  );
  console.log(
    `\n  助詞の空欄候補 ${String(checked)} 箇所、うち別の助詞でも通る ${String(ambiguousCount)} 箇所を除外`,
  );

  const line = (entry: Candidate): string => {
    const zh = entry.zh === undefined ? '' : `, zh: ${quote(entry.zh)}`;
    return `  { id: ${quote(entry.id)}, level: ${quote(entry.level)}, text: ${quote(entry.text)}${zh}, tokens: [${entry.tokens.map(tokenLiteral).join(',')}] },`;
  };

  /**
   * 一つの配列リテラルに全部入れない。
   *
   * TypeScript は配列リテラルの型を要素から組み立てるので、この規模
   * （一件が入れ子の配列を持つ）だと 2000 件を超えたあたりで
   * 「union type that is too complex」で落ちる。注釈付きの塊に分けて
   * 展開すれば、リテラル推論そのものが起きない。
   */
  const CHUNK_SIZE = 1000;
  const chunks: string[] = [];
  for (let start = 0; start < selected.length; start += CHUNK_SIZE) {
    const part = selected.slice(start, start + CHUNK_SIZE);
    chunks.push(
      `const PART_${String(chunks.length)}: readonly Sentence[] = [\n${part.map(line).join('\n')}\n];`,
    );
  }
  const body = [
    chunks.join('\n\n'),
    '',
    `export const SENTENCES: readonly Sentence[] = [${chunks
      .map((_, index) => `...PART_${String(index)}`)
      .join(', ')}];`,
  ].join('\n');

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
  /**
   * 人が書いた中国語訳。付いている文のほうが少ない。
   *
   * **模型の訳は入れない**（§8）。訳が無い文の意味は、その場で tutor が
   * 説明する——説明は模型でよいが、教材として残す訳文は人のものだけにする。
   */
  readonly zh?: string;
  readonly tokens: readonly StoredToken[];
}

${body}

export const SENTENCES_BY_ID: ReadonlyMap<string, Sentence> = new Map(
  SENTENCES.map((entry) => [entry.id, entry]),
);

/** 中国語訳が付いている文だけ。読解と選択式応答の材料になる。 */
export const TRANSLATED: readonly Sentence[] = SENTENCES.filter(
  (entry) => entry.zh !== undefined,
);

/**
 * 助詞を差し替えても実在の文になる位置（文 id → トークンの位置）。
 *
 * ここを空欄にすると、別の助詞を選んだ学習者に ❌ を出してしまうが、
 * その助詞でも日本語として通る。出題から外す。
 *
 * 判定はコーパスに実在するかどうかだけ。実在すれば通る証明になるが、
 * 実在しないことは通らない証明にならない——**曖昧な位置を全部
 * 見つける表ではなく、確実に曖昧だと分かった分だけの表**。
 */
export const AMBIGUOUS_BLANKS: ReadonlyMap<string, readonly number[]> = new Map([
${[...ambiguous.entries()]
  .map(([id, list]) => `  [${quote(id)}, [${list.join(', ')}]],`)
  .join('\n')}
]);
`;

  await writeFile(OUT_PATH, file, 'utf8');
  console.log(`\n  書き出し: ${OUT_PATH}`);
}

/** 文末の句読点を落とす。実在判定で「。」の有無だけの違いを潰すため。 */
function stripTail(text: string): string {
  return text.replace(/[。．.！!？?\s]+$/u, '');
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
