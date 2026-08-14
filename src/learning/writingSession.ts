import {
  buildParticleBlank,
  buildWordOrder,
  judgeWordOrder,
  toChunks,
  usableForParticle,
  usableForWordOrder,
  type OrderVerdict,
} from '../curriculum/writing.js';
import {
  PARTICLES,
  PARTICLE_BY_ID,
  PARTICLE_BY_SURFACE,
  particleOfKey,
  type Particle,
} from '../curriculum/particles.js';
import type { Random } from '../curriculum/quiz.js';
import type { ReviewOutcome } from '../curriculum/review.js';
import {
  SENTENCES,
  SENTENCES_BY_ID,
  type Sentence,
} from '../curriculum/sentences.js';
import type { Executor } from '../db/repositories/executor.js';
import * as reviewQueue from '../db/repositories/reviewQueue.js';
import { applyReview, enqueueNew, type AppliedReview } from './review.js';
import { resolveParticleItemIds } from './particleSeed.js';

/**
 * 書く練習の駆動（docs/scenario-learning.md §5）。
 *
 * 出題も採点も、材料は人が書いた文そのもの。モデルは通らない——
 * 答えは元の文だから、判定に推測が要らない。
 *
 * 助詞の穴埋めは GRAMMAR 型の知識項に紐付けて FSRS で排程する。語順の
 * 並べ替えは特定の項目を測っていないので排程しない（詳細は
 * `nextWritingQuestion`）。
 *
 * 状態を持たないのは仮名・単語と同じ考え方。助詞の問題は選択肢のデータに、
 * 語順の問題は返信元の本文に、採点に要る情報が全部載っている。
 */

const GRAMMAR_TYPE = 'GRAMMAR' as const;

export type WritingKind = 'PARTICLE' | 'WORD_ORDER';

export interface WritingQuestion {
  readonly kind: WritingKind;
  readonly sentenceId: string;
  readonly prompt: string;
  /** 助詞問題の選択肢。語順問題では空。 */
  readonly options: readonly string[];
  /** 語順問題で並べ替える断片。助詞問題では空。 */
  readonly pieces: readonly string[];
  /** 助詞問題で問うている助詞。語順問題では undefined。 */
  readonly particle?: Particle;
  /** 助詞問題で空欄にしたトークンの位置。採点の鍵になる。 */
  readonly blankAt?: number;
}

/**
 * 既習の語彙で読める文だけを出す。
 *
 * 未習の語が混じった文で語順を練習させても、意味が取れないまま
 * 形だけ並べることになる。
 */
function pickSentence(
  known: ReadonlySet<string>,
  usable: (sentence: Sentence) => boolean,
  random: Random,
): Sentence | undefined {
  const pool = SENTENCES.filter(
    (sentence) =>
      usable(sentence) &&
      sentence.tokens.every(
        (token) =>
          token.p === '助詞' ||
          token.p === '助動詞' ||
          token.p === '記号' ||
          known.has(token.s) ||
          known.size === 0,
      ),
  );
  const source = pool.length > 0 ? pool : SENTENCES.filter(usable);
  if (source.length === 0) return undefined;
  const index = Math.min(
    source.length - 1,
    Math.floor(random() * source.length),
  );
  return source[index];
}

export interface WritingOptions {
  readonly optionCount: number;
  readonly random: Random;
  /** 既習の語（表記）。空なら全文から選ぶ。 */
  readonly known?: ReadonlySet<string>;
  /** この助詞を問う。復習で期限が来た項目を出すときに指定する。 */
  readonly particleId?: string;
}

