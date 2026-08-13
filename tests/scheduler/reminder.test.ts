import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/observability/index.js';
import {
  createDailyReminder,
  decideReminder,
  type ReminderFacts,
} from '../../src/scheduler/reminder.js';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

function facts(overrides: Partial<ReminderFacts> = {}): ReminderFacts {
  return { dueCount: 0, newCount: 0, answeredToday: 0, ...overrides };
}

describe('decideReminder', () => {
  it('nudges when there is something to do', () => {
    const decision = decideReminder(facts({ dueCount: 7, newCount: 5 }));
    expect(decision.send).toBe(true);
    if (!decision.send) return;
    expect(decision.text).toContain('新假名 5 个');
    expect(decision.text).toContain('复习 7 个');
    expect(decision.text).toContain('/kana');
  });

  // 用が無いのに毎晩鳴らすと、通知を読まない習慣がつく。
  it('stays silent when there is nothing due', () => {
    const decision = decideReminder(facts());
    expect(decision.send).toBe(false);
    if (decision.send) return;
    expect(decision.reason).toBe('NOTHING_DUE');
  });

  it('stays silent when the learner already studied today', () => {
    const decision = decideReminder(
      facts({ dueCount: 9, newCount: 5, answeredToday: 3 }),
    );
    expect(decision.send).toBe(false);
    if (decision.send) return;
    expect(decision.reason).toBe('ALREADY_STUDIED');
  });

  it('mentions only the part that applies', () => {
    const onlyNew = decideReminder(facts({ newCount: 5 }));
    expect(onlyNew.send && onlyNew.text).toContain('新假名');
    expect(onlyNew.send && onlyNew.text).not.toContain('复习');

    const onlyDue = decideReminder(facts({ dueCount: 3 }));
    expect(onlyDue.send && onlyDue.text).toContain('复习');
    expect(onlyDue.send && onlyDue.text).not.toContain('新假名');
  });
});

describe('createDailyReminder', () => {
  function harness(options?: {
    collect?: () => Promise<ReminderFacts>;
    now?: Date;
  }) {
    const timers: { fn: () => void; ms: number }[] = [];
    const sent: string[] = [];
    const current = options?.now ?? new Date('2026-08-14T04:00:00Z'); // SG 12:00

    const reminder = createDailyReminder({
      logger: silentLogger,
      localTime: '20:30',
      timeZone: 'Asia/Singapore',
      collect: options?.collect ?? (() => Promise.resolve(facts({ dueCount: 3 }))),
      send: (text) => {
        sent.push(text);
        return Promise.resolve();
      },
      now: () => current,
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length as unknown as NodeJS.Timeout;
      },
      clearTimer: () => {},
    });
    return { reminder, timers, sent };
  }

  it('schedules the next occurrence rather than polling', () => {
    const { reminder, timers } = harness();
    reminder.start();
    expect(timers).toHaveLength(1);
    // SG 12:00 → 20:30 は 8 時間半後
    expect(timers[0]?.ms).toBe(8.5 * 60 * 60 * 1000);
    expect(reminder.scheduledFor()?.toISOString()).toBe(
      '2026-08-14T12:30:00.000Z',
    );
  });

  it('sends when the facts warrant it', async () => {
    const { reminder, sent } = harness();
    const decision = await reminder.runOnce();
    expect(decision?.send).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('复习 3 个');
  });

  it('sends nothing when there is nothing to do', async () => {
    const { reminder, sent } = harness({
      collect: () => Promise.resolve(facts()),
    });
    await reminder.runOnce();
    expect(sent).toEqual([]);
  });

  // 一日ぶん落とすのは仕方ないが、二度と鳴らなくなるのは困る。
  it('survives a failure while collecting and keeps the schedule', async () => {
    const { reminder, sent } = harness({
      collect: () => Promise.reject(new Error('db down')),
    });
    await expect(reminder.runOnce()).resolves.toBeUndefined();
    expect(sent).toEqual([]);

    reminder.start();
    expect(reminder.scheduledFor()).toBeDefined();
  });

  // 一度鳴って終わりでは「毎日」にならない。発火後に必ず組み直す。
  it('reschedules itself after firing', async () => {
    const { reminder, timers, sent } = harness();
    reminder.start();
    expect(timers).toHaveLength(1);

    timers[0]?.fn();
    // 発火は非同期。完了してから次の予定が組まれる。
    await vi.waitFor(() => {
      expect(timers).toHaveLength(2);
    });
    expect(sent).toHaveLength(1);
    // 同じ時刻に組み直している（時計は止めてあるので同じ遅延になる）
    expect(timers[1]?.ms).toBe(timers[0]?.ms);
  });

  // collect が投げてもタイマーは生き続けなければならない。
  it('reschedules even when the run failed', async () => {
    const { reminder, timers } = harness({
      collect: () => Promise.reject(new Error('db down')),
    });
    reminder.start();
    timers[0]?.fn();
    await vi.waitFor(() => {
      expect(timers).toHaveLength(2);
    });
  });

  it('does not reschedule after stop', async () => {
    const { reminder, timers } = harness();
    reminder.start();
    reminder.stop();
    timers[0]?.fn();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(timers).toHaveLength(1);
  });

  it('stops cleanly', () => {
    const { reminder } = harness();
    reminder.start();
    expect(reminder.scheduledFor()).toBeDefined();
    reminder.stop();
    expect(reminder.scheduledFor()).toBeUndefined();
  });

  it('does not schedule when the configured time is unparseable', () => {
    const timers: { fn: () => void; ms: number }[] = [];
    const reminder = createDailyReminder({
      logger: silentLogger,
      localTime: 'half past eight',
      timeZone: 'Asia/Singapore',
      collect: () => Promise.resolve(facts()),
      send: () => Promise.resolve(),
      now: () => new Date('2026-08-14T04:00:00Z'),
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return 1 as unknown as NodeJS.Timeout;
      },
      clearTimer: () => {},
    });
    reminder.start();
    expect(timers).toEqual([]);
    expect(reminder.scheduledFor()).toBeUndefined();
  });
});
