import {
  DOMAINS,
  DOMAIN_BY_ID,
  DOMAIN_VOCAB_BY_ID,
  domainVocabOf,
  domainVocabOfKey,
  type Domain,
  type DomainEntry,
} from '../curriculum/domainVocab.js';
import type { Random } from '../curriculum/quiz.js';
import type { ReviewOutcome } from '../curriculum/review.js';
import type { Executor } from '../db/repositories/executor.js';
import * as reviewQueue from '../db/repositories/reviewQueue.js';
import { applyReview, enqueueNew, type AppliedReview } from './review.js';
import { resolveDomainItemIds } from './domainSeed.js';

/**
 * 分野別語彙の駆動（商务谈判 / 高尔夫 / AI）。
 *
 * 主線（仮名 → N5 → N4）とは**別の線**として走る。DOMAIN 型なので
 * /today や /vocab の件数には混ざらない。
 *
 * ## 単語カードだけ
 *
 * 例文が無いので、読解・助詞穴埋め・語順・作文は作れない
 * （Tatoeba にこの三分野の文は品質タグと中文訳まで通すと 5 / 7 / 1 文）。
 * 出せるのは「語 → 意味」と「意味 → 語」の二択だけ。
 *
 * ## 出題は主線と同じ形
 *
 * 選択肢は**同じ分野の語**から採る。分野を跨いで混ぜると、
 * 「ゴルフの話に商談の語が混じっている」だけで消去法が通ってしまう。
 */

const DOMAIN_TYPE = 'DOMAIN' as const;

export interface DomainLessonOptions {
  readonly newPerDay: number;
  readonly maxReviews: number;
}

export interface DomainLesson {
  readonly domain: Domain;
  readonly newEntries: readonly DomainEntry[];
  readonly dueTotal: number;
  readonly progress: { introduced: number; total: number };
}

async function introducedIn(
  tx: Executor,
  learnerId: string,
  domainId: string,
): Promise<DomainEntry[]> {
  const keys = await reviewQueue.listIntroducedKeys(tx, learnerId, DOMAIN_TYPE);
  return keys
    .map((key) => domainVocabOfKey(key))
    .filter((entry): entry is DomainEntry => entry?.domain === domainId);
}

/** 分野ごとの進み具合。一覧画面に出す。 */
export async function domainOverview(
  tx: Executor,
  learnerId: string,
  now: Date,
): Promise<{ domain: Domain; introduced: number; total: number; due: number }[]> {
  const keys = await reviewQueue.listIntroducedKeys(tx, learnerId, DOMAIN_TYPE);
  const introduced = keys
    .map((key) => domainVocabOfKey(key))
    .filter((entry): entry is DomainEntry => entry !== undefined);
  // 期限は分野をまたいで一度に引き、こちらで振り分ける——分野ごとに
  // 問い合わせると三回 DB を起こすことになる（§9.1）。
  const due = await reviewQueue.listDue(tx, learnerId, now, 500, DOMAIN_TYPE);
  const dueByDomain = new Map<string, number>();
  for (const item of due) {
    const entry = domainVocabOfKey(item.knowledgeKey);
    if (entry === undefined) continue;
    dueByDomain.set(entry.domain, (dueByDomain.get(entry.domain) ?? 0) + 1);
  }

  return DOMAINS.map((domain) => ({
    domain,
    introduced: introduced.filter((entry) => entry.domain === domain.id).length,
    total: domainVocabOf(domain.id).length,
    due: dueByDomain.get(domain.id) ?? 0,
  }));
}

