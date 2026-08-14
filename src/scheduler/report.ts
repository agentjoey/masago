import {
  decideReport,
  type ReportDecision,
  type ReportFacts,
  type ReportPeriod,
} from '../curriculum/report.js';
import type { Logger } from '../observability/index.js';
import { localDateKey, nextWeeklyOccurrence } from './dailyTime.js';

/**
 * 週報・月報（V1.5）。
 *
 * 日次リマインダと同じ作りで、**DB を定期ポーリングしない**（§9.1）。
 * プロセス内タイマーが週に一度だけ起き、その時に一度だけ問い合わせる。
 *
 * 月報も同じタイマーに乗せる。月初を狙って別のタイマーを足すより、
 * 「毎週この曜日に起きて、月が変わっていたら月報も出す」ほうが
 * 動く部品が少ない——タイマーが二つあると、片方だけ死んでも気づけない。
 */

export interface ReportDeps {
  readonly logger: Logger;
  /** 0 = 日曜。利用者の地域時間での曜日。 */
  readonly weekday: number;
  readonly localTime: string;
  readonly timeZone: string;
  /** 事実を集める。DB に触るのはここだけ。 */
  readonly collect: (
    period: ReportPeriod,
    now: Date,
  ) => Promise<ReportFacts | undefined>;
  readonly send: (text: string) => Promise<void>;
  readonly now?: () => Date;
  readonly setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  readonly clearTimer?: (timer: NodeJS.Timeout) => void;
}

export interface ReportScheduler {
  start(): void;
  stop(): void;
  scheduledFor(): Date | undefined;
  /** テスト用：予定を待たずに一度実行する。 */
  runOnce(): Promise<ReportDecision[]>;
}

/** setTimeout の遅延は 32 ビットまで（約 24.8 日）。週なら収まる。 */
const MAX_TIMEOUT_MS = 2_147_483_647;

export function createReportScheduler(deps: ReportDeps): ReportScheduler {
  const now = deps.now ?? ((): Date => new Date());
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;

  let timer: NodeJS.Timeout | undefined;
  let scheduled: Date | undefined;
  let stopped = false;
  /** 最後に月報を出した月（"2026-08"）。同じ月に二度出さない。 */
  let lastMonthlySent: string | undefined;

  async function one(
    period: ReportPeriod,
    at: Date,
  ): Promise<ReportDecision | undefined> {
    const facts = await deps.collect(period, at);
    if (facts === undefined) return undefined;
    const decision = decideReport(facts);
    if (decision.send) {
      await deps.send(decision.text);
      deps.logger.info('report sent', {
        period,
        answered: facts.answered,
        troubles: facts.troubles.length,
      });
    } else {
      deps.logger.info('report skipped', { period, reason: decision.reason });
    }
    return decision;
  }

  async function fire(): Promise<ReportDecision[]> {
    const at = now();
    const decisions: ReportDecision[] = [];
    try {
      const weekly = await one('WEEK', at);
      if (weekly !== undefined) decisions.push(weekly);

      // 月が変わっていたら月報も。同じ月に二度は出さない。
      const month = localDateKey(at, deps.timeZone).slice(0, 7);
      if (lastMonthlySent !== month) {
        const monthly = await one('MONTH', at);
        if (monthly !== undefined) {
          decisions.push(monthly);
          lastMonthlySent = month;
        }
      }
    } catch (error) {
      // 一回落としても次の予定は必ず組み直す。ここで投げるとタイマーが
      // 止まり、二度と鳴らなくなる（日次リマインダと同じ）。
      deps.logger.error('report failed', { error });
    }
    return decisions;
  }

  function schedule(): void {
    if (stopped) return;
    const at = now();
    const next = nextWeeklyOccurrence(at, {
      weekday: deps.weekday,
      localTime: deps.localTime,
      timeZone: deps.timeZone,
    });
    if (next === undefined) {
      deps.logger.error('report disabled: unusable schedule', {
        weekday: deps.weekday,
        localTime: deps.localTime,
      });
      return;
    }
    scheduled = next;
    const delay = Math.min(
      Math.max(next.getTime() - at.getTime(), 0),
      MAX_TIMEOUT_MS,
    );
    timer = setTimer(() => {
      void fire().finally(() => {
        schedule();
      });
    }, delay);
    deps.logger.info('report scheduled', {
      at: next.toISOString(),
      weekday: deps.weekday,
      localTime: deps.localTime,
      timeZone: deps.timeZone,
    });
  }

  return {
    start() {
      stopped = false;
      schedule();
    },
    stop() {
      stopped = true;
      if (timer !== undefined) {
        clearTimer(timer);
        timer = undefined;
      }
      scheduled = undefined;
    },
    scheduledFor() {
      return scheduled;
    },
    runOnce: fire,
  };
}