/** 出題を一問組む。DB を見ない純粋な入り口（テストと Mini App が使う）。 */
export function buildWritingQuestion(
  kind: WritingKind,
  options: WritingOptions,
): WritingQuestion | undefined {
  const known = options.known ?? new Set<string>();
  if (kind === 'PARTICLE') {
    const sentence = pickSentence(
      known,
      (candidate) => usableForParticle(candidate, options.particleId),
      options.random,
    );
    if (sentence === undefined) return undefined;
    const blank = buildParticleBlank(sentence, {
      optionCount: options.optionCount,
      random: options.random,
      ...(options.particleId === undefined
        ? {}
        : { particleId: options.particleId }),
    });
    if (blank === undefined) return undefined;
    const particle = PARTICLE_BY_ID.get(blank.particleId);
    if (particle === undefined) return undefined;
    return {
      kind,
      sentenceId: sentence.id,
      prompt: blank.prompt,
      options: blank.options,
      pieces: [],
      particle,
      blankAt: blankIndexOf(sentence, blank.prompt),
    };
  }

  const sentence = pickSentence(known, usableForWordOrder, options.random);
  if (sentence === undefined) return undefined;
  const order = buildWordOrder(sentence, { random: options.random });
  if (order === undefined) return undefined;
  return {
    kind,
    sentenceId: sentence.id,
    prompt: order.pieces.join('　/　'),
    options: [],
    pieces: order.pieces,
  };
}

/**
 * 空欄にしたトークンの位置を、出題本文から割り出す。
 *
 * `buildParticleBlank` は本文しか返さないので、ここで復元する。
 * 位置さえ分かればコールバックに載せられて、採点の時に「どの助詞を
 * 訊いたか」を覚えておかずに済む。
 */
function blankIndexOf(sentence: Sentence, prompt: string): number | undefined {
  let offset = 0;
  for (const [index, token] of sentence.tokens.entries()) {
    const replaced = `${sentence.text.slice(0, offset)}＿${sentence.text.slice(offset + token.s.length)}`;
    if (replaced === prompt) return index;
    offset += token.s.length;
  }
  return undefined;
}

/* ─────────────── 導入と計画 ─────────────── */

export interface WritingLessonOptions {
  readonly newPerDay: number;
  readonly maxReviews: number;
}

export interface WritingLesson {
  /** 今日これから教える助詞。 */
  readonly newParticles: readonly Particle[];
  readonly dueTotal: number;
  readonly progress: { introduced: number; total: number };
}

async function introducedParticles(
  tx: Executor,
  learnerId: string,
): Promise<Particle[]> {
  const keys = await reviewQueue.listIntroducedKeys(tx, learnerId, GRAMMAR_TYPE);
  return keys
    .map((key) => particleOfKey(key))
    .filter((entry): entry is Particle => entry !== undefined);
}

export async function planWritingSession(
  tx: Executor,
  learnerId: string,
  now: Date,
  options: WritingLessonOptions,
): Promise<WritingLesson> {
  const introduced = await introducedParticles(tx, learnerId);
  const have = new Set(introduced.map((entry) => entry.id));
  const dueTotal = await reviewQueue.countDue(tx, learnerId, now, GRAMMAR_TYPE);

  // 積み残しがあるうちは新しい助詞を足さない。助詞は数が少ないので
  // 一気に入れられてしまうが、が/は の使い分けは一日では固まらない。
  const newParticles =
    dueTotal >= options.maxReviews
      ? []
      : PARTICLES.filter((entry) => !have.has(entry.id)).slice(
          0,
          Math.max(0, options.newPerDay),
        );

  return {
    newParticles,
    dueTotal,
    progress: { introduced: introduced.length, total: PARTICLES.length },
  };
}

export async function introduceParticles(
  tx: Executor,
  learnerId: string,
  particleIds: readonly string[],
  now: Date,
): Promise<number> {
  if (particleIds.length === 0) return 0;
  const itemIds = await resolveParticleItemIds(tx, particleIds);
  const missing = particleIds.filter((id) => !itemIds.has(id));
  if (missing.length > 0) {
    throw new Error(
      `particles not seeded in knowledge_items: ${missing.join(', ')} — run ensureParticlesSeeded first`,
    );
  }
  return enqueueNew(tx, learnerId, [...itemIds.values()], now);
}

/* ─────────────── 次の一問 ─────────────── */

