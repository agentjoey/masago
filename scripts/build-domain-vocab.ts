/**
 * 分野別語彙の取り込み（backlog「N3+ 词表与高阶场景」の第一歩）。手動実行。
 *
 *   pnpm build:domain
 *
 * 出典: JMdict（`scriptin/jmdict-simplified` の JSON 版、**CC BY-SA 4.0**）。
 * 読みと語義は出典のものをそのまま使う——ここでも模型には書かせない（§8）。
 *
 * ## なぜ JLPT 語彙表ではないのか
 *
 * 実測（2026-08-15）：JLPT の N3/N2/N1 表を全部足しても、この三分野の
 * **術語は 11〜13% しか入っていない**。表が収めているのは「人工」「知能」の
 * ような語素で、「人工知能」という術語ではない。「ゴルフ」「ロボット」の
 * ような日常の外来語すら入っていない。JMdict なら 100% 引ける。
 *
 * ## 分野の決め方——タグがあるものはタグで決める
 *
 * JMdict は語義ごとに分野タグを持つ。`golf` 124 件、`bus` 166 件。
 * **タグがある分野は、採録集合をこちらで判断しない**——助詞を例文プールの
 * 出題可能数で決めたのと同じ考え方（ADR-008）。
 *
 * AI・ロボット・自動運転には対応するタグが無い（`comp` は 10,750 件あって
 * 広すぎる）。ここだけは術語を手で挙げるが、**挙げた語が JMdict に
 * 実在することは試験が機械的に確かめる**。読みと語義は引いてくるので、
 * 手で書くのは「どれを含めるか」だけ。
 *
 * ## 例文は付かない
 *
 * Tatoeba にこの三分野の文は実質存在しない（品質タグと中文訳まで通すと
 * 5 / 7 / 1 文）。だから**単語カードだけ**。読解・助詞穴埋め・語順・作文は
 * 材料が無いので作らない。backlog にはこの項目を残してある。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const CACHE_DIR = join(process.cwd(), '.cache', 'jmdict');
const OUT_PATH = join(process.cwd(), 'src', 'curriculum', 'domainVocab.ts');

/** リリースは毎週自動更新される。版を固定して取り込み結果を再現可能にする。 */
const JMDICT_TAG = '3.6.2+20260810124713';
const JMDICT_URL = `https://github.com/scriptin/jmdict-simplified/releases/download/${encodeURIComponent(
  JMDICT_TAG,
)}/jmdict-eng-${encodeURIComponent(JMDICT_TAG)}.json.tgz`;

interface JmdictGloss {
  text: string;
}
interface JmdictSense {
  field?: string[];
  gloss?: JmdictGloss[];
  partOfSpeech?: string[];
}
interface JmdictWord {
  kanji?: { text: string; common?: boolean }[];
  kana?: { text: string; common?: boolean }[];
  sense?: JmdictSense[];
}

/**
 * AI・ロボット・自動運転の術語。
 *
 * JMdict に該当の分野タグが無いので、ここだけ手で挙げる。**語そのものは
 * 全部 JMdict から引く**ので、手で書いているのは「どれを含めるか」だけ。
 * 実在しない語を書けば `tests/curriculum/domainVocab.test.ts` が落ちる。
 */
const TECH_TERMS = [
  // 中核
  '人工知能', '機械学習', '深層学習', '学習', '認識', '推論', '知能',
  'ロボット', 'ロボット工学', '産業用ロボット', '自律', '自動化',
  '自動運転', '無人', '運転', '車両', '自動車',
  // 部品・装置
  'センサー', 'カメラ', 'レーダー', '装置', '制御', '制御装置',
  '半導体', '回路', '電池', '部品', '駆動', 'モーター',
  // データ・処理
  'データ', 'データベース', 'アルゴリズム', 'プログラム', '演算',
  '計算', '処理', '情報', '信号', '解析', '分析', '統計', '確率',
  '画像', '音声', '言語', '翻訳', '予測', '判断', '精度',
  // 工学・開発
  '技術', '開発', '研究', '設計', '実験', '性能', '効率', '最適化',
  '実装', '試験', '検査', '故障', '安全', '事故', '規格', '特許',
  '工場', '産業', '製造', '量産',
];

/** 採録する分野。タグで引けるものはタグを、無いものは語の一覧を使う。 */
const DOMAINS = [
  {
    id: 'business',
    name: '商务谈判',
    /** JMdict の分野タグ。 */
    fields: ['bus'],
    terms: [] as string[],
  },
  {
    id: 'golf',
    name: '高尔夫与球场经营',
    fields: ['golf'],
    terms: [] as string[],
  },
  {
    id: 'tech',
    name: 'AI・机器人・无人车',
    fields: [] as string[],
    terms: TECH_TERMS,
  },
] as const;

