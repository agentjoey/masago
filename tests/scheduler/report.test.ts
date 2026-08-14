import { describe, expect, it, vi } from 'vitest';
import {
  decideReport,
  spanLabel,
  type ReportFacts,
} from '../../src/curriculum/report.js';
import { createReportScheduler } from '../../src/scheduler/report.js';
import {
  nextWeeklyOccurrence,
  weekdayInZone,
} from '../../src/scheduler/dailyTime.js';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as never;

function facts(overrides: Partial<ReportFacts> = {}): ReportFacts {
  return {
    period: 'WEEK',
    span: '8月8日 - 8月14日',
    answered: 120,
    correct: 102,
    introduced: 15,
    activeDays: 6,
    streak: 6,
    troubles: [],
    progress: {
      kana: { introduced: 104, total: 104 },
      vocab: { introduced: 90, total: 1374 },
      grammar: { introduced: 6, total: 12 },
    },
    dueNow: 12,
    ...overrides,
  };
}

describe('nextWeeklyOccurrence', () => {
  it('finds the next occurrence of the weekday at the local time', () => {
    // 2026-08-14 は金曜。次の日曜 20:00（シンガポール）＝ 12:00 UTC。
    const next = nextWeeklyOccurrence(new Date('2026-08-14T04:00:00Z'), {
      weekday: 0,
      localTime: '20:00',
      timeZone: 'Asia/Singapore',
    });
    expect(next?.toISOString()).toBe('2026-08-16T12:00:00.000Z');
    expect(weekdayInZone(next as Date, 'Asia/Singapore')).toBe(0);
  });

  /**
   * ちょうど同時刻なら次の週。発火直後に次回を計算するので、
   * 「以上」にすると同じ瞬間を拾って二度鳴る。
   */
  it('skips to next week when called exactly at the scheduled instant', () => {
    const at = new Date('2026-08-16T12:00:00Z');
    const next = nextWeeklyOccurrence(at, {
      weekday: 0,
      localTime: '20:00',
      timeZone: 'Asia/Singapore',
    });
    expect(next?.toISOString()).toBe('2026-08-23T12:00:00.000Z');
  });

  it('keeps the wall-clock time across a daylight-saving change', () => {
    // ロンドンは 2026-10-25 に夏時間が終わる。前後どちらでも現地 20:00。
    for (const from of ['2026-10-20T00:00:00Z', '2026-10-27T00:00:00Z']) {
      const next = nextWeeklyOccurrence(new Date(from), {
        weekday: 0,
        localTime: '20:00',
        timeZone: 'Europe/London',
      });
      const shown = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(next as Date);
      expect(shown, from).toBe('20:00');
    }
  });

  it('refuses an unusable schedule instead of guessing', () => {
    const base = { localTime: '20:00', timeZone: 'Asia/Singapore' };
    expect(nextWeeklyOccurrence(new Date(), { ...base, weekday: 7 })).toBeUndefined();
    expect(nextWeeklyOccurrence(new Date(), { ...base, weekday: -1 })).toBeUndefined();
    expect(
      nextWeeklyOccurrence(new Date(), {
        weekday: 0,
        localTime: '25:00',
        timeZone: 'Asia/Singapore',
      }),
    ).toBeUndefined();
  });
});

describe('decideReport', () => {
  /** 用の無い通知は、通知を無視する習慣を育てる。 */
  it('stays quiet in a period where nothing happened', () => {
    const decision = decideReport(facts({ answered: 0, introduced: 0 }));
    expect(decision.send).toBe(false);
  });

  it('still reports a period where only new items were introduced', () => {
    const decision = decideReport(facts({ answered: 0, introduced: 5 }));
    expect(decision.send).toBe(true);
  });

  it('puts the accuracy next to the count', () => {
    const decision = decideReport(facts({ answered: 120, correct: 102 }));
    if (!decision.send) throw new Error('expected a report');
    expect(decision.text).toContain('做了 120 题');
    expect(decision.text).toContain('正确率 85%');
  });

  /**
   * 「今週 120 題」より「を と が が 7 回混ざった」のほうが、
   * 次に何をすればいいかが決まる。
   */
  it('names what is still shaky', () => {
    const decision = decideReport(
      facts({
        troubles: [
          { label: 'を', hint: '宾语：动作作用的对象', failures: 7 },
          { label: 'シ', hint: 'shi', failures: 4 },
        ],
      }),
    );
    if (!decision.send) throw new Error('expected a report');
    expect(decision.text).toContain('这些还不稳');
    expect(decision.text).toContain('を（宾语：动作作用的对象）错了 7 次');
    expect(decision.text).toContain('シ（shi）错了 4 次');
  });

  /**
   * 差を件数で出す。パーセントにすると 5 題 → 10 題が「+100%」になり、
   * 実態より大げさに見える。
   */
  it('compares with the previous period in plain counts', () => {
    const more = decideReport(facts({ answered: 120, previousAnswered: 90 }));
    if (!more.send) throw new Error('expected a report');
    expect(more.text).toContain('比上周多做了 30 题');

    const fewer = decideReport(facts({ answered: 60, previousAnswered: 90 }));
    if (!fewer.send) throw new Error('expected a report');
    expect(fewer.text).toContain('比上周少做了 30 题');

    const same = decideReport(facts({ answered: 90, previousAnswered: 90 }));
    if (!same.send) throw new Error('expected a report');
    expect(same.text).toContain('与上周持平');
  });

  it('says nothing about the trend when there is no previous period', () => {
    const decision = decideReport(facts({}));
    if (!decision.send) throw new Error('expected a report');
    expect(decision.text).not.toContain('比上周');
  });

  /** 始めたばかりの人に「比上周多做了 12 题」と出しても、比べる相手が無い。 */
  it('says nothing about the trend when the previous period was empty', () => {
    const decision = decideReport(facts({ answered: 12, previousAnswered: 0 }));
    if (!decision.send) throw new Error('expected a report');
    expect(decision.text).not.toContain('比上周');
    expect(decision.text).not.toContain('持平');
  });

  it('uses month wording for the monthly report', () => {
    const decision = decideReport(
      facts({ period: 'MONTH', previousAnswered: 90, answered: 120 }),
    );
    if (!decision.send) throw new Error('expected a report');
    expect(decision.text).toContain('🗓 本月小结');
    expect(decision.text).toContain('比上月多做了 30 题');
  });

  it('points at the next action', () => {
    const due = decideReport(facts({ dueNow: 12 }));
    if (!due.send) throw new Error('expected a report');
    expect(due.text).toContain('/review');

    const clear = decideReport(facts({ dueNow: 0 }));
    if (!clear.send) throw new Error('expected a report');
    expect(clear.text).toContain('/today');
  });
});