/**
 * 期限の来た助詞があればそれを問う。無ければ語順の練習に回す。
 *
 * 語順は特定の知識項を測っていない——「私は本を読む」を正しく並べられても、
 * を を分かっている証拠にはならない（述語が最後、という別の規則で解ける）。
 * 測っていないものを FSRS に食わせると間隔が実力とずれるので、
 * 語順は排程せず、いつでもできる練習として置く。
 */
export async function nextWritingQuestion(
  tx: Executor,
  learnerId: string,
  now: Date,
  options: { optionCount: number; random: Random },
): Promise<WritingQuestion | undefined> {
  const due = await reviewQueue.listDue(tx, learnerId, now, 1, GRAMMAR_TYPE);
  const first = due[0];
  if (first !== undefined) {
    const particle = particleOfKey(first.knowledgeKey);
    if (particle !== undefined) {
      const question = buildWritingQuestion('PARTICLE', {
        ...options,
        particleId: particle.id,
      });
      if (question !== undefined) return question;
      // 材料が尽きた助詞は飛ばして語順へ。黙って何も返さないと、
      // 学習者からは「/write が無反応」に見える。
    }
  }
  return buildWritingQuestion('WORD_ORDER', options);
}

/* ─────────────── 採点 ─────────────── */

/** コールバックに載せる文字列。64 バイト制限があるので短く。 */
export function encodeParticleAnswer(
  sentenceId: string,
  blankAt: number,
  chosen: string,
): string {
  return `wp:${sentenceId}:${String(blankAt)}:${chosen}`;
}

export interface DecodedParticleAnswer {
  readonly sentenceId: string;
  readonly blankAt: number;
  readonly chosen: string;
}

export function decodeParticleAnswer(
  data: string,
): DecodedParticleAnswer | undefined {
  const parts = data.split(':');
  if (parts.length !== 4 || parts[0] !== 'wp') return undefined;
  const [, sentenceId, at, chosen] = parts;
  if (sentenceId === undefined || at === undefined || chosen === undefined) {
    return undefined;
  }
  const blankAt = Number.parseInt(at, 10);
  if (!Number.isInteger(blankAt) || blankAt < 0) return undefined;
  if (!SENTENCES_BY_ID.has(sentenceId)) return undefined;
  if (!PARTICLE_BY_SURFACE.has(chosen)) return undefined;
  return { sentenceId, blankAt, chosen };
}

export interface GradedParticle {
  readonly correct: boolean;
  /** 正解の助詞。 */
  readonly answer: Particle;
  /** 学習者が選んだ助詞。 */
  readonly chosen: Particle | undefined;
  readonly full: string;
  readonly applied: AppliedReview;
}

/**
 * 助詞の採点。出題を保持していないので、文 id と空欄の位置から組み直す。
 *
 * 元の文が答えなので、判定に推測は要らない。
 */
export async function gradeParticle(
  tx: Executor,
  learnerId: string,
  decoded: DecodedParticleAnswer,
  now: Date,
  requestRetention: number,
  responseMs?: number,
): Promise<GradedParticle | undefined> {
  const sentence = SENTENCES_BY_ID.get(decoded.sentenceId);
  const token = sentence?.tokens[decoded.blankAt];
  if (sentence === undefined || token === undefined) return undefined;
  const answer = PARTICLE_BY_SURFACE.get(token.s);
  if (answer === undefined) return undefined;

  const correct = decoded.chosen === token.s;
  const outcome: ReviewOutcome = correct
    ? {
        kind: 'CORRECT',
        hinted: false,
        inputMode: 'CHOICE',
        ...(responseMs === undefined ? {} : { responseMs }),
      }
    : { kind: 'INCORRECT' };

  const itemIds = await resolveParticleItemIds(tx, [answer.id]);
  const itemId = itemIds.get(answer.id);
  if (itemId === undefined) {
    throw new Error(`particle not seeded in knowledge_items: ${answer.id}`);
  }
  const applied = await applyReview(
    tx,
    learnerId,
    itemId,
    outcome,
    now,
    requestRetention,
  );

  return {
    correct,
    answer,
    chosen: PARTICLE_BY_SURFACE.get(decoded.chosen),
    full: sentence.text,
    applied,
  };
}

