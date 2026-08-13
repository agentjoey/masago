/**
 * 毎日のリマインダ（V2 §9.1）。
 *
 * **DB を定期ポーリングしない。** プロセス内タイマーで、その日の指定時刻に
 * 一度だけ起きる。期日を探して回ると Neon の compute が一日中起きたままになり、
 * 月 100 CU-h の枠を焼く。一日一回の問い合わせなら無視できる。
 */
import type { Logger } from '../observability/index.js';
import { localDateKey, nextDailyOccurrence } from './dailyTime.js';

/** 送るかどうかを決めるのに要る事実だけ。 */
export interface ReminderFacts {
  /** 期日が来ている復習の件数。 */
  readonly dueCount: number;
  /** 今日これから導入できる新しい仮名の数。 */
  readonly newCount: number;
  /** その日すでに答えた項目の数。 */
  readonly answeredToday: number;
}

export type ReminderDecision =
  | { readonly send: false; readonly reason: 'ALREADY_STUDIED' | 'NOTHING_DUE' }
  | { readonly send: true; readonly text: string };

/**
 * 送るか黙るかを決める。
 *
 * 用が無いのに毎晩鳴らすと、通知を無視する習慣がつく。そうなると
 * 本当に必要な日の一通も読まれない。だから **やることが無い日と、
 * もう終えた日は黙る**。
 */
export function decideReminder(facts: ReminderFacts): ReminderDecision {
  if (facts.answeredToday > 0) {
    return { send: false, reason: 'ALREADY_STUDIED' };
  }
  if (facts.dueCount === 0 && facts.newCount === 0) {
    return { send: false, reason: 'NOTHING_DUE' };
  }

  const parts: string[] = [];
  if (facts.newCount > 0) {
    parts.push(`新假名 ${String(facts.newCount)} 个`);
  }
  if (facts.dueCount > 0) {
    parts.push(`复习 ${String(facts.dueCount)} 个`);
  }

  return {
    send: true,
    text: [
      '📖 今天还没练。',
      '',
      parts.join(' ・ '),
      '',
      '发 /kana 开始，大概 5 分钟。',
    ].join('\n'),
  };
}

export interface ReminderDeps {
  readonly logger: Logger;
  readonly localTime: string;
  readonly timeZone: string;
  /** リマインダ時点の事実を集める。DB に触るのはここだけ。 */
  readonly collect: (now: Date, localDay: string) => Promise<ReminderFacts>;
  readonly send: (text: string) => Promise<void>;
  readonly now?: () => Date;
  /** テストのために差し替える。既定は setTimeout。 */
  readonly setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  readonly clearTimer?: (timer: NodeJS.Timeout) => void;
}

export interface DailyReminder {
  start(): void;
  stop(): void;
  /** 次回の予定時刻。未起動なら undefined。 */
  scheduledFor(): Date | undefined;
  /** テスト用：予定を待たずに一度実行する。 */
  runOnce(): Promise<ReminderDecision | undefined>;
}

/**
 * setTimeout の遅延は 32 ビットに収まらないと即時発火になる（約 24.8 日）。
 * 一日先なら問題無いが、上限は明示しておく。
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

export function createDailyReminder(deps: ReminderDeps): DailyReminder {
  const now = deps.now ?? ((): Date => new Date());
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;

  let timer: NodeJS.Timeout | undefined;
  let scheduled: Date | undefined;
  let stopped = false;

  async function fire(): Promise<ReminderDecision | undefined> {
    const at = now();
    const localDay = localDateKey(at, deps.timeZone);
    try {
      const facts = await deps.collect(at, localDay);
      const decision = decideReminder(facts);
      if (decision.send) {
        await deps.send(decision.text);
        deps.logger.info('daily reminder sent', {
          localDay,
          dueCount: facts.dueCount,
          newCount: facts.newCount,
        });
      } else {
        deps.logger.info('daily reminder skipped', {
          localDay,
          reason: decision.reason,
        });
      }
      return decision;
    } catch (error) {
      // 一日ぶんのリマインダを落としても、次の予定は必ず組み直す。
      // ここで例外を上げるとタイマーが止まり、二度と鳴らなくなる。
      deps.logger.error('daily reminder failed', { localDay, error });
      return undefined;
    }
  }

  function schedule(): void {
    if (stopped) return;
    const at = now();
    const next = nextDailyOccurrence(at, {
      localTime: deps.localTime,
      timeZone: deps.timeZone,
    });
    if (next === undefined) {
      deps.logger.error('daily reminder disabled: unparseable time', {
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
    // 起動時に一度だけ、次にいつ鳴るかを残す。予定が狂っていたら
    // 翌日まで気づけないので、ログで確かめられるようにしておく。
    deps.logger.info('daily reminder scheduled', {
      at: next.toISOString(),
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
