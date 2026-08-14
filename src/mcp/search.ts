import { KANA, KANA_BY_ID, kanaKey } from '../curriculum/kana.js';
import { PARTICLES, PARTICLE_BY_ID, particleKey } from '../curriculum/particles.js';
import { SENTENCES, SENTENCES_BY_ID } from '../curriculum/sentences.js';
import { VOCAB, VOCAB_BY_ID, vocabKey } from '../curriculum/vocab.js';

/**
 * MCP の `search` / `fetch` が扱う検索（docs/mcp.md §2.1）。純粋関数。
 *
 * ChatGPT 側は `search` と `fetch` の二つを固定の形で要求する。中身は
 * こちらの自由なので、**既にある課程データを一つの索引として見せる**。
 * 新しいデータは作らない——出るのは仮名表・語彙表・助詞・例文だけで、
 * どれも出典のあるものか、committed の手書き（助詞のラベル）である（§8）。
 *
 * ## 順位の付け方
 *
 * 完全一致 → 前方一致 → 部分一致。同点なら知識項を例文より前に出す。
 * 例文は 3,500 件あるので、混ぜて並べると知識項が埋もれる——「本」を
 * 引いたら、まず単語の「本」が出てほしい。
 */

export type ResourceKind = 'kana' | 'vocab' | 'particle' | 'sentence' | 'issue';

export interface SearchHit {
  /** `kana:a` のように種別を前置した安定 id。`fetch` に渡す。 */
  readonly id: string;
  readonly title: string;
  /** Mini App の該当箇所。ChatGPT の引用から開ける。 */
  readonly url: string;
  readonly kind: ResourceKind;
  readonly score: number;
}

/** `kana:a` → `{ kind: 'kana', key: 'a' }`。語彙 id は `#` を含むので一度だけ割る。 */
export function parseResourceId(
  id: string,
): { kind: ResourceKind; key: string } | undefined {
  const at = id.indexOf(':');
  if (at <= 0) return undefined;
  const kind = id.slice(0, at);
  const key = id.slice(at + 1);
  if (key === '') return undefined;
  if (
    kind === 'kana' ||
    kind === 'vocab' ||
    kind === 'particle' ||
    kind === 'sentence' ||
    kind === 'issue'
  ) {
    return { kind, key };
  }
  return undefined;
}

/**
 * 一致の強さ。0 は不一致。
 *
 * 大小と前後の空白だけ均す。日本語には大小が無いが、ローマ字と英語の
 * 語義は混ざって入っている。
 */
function match(haystack: string, needle: string): number {
  if (haystack === '' || needle === '') return 0;
  const text = haystack.toLowerCase();
  if (text === needle) return 100;
  if (text.startsWith(needle)) return 60;
  if (text.includes(needle)) return 30;
  return 0;
}

/** 複数の項目のうち、いちばん強く当たったものを採る。 */
function best(fields: readonly string[], needle: string): number {
  let top = 0;
  for (const field of fields) {
    const score = match(field, needle);
    if (score > top) top = score;
  }
  return top;
}

export interface SearchOptions {
  readonly limit?: number;
  /** Mini App の起点。`https://…/app` を渡すと url が組める。 */
  readonly baseUrl?: string;
}

function urlOf(base: string, kind: ResourceKind, key: string): string {
  return `${base}#${kind}/${encodeURIComponent(key)}`;
}

/**
 * 課程データを横断して引く。
 *
 * 例文は**知識項が一件も当たらなかった場合と、明らかに文を探している
 * 場合**に限って多めに出す。そうしないと 3,500 件が上位を占める。
 */
export function searchCurriculum(
  query: string,
  options: SearchOptions = {},
): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];
  const limit = options.limit ?? 20;
  const base = options.baseUrl ?? '';

  const hits: SearchHit[] = [];

  for (const kana of KANA) {
    const score = best([kana.hiragana, kana.katakana, kana.romaji], needle);
    if (score === 0) continue;
    hits.push({
      id: `kana:${kana.id}`,
      title: `${kana.hiragana} / ${kana.katakana}（${kana.romaji}）`,
      url: urlOf(base, 'kana', kana.id),
      kind: 'kana',
      score,
    });
  }

  for (const entry of VOCAB) {
    const score = best([entry.expression, entry.reading, entry.meaning], needle);
    if (score === 0) continue;
    hits.push({
      id: `vocab:${entry.id}`,
      title: `${entry.expression}（${entry.reading}）— ${entry.meaning}`,
      url: urlOf(base, 'vocab', entry.id),
      kind: 'vocab',
      score,
    });
  }

  for (const particle of PARTICLES) {
    const score = best(
      [particle.surface, particle.reading, particle.label],
      needle,
    );
    if (score === 0) continue;
    hits.push({
      id: `particle:${particle.id}`,
      title: `助词 ${particle.surface}（${particle.reading}）— ${particle.label}`,
      url: urlOf(base, 'particle', particle.id),
      kind: 'particle',
      score,
    });
  }

  // 知識項を先に並べる。ここまでで足りていれば例文は見に行かない。
  hits.sort((a, b) => b.score - a.score);
  const roomForSentences = Math.max(limit - hits.length, 3);

  // 全 3,500 文を見る。以前は「候補が枠の 4 倍たまったら打ち切り」に
  // していたが、完全一致がプールの後方にあると**部分一致 12 件を集めた
  // 時点で打ち切られて出てこない**。走査は文字列 includes だけなので、
  // 全部見ても 1ms 台——打ち切りで守るものが無い。
  const sentenceHits: SearchHit[] = [];
  for (const sentence of SENTENCES) {
    const score = best([sentence.text, sentence.zh ?? ''], needle);
    if (score === 0) continue;
    sentenceHits.push({
      id: `sentence:${sentence.id}`,
      title: sentence.zh === undefined
        ? sentence.text
        : `${sentence.text}（${sentence.zh}）`,
      url: urlOf(base, 'sentence', sentence.id),
      kind: 'sentence',
      score,
    });
  }
  sentenceHits.sort((a, b) => b.score - a.score);

  return [...hits, ...sentenceHits.slice(0, roomForSentences)].slice(0, limit);
}