export interface OrderResult {
  readonly verdict: OrderVerdict;
  readonly answer: string;
  readonly full: string;
}

/**
 * 語順の採点。学習者が書き上げた文をそのまま受け取る。
 *
 * 空白や中黒は取り除いてから比べる——並べ替えの区切りとして
 * 入れてしまう人がいるが、それは誤りではない。
 */
export function gradeWordOrder(
  sentenceId: string,
  submittedText: string,
): OrderResult | undefined {
  const sentence = SENTENCES_BY_ID.get(sentenceId);
  if (sentence === undefined) return undefined;

  const submitted = stripSeparators(submittedText);
  const answer = stripSeparators(sentence.text);

  if (submitted === answer) {
    return { verdict: 'CORRECT', answer: sentence.text, full: sentence.text };
  }

  // 断片の並び替えとして解釈できるか。文節に割り直して判定する。
  const order = buildWordOrder(sentence, { random: () => 0.5 });
  if (order === undefined) {
    return { verdict: 'WRONG', answer: sentence.text, full: sentence.text };
  }
  const pieces = splitByChunks(submitted, order.answer);
  const verdict: OrderVerdict =
    pieces === undefined ? 'WRONG' : judgeWordOrder(order, pieces);
  return { verdict, answer: sentence.text, full: sentence.text };
}

function stripSeparators(text: string): string {
  return text.replace(/[\s　/／・|｜]/g, '');
}

/**
 * 提出された一続きの文を、正解の文節で切り直す。
 *
 * 学習者は区切りを付けずに書いてくるので、こちらで文節に戻さないと
 * 「並べ替えとして成立しているか」を判定できない。
 */
function splitByChunks(
  submitted: string,
  chunks: readonly string[],
): string[] | undefined {
  const remaining = [...chunks];
  const out: string[] = [];
  let rest = submitted;
  while (rest.length > 0) {
    const index = remaining.findIndex((chunk) => rest.startsWith(chunk));
    if (index < 0) return undefined;
    const chunk = remaining[index];
    if (chunk === undefined) return undefined;
    out.push(chunk);
    remaining.splice(index, 1);
    rest = rest.slice(chunk.length);
  }
  return remaining.length === 0 ? out : undefined;
}

/* ─────────────── 出題本文からの復元 ─────────────── */

/**
 * 語順の出題本文から、どの文を訊いたかを引き当てる。
 *
 * 断片の並びは毎回混ざるので、並び順に依らない鍵——文節を揃えて繋いだもの
 * ——で索引を作る。本文に id を書き込めば済むが、学習者に見せる文面に
 * 内部の識別子を混ぜたくない。
 */
let orderIndex: Map<string, string> | undefined;

function chunkKeyOf(pieces: readonly string[]): string {
  return [...pieces].sort().join(' ');
}

function buildOrderIndex(): Map<string, string> {
  const index = new Map<string, string>();
  for (const sentence of SENTENCES) {
    if (!usableForWordOrder(sentence)) continue;
    const key = chunkKeyOf(toChunks(sentence.tokens).map((chunk) => chunk.text));
    // 同じ文節の顔ぶれを持つ別の文は先に入ったほうを残す。並べ替えとしては
    // どちらも同じ問題になるので、取り違えても採点は変わらない。
    if (!index.has(key)) index.set(key, sentence.id);
  }
  return index;
}

export function sentenceOfOrderQuestion(text: string): string | undefined {
  orderIndex ??= buildOrderIndex();
  for (const line of text.split('\n')) {
    const pieces = line
      .split(/[/／]/)
      .map((piece) => piece.trim())
      .filter((piece) => piece !== '');
    if (pieces.length < 3) continue;
    const found = orderIndex.get(chunkKeyOf(pieces));
    if (found !== undefined) return found;
  }
  return undefined;
}