async function ensureJmdict(): Promise<string> {
  await mkdir(CACHE_DIR, { recursive: true });
  const json = join(CACHE_DIR, `jmdict-eng-${JMDICT_TAG.split('+')[0] ?? ''}.json`);
  if (existsSync(json)) {
    console.log('  キャッシュ利用: jmdict');
    return json;
  }
  const tgz = join(CACHE_DIR, 'jmdict.tgz');
  if (!existsSync(tgz)) {
    console.log(`  取得中: ${JMDICT_URL}`);
    const response = await fetch(JMDICT_URL, { signal: AbortSignal.timeout(600_000) });
    if (!response.ok) throw new Error(`fetch failed: ${String(response.status)}`);
    await writeFile(tgz, Buffer.from(await response.arrayBuffer()));
  }
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  await promisify(execFile)('tar', ['xzf', tgz, '-C', CACHE_DIR]);
  return json;
}

export interface DomainEntry {
  readonly id: string;
  readonly domain: string;
  readonly expression: string;
  readonly reading: string;
  readonly meaning: string;
}

function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * 語義。**ボタンの札に載る長さに抑える。**
 *
 * JMdict の語釈には括弧書きの長い説明が付くことがある（「green in
 * regulation (getting on the green while the number of strokes taken is
 * at least two fewer than par)」で 100 字超）。四択の札にそのまま載せると
 * 読めないし、Telegram の札としても長すぎる。
 *
 * 三つ繋いで 60 字を超えるなら減らし、一つでも超えるなら括弧書きを落とす。
 */
const MAX_GLOSS = 60;

function glossOf(sense: JmdictSense): string {
  const parts = (sense.gloss ?? []).map((g) => g.text);
  for (let take = Math.min(3, parts.length); take >= 1; take -= 1) {
    const joined = parts.slice(0, take).join(', ');
    if (joined.length <= MAX_GLOSS) return joined;
  }
  const first = parts[0] ?? '';
  // 括弧書きの説明を落としてもう一度見る。
  const trimmed = first.replace(/\s*\([^)]*\)/g, '').trim();
  if (trimmed !== '' && trimmed.length <= MAX_GLOSS) return trimmed;
  return (trimmed === '' ? first : trimmed).slice(0, MAX_GLOSS).trim();
}