export async function planDomainSession(
  tx: Executor,
  learnerId: string,
  domainId: string,
  now: Date,
  options: DomainLessonOptions,
): Promise<DomainLesson | undefined> {
  const domain = DOMAIN_BY_ID.get(domainId);
  if (domain === undefined) return undefined;

  const introduced = await introducedIn(tx, learnerId, domainId);
  const have = new Set(introduced.map((entry) => entry.id));
  const all = domainVocabOf(domainId);

  const due = await reviewQueue.listDue(tx, learnerId, now, 500, DOMAIN_TYPE);
  const dueTotal = due.filter(
    (item) => domainVocabOfKey(item.knowledgeKey)?.domain === domainId,
  ).length;

  // 積み残しがあるうちは新しい語を足さない（主線と同じ判断）。
  const newEntries =
    dueTotal >= options.maxReviews
      ? []
      : all
          .filter((entry) => !have.has(entry.id))
          .slice(0, Math.max(0, options.newPerDay));

  return {
    domain,
    newEntries,
    dueTotal,
    progress: { introduced: introduced.length, total: all.length },
  };
}

export async function introduceDomainVocab(
  tx: Executor,
  learnerId: string,
  ids: readonly string[],
  now: Date,
): Promise<number> {
  if (ids.length === 0) return 0;
  const itemIds = await resolveDomainItemIds(tx, ids);
  const missing = ids.filter((id) => !itemIds.has(id));
  if (missing.length > 0) {
    throw new Error(
      `domain vocab not seeded in knowledge_items: ${missing.join(', ')} — run ensureDomainVocabSeeded first`,
    );
  }
  return enqueueNew(tx, learnerId, [...itemIds.values()], now);
}

/* ─────────────── 出題 ─────────────── */

export type DomainQuestionKind = 'WORD_TO_MEANING' | 'MEANING_TO_WORD';

export interface DomainOption {
  readonly entryId: string;
  readonly label: string;
}

export interface DomainQuestion {
  readonly kind: DomainQuestionKind;
  readonly targetId: string;
  readonly prompt: string;
  /** 語を見せる向きでは読みも出す。読めない字を当てさせない（§15）。 */
  readonly promptReading?: string;
  readonly options: readonly DomainOption[];
  /**
   * 正解として認める id。
   *
   * 同じ語義の語が同じ分野に複数あることがある（`アプローチ` と
   * `アプローチショット` はどちらも approach shot）。**どちらを選んでも
   * 正解**にしないと、分かっている学習者に ❌ を出す。
   */
  readonly correctIds: readonly string[];
}