describe('spanLabel', () => {
  it('reads as a date range', () => {
    expect(
      spanLabel(
        new Date('2026-08-08T00:00:00Z'),
        new Date('2026-08-14T00:00:00Z'),
        'Asia/Singapore',
      ),
    ).toBe('8月8日 - 8月14日');
  });

  it('adds the year only when the range crosses one', () => {
    const label = spanLabel(
      new Date('2026-12-28T00:00:00Z'),
      new Date('2027-01-03T00:00:00Z'),
      'Asia/Singapore',
    );
    expect(label).toContain('2026年');
    expect(label).toContain('2027年');
  });
});

describe('createReportScheduler', () => {
  function scheduler(
    collect: ReturnType<typeof vi.fn>,
    send = vi.fn(),
    at = '2026-08-14T04:00:00Z',
  ) {
    return createReportScheduler({
      logger: silentLogger,
      weekday: 0,
      localTime: '20:00',
      timeZone: 'Asia/Singapore',
      collect,
      send,
      now: () => new Date(at),
      setTimer: (() => 0) as never,
      clearTimer: () => {},
    });
  }

  /**
   * 月報は「その月の最初の週次発火」（＝月初 7 日間）に相乗りする。
   * 日付だけで決まるので、プロセスが何度再起動しても揺れない。
   */
  it('adds the monthly report during the first week of the month', async () => {
    const send = vi.fn();
    const collect = vi.fn().mockResolvedValue(facts());
    // 2026-08-02 は 8 月最初の日曜。
    const decisions = await scheduler(collect, send, '2026-08-02T12:00:00Z').runOnce();
    expect(collect.mock.calls.map((call) => call[0])).toEqual(['WEEK', 'MONTH']);
    expect(decisions).toHaveLength(2);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('sends only the weekly report later in the month', async () => {
    const collect = vi.fn().mockResolvedValue(facts());
    await scheduler(collect, vi.fn(), '2026-08-14T04:00:00Z').runOnce();
    expect(collect.mock.calls.map((call) => call[0])).toEqual(['WEEK']);
  });

  /**
   * 再起動しても月報が重複しない。以前は「最後に送った月」をメモリに
   * 持っていて、**デプロイのたびに忘れて次の週次発火で毎回月報も
   * 送っていた**——このプロジェクトのデプロイ頻度だと月報がほぼ週報化する。
   */
  it('survives a restart without resending the monthly report', async () => {
    const collect = vi.fn().mockResolvedValue(facts());
    // 月の半ばで「再起動直後の別プロセス」を模す——状態は共有していない。
    await scheduler(collect, vi.fn(), '2026-08-14T04:00:00Z').runOnce();
    await scheduler(collect, vi.fn(), '2026-08-21T04:00:00Z').runOnce();
    expect(collect.mock.calls.map((call) => call[0])).toEqual(['WEEK', 'WEEK']);
  });

  it('says nothing when there is no learner yet', async () => {
    const send = vi.fn();
    const collect = vi.fn().mockResolvedValue(undefined);
    const decisions = await scheduler(collect, send).runOnce();
    expect(decisions).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  /**
   * 一回落としても次の予定は組み直す。ここで投げるとタイマーが止まり、
   * 二度と鳴らなくなる。
   */
  it('survives a failure without throwing', async () => {
    const collect = vi.fn().mockRejectedValue(new Error('db down'));
    await expect(scheduler(collect).runOnce()).resolves.toEqual([]);
  });

  it('reports when it will next fire', () => {
    const scheduled = scheduler(vi.fn().mockResolvedValue(facts()));
    expect(scheduled.scheduledFor()).toBeUndefined();
    scheduled.start();
    expect(scheduled.scheduledFor()?.toISOString()).toBe(
      '2026-08-16T12:00:00.000Z',
    );
    scheduled.stop();
    expect(scheduled.scheduledFor()).toBeUndefined();
  });
});
