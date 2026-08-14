/**
 * 作文判定の誤収率を測る（docs/scenario-learning.md §7.1 の積み残し）。手動実行。
 *
 *   pnpm eval:judge [件数]
 *
 * ## なぜ人手のラベル付けをしないか
 *
 * 「模型の判定が正しいか」を測るのに、こちらもラベルを付けるとなると、
 * 付ける人（＝ここでは私）の判断が基準になってしまう。それでは基準の
 * ほうが怪しい。そこで**構成によって答えが決まる**サンプルだけを使う：
 *
 * | 種類 | 作り方 | 正解 |
 * |---|---|---|
 * | `PARAPHRASE` | 同じ中国語訳を持つ**別の実在文**。Tatoeba で人が同じ訳に紐付けた | OK |
 * | `ROLE_SWAP` | 主語と目的語の名詞を入れ替える。日本語としては正しいが**意味が逆になる** | NG |
 * | `CONJUGATION` | 終止形＋ます（見るます）。規則で確実に誤りと言える形 | NG |
 * | `MEANING` | **別の訳を持つ**実在文。日本語としては正しいが意味が違う | NG |
 *
 * どの種類も、正解はデータの作り方から決まっていて、私の意見が入らない。
 *
 * ## 助詞の差し替えを不正解として使わない理由
 *
 * 最初は「助詞を一つ差し替え、コーパス 248,534 文に無い形だけ採る」で
 * 不正解を作ろうとしたが、**出来上がった標本の半分近くが正しい日本語だった**：
 *
 *   彼女は鶏肉を買った。 → 彼女が鶏肉を買った。   （どちらも成立）
 *   一番高い車はいくら…  → 一番高い車がいくら…   （どちらも成立）
 *
 * コーパスに無いことは誤りの証明にならない、という限界がそのまま出た形。
 * は↔が は特に入れ替えても通ることが多い。誤った正解表を作って測っても
 * 数字は意味を持たないので、この種類は捨てた。
 *
 * 代わりに `ROLE_SWAP` を使う。日本語としては完全に正しく、**意味だけが
 * 変わる**ので、「文法だけ見て意味を見ていない」判定を検出できる。
 *
 * ## 限界（報告に必ず添えること）
 *
 * - `PARAPHRASE` は Tatoeba の対訳紐付けを信用している。紐付け自体が
 *   緩い場合、意味の離れた対が正例になりうる
 * - `MEANING` は易しすぎる。全体の正答率を押し上げるので、必ず種類ごとに読む
 * - `ROLE_SWAP` は稀に意味が保たれる（対称な動詞、似た名詞）
 *
 * ## 規則層で片付く分は数から外す
 *
 * 実運用では規則層（kuromoji）が先に判定し、そこで決まった分は模型を
 * 呼ばない。だから模型の成績は「**規則層が取りこぼした分**」で測らないと、
 * 実際の効き目とずれる。規則層が拾えた件数は別途報告する。
 */
import { writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../src/config/index.js';
import { createAnthropicClient } from '../src/agent/llm/index.js';
import { judgeComposition } from '../src/agent/composition.js';
import { createAnalyzer, detectGrammarIssues } from '../src/nlp/index.js';
import { TRANSLATED } from '../src/curriculum/sentences.js';

const CORPUS = join(process.cwd(), '.cache', 'tatoeba', 'jpn_sentences.tsv');
const OUT = join(process.cwd(), '.cache', 'judge-eval.json');

type Kind = 'PARAPHRASE' | 'ROLE_SWAP' | 'CONJUGATION' | 'MEANING';

interface Sample {
  kind: Kind;
  /** 正解。true = 受け入れるべき。 */
  expected: boolean;
  meaning: string;
  reference: string;
  written: string;
}

function stripTail(text: string): string {
  return text.replace(/[。．.！!？?\s]+$/u, '');
}

/** 決定的な擬似乱数。同じ引数なら同じ評価集になる。 */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

function normalizeZh(text: string): string {
  return text.replace(/[\s。，、．,.！!？?；;：:]/gu, '');
}

async function buildSamples(perKind: number): Promise<Sample[]> {
  if (!existsSync(CORPUS)) {
    throw new Error(
      `対照コーパスがありません: ${CORPUS}\n  pnpm build:sentences を一度実行してください`,
    );
  }
  const attested = new Set<string>();
  for (const line of (await readFile(CORPUS, 'utf8')).split('\n')) {
    const parts = line.split('\t');
    if (parts[2] !== undefined) attested.add(stripTail(parts[2]));
  }

  const random = seeded(20260814);
  const samples: Sample[] = [];

  // ── PARAPHRASE：同じ訳を持つ別の実在文。両方とも正しい。
  const byMeaning = new Map<string, typeof TRANSLATED>();
  for (const sentence of TRANSLATED) {
    const key = normalizeZh(sentence.zh ?? '');
    const list = byMeaning.get(key) ?? [];
    byMeaning.set(key, [...list, sentence]);
  }
  const pairs = [...byMeaning.values()].filter((list) => list.length > 1);
  for (const list of shuffle(pairs, random).slice(0, perKind)) {
    const [a, b] = list;
    if (a?.zh === undefined || b === undefined) continue;
    // 表記が同じなら差にならない
    if (stripTail(a.text) === stripTail(b.text)) continue;
    samples.push({
      kind: 'PARAPHRASE',
      expected: true,
      meaning: a.zh,
      reference: a.text,
      written: b.text,
    });
  }

  // ── ROLE_SWAP：主語と目的語の名詞を入れ替える。
  //
  // 出来上がる文は日本語として正しい。正しくないのは**意味**で、
  // 与えた中国語と食い違う。文法だけ見て通す判定はここで落ちる。
  const roleSwaps: Sample[] = [];
  for (const sentence of shuffle(TRANSLATED, random)) {
    if (roleSwaps.length >= perKind) break;
    if (sentence.zh === undefined) continue;

    // [名詞A][が|は] … [名詞B][を] の形を探す
    const subject = sentence.tokens.findIndex(
      (t, i) =>
        t.p === '名詞' &&
        (sentence.tokens[i + 1]?.s === 'が' || sentence.tokens[i + 1]?.s === 'は'),
    );
    const object = sentence.tokens.findIndex(
      (t, i) => t.p === '名詞' && sentence.tokens[i + 1]?.s === 'を',
    );
    if (subject < 0 || object < 0 || subject === object) continue;
    const a = sentence.tokens[subject];
    const b = sentence.tokens[object];
    if (a === undefined || b === undefined || a.s === b.s) continue;

    const swapped = sentence.tokens
      .map((t, i) => (i === subject ? b.s : i === object ? a.s : t.s))
      .join('');
    if (swapped === sentence.text) continue;
    roleSwaps.push({
      kind: 'ROLE_SWAP',
      expected: false,
      meaning: sentence.zh,
      reference: sentence.text,
      written: swapped,
    });
  }
  samples.push(...roleSwaps);

  // ── CONJUGATION：終止形＋ます。規則で確実に誤りと言える。
  const conjugation: Sample[] = [];
  for (const sentence of shuffle(TRANSLATED, random)) {
    if (conjugation.length >= perKind) break;
    if (sentence.zh === undefined) continue;
    // 「〜ます」で終わる文の、直前の動詞を終止形に戻して ます を残す
    const last = sentence.tokens[sentence.tokens.length - 1];
    const verbIndex = sentence.tokens.findIndex(
      (t, i) => t.p === '動詞' && sentence.tokens[i + 1]?.s.startsWith('ま') === true,
    );
    if (verbIndex < 0 || last === undefined) continue;
    const verb = sentence.tokens[verbIndex];
    if (verb === undefined) continue;
    // 連用形（読み）を終止形（読む）に戻せる素直な形だけ扱う
    const dictionary = `${verb.s}る`;
    const broken = sentence.tokens
      .map((t, i) => (i === verbIndex ? dictionary : t.s))
      .join('');
    if (broken === sentence.text) continue;
    conjugation.push({
      kind: 'CONJUGATION',
      expected: false,
      meaning: sentence.zh,
      reference: sentence.text,
      written: broken,
    });
  }
  samples.push(...conjugation);

  // ── MEANING：別の訳を持つ実在文。日本語は正しいが意味が違う。
  const pool = shuffle(TRANSLATED, random);
  for (let i = 0; i < perKind && i * 2 + 1 < pool.length; i += 1) {
    const a = pool[i * 2];
    const b = pool[i * 2 + 1];
    if (a?.zh === undefined || b?.zh === undefined) continue;
    if (normalizeZh(a.zh) === normalizeZh(b.zh)) continue;
    samples.push({
      kind: 'MEANING',
      expected: false,
      meaning: a.zh,
      reference: a.text,
      written: b.text,
    });
  }

  return samples;
}

interface Outcome extends Sample {
  ruleCaught: boolean;
  modelSaid: boolean | undefined;
}

async function main(): Promise<void> {
  const perKind = Number.parseInt(process.argv[2] ?? '60', 10);
  console.log(`評価集を作ります（種類ごとに最大 ${String(perKind)} 件）\n`);

  const samples = await buildSamples(perKind);
  const counts = new Map<Kind, number>();
  for (const s of samples) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
  for (const [kind, n] of counts) console.log(`  ${kind.padEnd(12)} ${String(n)}`);
  console.log(`  合計 ${String(samples.length)}\n`);

  const silent = {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  } as never;
  const analyzer = createAnalyzer({ logger: silent, idleMs: 600_000 });
  const client = createAnthropicClient({
    apiKey: config.llm.apiKey,
    baseUrl: config.llm.baseUrl,
  });

  // ── 規則層。ここで決まる分は実運用でも模型を呼ばない。
  const outcomes: Outcome[] = [];
  for (const sample of samples) {
    let ruleCaught = false;
    try {
      ruleCaught = detectGrammarIssues(await analyzer.tokenize(sample.written)).length > 0;
    } catch {
      ruleCaught = false;
    }
    outcomes.push({ ...sample, ruleCaught, modelSaid: undefined });
  }
  analyzer.shutdown();

  const forModel = outcomes.filter((o) => !o.ruleCaught);
  console.log(
    `規則層が判定 ${String(outcomes.length - forModel.length)} 件 / 模型に回す ${String(forModel.length)} 件\n`,
  );

  // ── 模型。並列は 2 まで。5 並列では 3 分の 1 が返らず、単発では
  //     4 秒で返った——判定の失敗ではなく送信側の詰まりだった。
  const CONCURRENCY = Number.parseInt(process.env['EVAL_CONCURRENCY'] ?? '2', 10);
  const errors = new Map<string, number>();
  let done = 0;
  const queue = [...forModel];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        const item = queue.shift();
        if (item === undefined) return;
        const verdict = await Promise.race([
          judgeComposition(item, {
            client,
            model: config.llm.model,
            onError: (error, willRetry) => {
              if (willRetry) return;
              const key = String(error).slice(0, 80);
              errors.set(key, (errors.get(key) ?? 0) + 1);
            },
          }),
          new Promise<undefined>((r) => setTimeout(() => { r('TIMEOUT' as never); }, 120_000)),
        ]);
        if ((verdict as unknown) === 'TIMEOUT') {
          errors.set('TIMEOUT 120s', (errors.get('TIMEOUT 120s') ?? 0) + 1);
          item.modelSaid = undefined;
          done += 1;
          continue;
        }
        item.modelSaid = verdict?.ok;
        done += 1;
        if (done % 20 === 0) console.log(`  ${String(done)}/${String(forModel.length)}`);
      }
    }),
  );

  // ── 集計
  if (errors.size > 0) {
    console.log('\n判定できなかった理由');
    for (const [reason, n] of [...errors.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${reason}`);
    }
  }

  console.log('\n種類ごと');
  console.log('種類          件数  規則が判定  模型に回す  模型正解  判定不能');
  for (const kind of ['PARAPHRASE', 'ROLE_SWAP', 'CONJUGATION', 'MEANING'] as Kind[]) {
    const all = outcomes.filter((o) => o.kind === kind);
    if (all.length === 0) continue;
    const byRule = all.filter((o) => o.ruleCaught);
    const asked = all.filter((o) => !o.ruleCaught);
    const answered = asked.filter((o) => o.modelSaid !== undefined);
    const right = answered.filter((o) => o.modelSaid === o.expected);
    console.log(
      `${kind.padEnd(13)} ${String(all.length).padStart(4)}  ${String(byRule.length).padStart(9)}  ` +
      `${String(asked.length).padStart(9)}  ${String(right.length).padStart(7)}  ${String(asked.length - answered.length).padStart(7)}`,
    );
  }

  const negatives = outcomes.filter((o) => !o.expected);
  const positives = outcomes.filter((o) => o.expected);
  const negAsked = negatives.filter((o) => !o.ruleCaught && o.modelSaid !== undefined);
  const posAsked = positives.filter((o) => !o.ruleCaught && o.modelSaid !== undefined);
  const falseAccept = negAsked.filter((o) => o.modelSaid === true);
  const falseReject = posAsked.filter((o) => o.modelSaid === false);

  const pct = (a: number, b: number): string =>
    b === 0 ? '—' : `${((a / b) * 100).toFixed(1)}%`;

  console.log('\n模型に回った分での率');
  console.log(`  誤収率（誤りを OK と言う） ${String(falseAccept.length)}/${String(negAsked.length)} = ${pct(falseAccept.length, negAsked.length)}`);
  console.log(`  誤拒率（正しいのを NG と言う） ${String(falseReject.length)}/${String(posAsked.length)} = ${pct(falseReject.length, posAsked.length)}`);

  // 規則層が拾った分も含めた、実運用に近い見え方
  const negAll = negatives.filter((o) => o.ruleCaught || o.modelSaid !== undefined);
  const missedOverall = negatives.filter((o) => !o.ruleCaught && o.modelSaid === true);
  console.log('\n規則層と合わせた通し（実運用に近い）');
  console.log(`  誤りを通してしまう率 ${String(missedOverall.length)}/${String(negAll.length)} = ${pct(missedOverall.length, negAll.length)}`);

  console.log('\n誤収の実例（最大 8 件）');
  for (const o of falseAccept.slice(0, 8)) {
    console.log(`  [${o.kind}] ${o.written}`);
    console.log(`      手本 ${o.reference}  意味 ${o.meaning}`);
  }
  console.log('\n誤拒の実例（最大 8 件）');
  for (const o of falseReject.slice(0, 8)) {
    console.log(`  [${o.kind}] ${o.written}`);
    console.log(`      手本 ${o.reference}  意味 ${o.meaning}`);
  }

  await writeFile(OUT, JSON.stringify(outcomes, null, 2), 'utf8');
  console.log(`\n明細: ${OUT}`);
}

await main();