function shuffle<T>(items: readonly T[], random: Random): T[] {
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

export function buildDomainQuestion(
  target: DomainEntry,
  options: { kind: DomainQuestionKind; optionCount: number; random: Random },
): DomainQuestion | undefined {
  // 誤答は同じ分野から採る。分野を跨ぐと「場違いなほう」を外すだけで当たる。
  const pool = domainVocabOf(target.domain);
  const label = (entry: DomainEntry): string =>
    options.kind === 'WORD_TO_MEANING' ? entry.meaning : entry.expression;

  const targetLabel = label(target);
  const usedLabels = new Set<string>([targetLabel]);
  const distractors: DomainEntry[] = [];
  for (const candidate of shuffle(pool, options.random)) {
    if (distractors.length >= Math.max(0, options.optionCount - 1)) break;
    if (candidate.id === target.id) continue;
    const text = label(candidate);
    // 表示が同じ選択肢を並べない（同義語が同分野に居ることがある）。
    if (text === '' || usedLabels.has(text)) continue;
    usedLabels.add(text);
    distractors.push(candidate);
  }
  if (distractors.length < options.optionCount - 1) return undefined;

  const chosen = shuffle([target, ...distractors], options.random);
  return {
    kind: options.kind,
    targetId: target.id,
    prompt: options.kind === 'WORD_TO_MEANING' ? target.expression : target.meaning,
    ...(options.kind === 'WORD_TO_MEANING' && target.reading !== target.expression
      ? { promptReading: target.reading }
      : {}),
    options: chosen.map((entry) => ({
      entryId: entry.id,
      label: label(entry),
    })),
    // 「正解は一つ」と決め打たない。同義語が混ざったときに黙って壊れる。
    correctIds: chosen
      .filter((entry) => entry.id === target.id || label(entry) === targetLabel)
      .map((entry) => entry.id),
  };
}

export interface DomainDrillQuestion {
  readonly question: DomainQuestion;
  readonly entry: DomainEntry;
  readonly reps: number;
}

/** 語を見せて意味を選ばせるのが先。慣れたら意味から語を選ばせる。 */
export function domainKindFor(reps: number): DomainQuestionKind {
  return reps <= 1 ? 'WORD_TO_MEANING' : 'MEANING_TO_WORD';
}

export async function nextDomainQuestion(
  tx: Executor,
  learnerId: string,
  domainId: string,
  now: Date,
  options: { optionCount: number; random: Random },
): Promise<DomainDrillQuestion | undefined> {
  const due = await reviewQueue.listDue(tx, learnerId, now, 500, DOMAIN_TYPE);
  const first = due.find(
    (item) => domainVocabOfKey(item.knowledgeKey)?.domain === domainId,
  );
  if (first === undefined) return undefined;
  const entry = domainVocabOfKey(first.knowledgeKey);
  if (entry === undefined) return undefined;

  const question = buildDomainQuestion(entry, {
    kind: domainKindFor(first.entry.reps),
    optionCount: options.optionCount,
    random: options.random,
  });
  if (question === undefined) return undefined;
  return { question, entry, reps: first.entry.reps };
}

/* ─────────────── 採点 ─────────────── */

/** コールバックに載せる文字列。64 バイト制限があるので短く。 */
export function encodeDomainAnswer(targetId: string, chosenId: string): string {
  return `dq:${targetId}:${chosenId}`;
}

export interface DecodedDomainAnswer {
  readonly targetId: string;
  readonly chosenId: string;
}

export function decodeDomainAnswer(
  data: string,
): DecodedDomainAnswer | undefined {
  // id は `分野#表記`。`:` は含まないので、前二つだけ切り出せばよい。
  const parts = data.split(':');
  if (parts.length !== 3 || parts[0] !== 'dq') return undefined;
  const [, targetId, chosenId] = parts;
  if (targetId === undefined || chosenId === undefined) return undefined;
  return { targetId, chosenId };
}

export interface GradedDomain {
  readonly correct: boolean;
  readonly target: DomainEntry;
  readonly chosen: DomainEntry | undefined;
  readonly applied: AppliedReview;
}

export async function gradeDomainAnswer(
  tx: Executor,
  learnerId: string,
  decoded: DecodedDomainAnswer,
  now: Date,
  requestRetention: number,
  responseMs?: number,
): Promise<GradedDomain | undefined> {
  const target = DOMAIN_VOCAB_BY_ID.get(decoded.targetId);
  if (target === undefined) return undefined;
  const chosen = DOMAIN_VOCAB_BY_ID.get(decoded.chosenId);

  // 同じ語義の別語を選んだ場合も正解。出題時と同じ規則で判定する。
  const correct =
    chosen !== undefined &&
    (chosen.id === target.id ||
      (chosen.domain === target.domain &&
        (chosen.meaning === target.meaning ||
          chosen.expression === target.expression)));

  const outcome: ReviewOutcome = correct
    ? {
        kind: 'CORRECT',
        hinted: false,
        inputMode: 'CHOICE',
        ...(responseMs === undefined ? {} : { responseMs }),
      }
    : { kind: 'INCORRECT' };

  const itemIds = await resolveDomainItemIds(tx, [target.id]);
  const itemId = itemIds.get(target.id);
  if (itemId === undefined) {
    throw new Error(`domain vocab not seeded: ${target.id}`);
  }
  const applied = await applyReview(
    tx,
    learnerId,
    itemId,
    outcome,
    now,
    requestRetention,
  );
  return { correct, target, chosen, applied };
}