export interface ResourceDetail {
  readonly id: string;
  readonly title: string;
  /** 模型が読む本文。 */
  readonly text: string;
  readonly url: string;
  readonly metadata: Record<string, unknown>;
}

/**
 * 一件の詳細（学習状態を除く純粋な部分）。
 *
 * 学習状態（何回練習したか、次はいつか）は DB から来るので、
 * 呼び出し側が `text` に足す。ここは課程データだけを見る。
 */
export function describeResource(
  id: string,
  options: SearchOptions = {},
): ResourceDetail | undefined {
  const parsed = parseResourceId(id);
  if (parsed === undefined) return undefined;
  const base = options.baseUrl ?? '';
  const url = urlOf(base, parsed.kind, parsed.key);

  if (parsed.kind === 'kana') {
    const kana = KANA_BY_ID.get(parsed.key);
    if (kana === undefined) return undefined;
    return {
      id,
      title: `${kana.hiragana}（${kana.romaji}）`,
      text: [
        `平假名：${kana.hiragana}`,
        `片假名：${kana.katakana}`,
        `罗马字：${kana.romaji}`,
        `行：${kana.row}行　类别：${kana.group}`,
      ].join('\n'),
      url,
      metadata: { kind: 'kana', romaji: kana.romaji, row: kana.row },
    };
  }

  if (parsed.kind === 'vocab') {
    const entry = VOCAB_BY_ID.get(parsed.key);
    if (entry === undefined) return undefined;
    const lines = [
      `${entry.expression}（${entry.reading}）`,
      `释义：${entry.meaning}`,
      `等级：${entry.level}`,
    ];
    if (entry.genkiLesson !== undefined) {
      lines.push(`Genki 第 ${String(entry.genkiLesson)} 课`);
    }
    return {
      id,
      title: `${entry.expression} — ${entry.meaning}`,
      text: lines.join('\n'),
      url,
      metadata: {
        kind: 'vocabulary',
        reading: entry.reading,
        level: entry.level,
      },
    };
  }

  if (parsed.kind === 'particle') {
    const particle = PARTICLE_BY_ID.get(parsed.key);
    if (particle === undefined) return undefined;
    const lines = [
      `助词 ${particle.surface}`,
      `读作：${particle.reading}`,
      `用法：${particle.label}`,
    ];
    if (particle.surface !== particle.reading) {
      lines.push(
        `注意：作助词时读 ${particle.reading}，不按字面读`,
      );
    }
    return {
      id,
      title: `助词 ${particle.surface}`,
      text: lines.join('\n'),
      url,
      metadata: { kind: 'grammar', reading: particle.reading },
    };
  }

  if (parsed.kind === 'sentence') {
    const sentence = SENTENCES_BY_ID.get(parsed.key);
    if (sentence === undefined) return undefined;
    const lines = [sentence.text];
    if (sentence.zh !== undefined) lines.push(`中文：${sentence.zh}`);
    lines.push(`等级：${sentence.level}`);
    // 出典を必ず添える。Tatoeba は CC BY 2.0 FR で署名が要る。
    lines.push(
      `出处：Tatoeba 句 #${sentence.id}（CC BY 2.0 FR, https://tatoeba.org/sentences/show/${sentence.id}）`,
    );
    return {
      id,
      title: sentence.text,
      text: lines.join('\n'),
      url,
      metadata: {
        kind: 'sentence',
        level: sentence.level,
        source: 'Tatoeba',
        license: 'CC BY 2.0 FR',
      },
    };
  }

  // issue（錯題）は DB にあるので呼び出し側が組む。
  return undefined;
}

/**
 * 知識項の id を `knowledge_items.key` に直す。学習状態を引くのに使う。
 *
 * 接頭辞は各 curriculum モジュールの関数から採る。ここで文字列を
 * 書き写すと、向こうを直したときに黙ってずれる。
 */
export function knowledgeKeyOf(id: string): string | undefined {
  const parsed = parseResourceId(id);
  if (parsed === undefined) return undefined;
  switch (parsed.kind) {
    case 'kana':
      return kanaKey(parsed.key);
    case 'vocab':
      return vocabKey(parsed.key);
    case 'particle':
      return particleKey(parsed.key);
    default:
      return undefined;
  }
}
