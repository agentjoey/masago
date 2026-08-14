import { kanaOfKey } from '../curriculum/kana.js';
import { kanaProgress } from '../curriculum/lessonPlan.js';
import { particleOfKey, particleProgress } from '../curriculum/particles.js';
import {
  spanLabel,
  type ReportFacts,
  type ReportPeriod,
  type ReportTrouble,
} from '../curriculum/report.js';
import { streakOf } from '../curriculum/render.js';
import { vocabOfKey } from '../curriculum/vocab.js';
import { vocabProgress } from '../curriculum/stage.js';
import type { Executor } from '../db/repositories/executor.js';
import * as learnerProfiles from '../db/repositories/learnerProfiles.js';
import * as learningEvents from '../db/repositories/learningEvents.js';
import * as reviewQueue from '../db/repositories/reviewQueue.js';
import { localDateKey } from '../scheduler/dailyTime.js';

/**
 * 週報・月報の材料を集める（§3.3 の事件列から数える）。
 *
 * 週に一度・月に一度しか呼ばれない。定期ポーリングではないので、
 * ここで数回問い合わせても Neon の compute には響かない（§9.1）。
 */

export interface ReportFactsDeps {
  readonly executor: Executor;
  readonly telegramUserId: number;
  readonly timeZone: string;
  /** 「まだ不安」に何項目まで挙げるか。 */
  readonly troubleLimit?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 知識項目の鍵を、学習者に見せる形に直す。 */
function labelOf(key: string): ReportTrouble | undefined {
  const kana = kanaOfKey(key);
  if (kana !== undefined) {
    return { label: kana.hiragana, hint: kana.romaji, failures: 0 };
  }
  const word = vocabOfKey(key);
  if (word !== undefined) {
    return {
      label: word.expression,
      hint: word.expression === word.reading ? word.meaning : word.reading,
      failures: 0,
    };
  }
  const particle = particleOfKey(key);
  if (particle !== undefined) {
    return { label: particle.surface, hint: particle.label, failures: 0 };
  }
  // 由来の分からない鍵は出さない。生の識別子を見せても意味が伝わらない。
  return undefined;
}

export async function collectReportFacts(
  deps: ReportFactsDeps,
  period: ReportPeriod,
  now: Date,
): Promise<ReportFacts | undefined> {
  const learner = await learnerProfiles.findByTelegramUserId(
    deps.executor,
    deps.telegramUserId,
  );
  // まだ一度も話しかけていない人に振り返りは送らない。
  if (learner === undefined) return undefined;

  const days = period === 'WEEK' ? 7 : 30;
  const since = new Date(now.getTime() - days * DAY_MS);
  const previousSince = new Date(since.getTime() - days * DAY_MS);

  const tally = await learningEvents.tallyBetween(
    deps.executor,
    learner.id,
    since,
    now,
  );
  const previous = await learningEvents.tallyBetween(
    deps.executor,
    learner.id,
    previousSince,
    since,
  );

  // 学習した日数と連続日数は、回答時刻から地域時間の日で数える。
  const stamps = await learningEvents.answerTimestampsSince(
    deps.executor,
    learner.id,
    // 連続日数は期間より前まで遡らないと切れ目が分からない。
    new Date(now.getTime() - Math.max(days, 60) * DAY_MS),
  );
  const byDay = new Map<string, number>();
  for (const stamp of stamps) {
    const key = localDateKey(stamp, deps.timeZone);
    byDay.set(key, (byDay.get(key) ?? 0) + 1);
  }
  const activeDays = [...byDay.keys()].filter(
    (key) => key >= localDateKey(since, deps.timeZone),
  ).length;
  const streak = streakOf(byDay, localDateKey(now, deps.timeZone), (key, back) =>
    localDateKey(
      new Date(new Date(`${key}T12:00:00Z`).getTime() - back * DAY_MS),
      deps.timeZone,
    ),
  );

  const spots = await learningEvents.troubleSpotsBetween(
    deps.executor,
    learner.id,
    since,
    now,
    (deps.troubleLimit ?? 3) * 3, // 見せられない鍵が混じるので多めに取る
  );
  const troubles: ReportTrouble[] = [];
  for (const spot of spots) {
    if (troubles.length >= (deps.troubleLimit ?? 3)) break;
    const label = labelOf(spot.knowledgeKey);
    if (label === undefined) continue;
    troubles.push({ ...label, failures: spot.failures });
  }

  /**
   * 導入済みの id を種別ごとに引く。分母は各 curriculum の
   * `*Progress` に任せる——ここで `.length` を読むと、向こうが
   * 「教える対象」を絞ったときに黙ってずれる（語彙で二度やった）。
   */
  const introducedIds = async (
    type: 'KANA' | 'VOCABULARY' | 'GRAMMAR',
    resolve: (key: string) => { id: string } | undefined,
  ): Promise<Set<string>> => {
    const keys = await reviewQueue.listIntroducedKeys(
      deps.executor,
      learner.id,
      type,
    );
    return new Set(
      keys
        .map((key) => resolve(key)?.id)
        .filter((id): id is string => id !== undefined),
    );
  };

  /**
   * 語彙の分母は `vocabProgress` から採る。
   *
   * `VOCAB.length` を直接使ってはいけない——接尾辞（`～円`『～分』など
   * 73 件）は単独では教えないので、進度の分母には入らない。数え方を
   * 二箇所に書いた結果、Mini App が 1301、週報が 1374 と**違う数字を
   * 出していた**（実機で発覚）。数え方は一箇所に置く。
   */
  const vocab = vocabProgress([
    ...(await introducedIds('VOCABULARY', vocabOfKey)),
  ]);
  const kana = kanaProgress([...(await introducedIds('KANA', kanaOfKey))]);
  const grammar = particleProgress(
    await introducedIds('GRAMMAR', particleOfKey),
  );

  return {
    period,
    span: spanLabel(since, now, deps.timeZone),
    answered: tally.answered,
    correct: tally.correct,
    introduced: tally.introduced,
    activeDays,
    streak,
    troubles,
    progress: { kana, vocab, grammar },
    dueNow: await reviewQueue.countDue(deps.executor, learner.id, now),
    previousAnswered: previous.answered,
  };
}