async function main(): Promise<void> {
  console.log('分野別語彙を作ります\n');
  const path = await ensureJmdict();
  const raw = JSON.parse(await readFile(path, 'utf8')) as { words: JmdictWord[] };
  console.log(`  JMdict ${String(raw.words.length)} 語\n`);

  // 表記・読みから引ける索引。手挙げの術語を解決するのに使う。
  const byText = new Map<string, { word: JmdictWord; sense: JmdictSense }>();
  for (const word of raw.words) {
    const sense = word.sense?.[0];
    if (sense === undefined) continue;
    for (const k of word.kanji ?? []) {
      if (!byText.has(k.text)) byText.set(k.text, { word, sense });
    }
    for (const r of word.kana ?? []) {
      if (!byText.has(r.text)) byText.set(r.text, { word, sense });
    }
  }

  const entries: DomainEntry[] = [];
  const missing: string[] = [];

  /**
   * id は「分野の頭文字 + 連番」。表記をそのまま入れない。
   *
   * Telegram のコールバックは 64 バイトまで。`dq:<正解>:<選択>` に表記を
   * 二つ載せると、`business#グローバルバリューチェーン` のような長い語で
   * **88 バイトに達して送れなくなる**（実測 36 語が単独でも超過）。
   * 連番なら `dq:b12:b47` で収まる。
   */
  const counters = new Map<string, number>();
  const nextId = (domainId: string): string => {
    const n = (counters.get(domainId) ?? 0) + 1;
    counters.set(domainId, n);
    return `${domainId[0] ?? 'x'}${String(n)}`;
  };

  for (const domain of DOMAINS) {
    const before = entries.length;
    const seen = new Set<string>();

    // ① タグで引ける分
    for (const word of raw.words) {
      const sense = word.sense?.find((s) =>
        (s.field ?? []).some((f) => (domain.fields as readonly string[]).includes(f)),
      );
      if (sense === undefined) continue;
      const expression = word.kanji?.[0]?.text ?? word.kana?.[0]?.text;
      const reading = word.kana?.[0]?.text;
      const meaning = glossOf(sense);
      if (expression === undefined || reading === undefined || meaning === '') continue;
      if (seen.has(expression)) continue;
      seen.add(expression);
      entries.push({
        id: nextId(domain.id),
        domain: domain.id,
        expression,
        reading,
        meaning,
      });
    }

    // ② 手挙げの分（タグが無い分野）
    for (const term of domain.terms) {
      if (seen.has(term)) continue;
      const found = byText.get(term);
      if (found === undefined) {
        missing.push(`${domain.id}: ${term}`);
        continue;
      }
      const reading = found.word.kana?.[0]?.text;
      const meaning = glossOf(found.sense);
      if (reading === undefined || meaning === '') {
        missing.push(`${domain.id}: ${term}（読みまたは語義が取れない）`);
        continue;
      }
      seen.add(term);
      entries.push({
        id: nextId(domain.id),
        domain: domain.id,
        expression: term,
        reading,
        meaning,
      });
    }

    console.log(`  ${domain.name.padEnd(22)} ${String(entries.length - before)} 語`);
  }

  if (missing.length > 0) {
    console.log(`\n  ⚠️ JMdict に見つからなかった語 ${String(missing.length)} 件`);
    for (const m of missing) console.log(`     ${m}`);
  }

  const body = entries
    .map(
      (e) =>
        `  { id: ${quote(e.id)}, domain: ${quote(e.domain)}, expression: ${quote(e.expression)}, reading: ${quote(e.reading)}, meaning: ${quote(e.meaning)} },`,
    )
    .join('\n');

  const domainList = DOMAINS.map(
    (d) => `  { id: ${quote(d.id)}, name: ${quote(d.name)} },`,
  ).join('\n');

  const file = `/**
 * 分野別語彙（商务谈判 / 高尔夫 / AI・机器人・无人车）。
 * **自動生成。手で編集しない。**
 *
 *   pnpm build:domain
 *
 * 出典: JMdict（https://www.edrdg.org/jmdict/j_jmdict.html）
 *       配布は scriptin/jmdict-simplified の JSON 版、版 ${JMDICT_TAG}
 *       **ライセンス: CC BY-SA 4.0** —— 派生物の再配布時は同ライセンス。
 *
 * 分野の決め方：JMdict の分野タグ（\`bus\` \`golf\`）で引けるものはタグで決める。
 * AI・ロボット・自動運転にはタグが無いので術語を \`scripts/build-domain-vocab.ts\`
 * に列挙してあるが、**語そのものは全部 JMdict から引いている**。
 *
 * 例文は付かない。Tatoeba にこの三分野の文は実質存在しないため
 * （品質タグと中文訳まで通すと 5 / 7 / 1 文）、単語カードだけ。
 */

export interface DomainEntry {
  /**
   * \`分野の頭文字 + 連番\`（\`g12\` など）。表記を入れない——Telegram の
   * コールバックは 64 バイトまでで、長い外来語を二つ載せると超える。
   */
  readonly id: string;
  readonly domain: string;
  readonly expression: string;
  /** 仮名の読み。振り仮名と音声合成に使う。 */
  readonly reading: string;
  /** JMdict の英語語義（先頭三つまで）。 */
  readonly meaning: string;
}

export interface Domain {
  readonly id: string;
  readonly name: string;
}

export const DOMAINS: readonly Domain[] = [
${domainList}
];

export const DOMAIN_VOCAB: readonly DomainEntry[] = [
${body}
];

export const DOMAIN_BY_ID: ReadonlyMap<string, Domain> = new Map(
  DOMAINS.map((entry) => [entry.id, entry]),
);

export const DOMAIN_VOCAB_BY_ID: ReadonlyMap<string, DomainEntry> = new Map(
  DOMAIN_VOCAB.map((entry) => [entry.id, entry]),
);

export function domainVocabOf(domainId: string): DomainEntry[] {
  return DOMAIN_VOCAB.filter((entry) => entry.domain === domainId);
}

/** knowledge_items.key に入る形。型が DOMAIN なので接頭辞で衝突しない。 */
export function domainKey(id: string): string {
  return \`domain_\${id}\`;
}

export function domainVocabOfKey(key: string): DomainEntry | undefined {
  return key.startsWith('domain_')
    ? DOMAIN_VOCAB_BY_ID.get(key.slice('domain_'.length))
    : undefined;
}
`;

  await writeFile(OUT_PATH, file, 'utf8');
  console.log(`\n  合計 ${String(entries.length)} 語`);
  console.log(`  書き出し: ${OUT_PATH}`);
}

await main();
