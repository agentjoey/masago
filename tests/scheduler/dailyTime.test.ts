import { describe, expect, it } from 'vitest';
import {
  localDateKey,
  nextDailyOccurrence,
  parseLocalTime,
  partsInZone,
  zonedWallClockToInstant,
} from '../../src/scheduler/dailyTime.js';

const SG = 'Asia/Singapore'; // UTC+8、夏時間なし
const NY = 'America/New_York'; // 夏時間あり

describe('parseLocalTime', () => {
  it('accepts a 24-hour wall clock', () => {
    expect(parseLocalTime('20:30')).toEqual({ hour: 20, minute: 30 });
    expect(parseLocalTime('00:00')).toEqual({ hour: 0, minute: 0 });
    expect(parseLocalTime('23:59')).toEqual({ hour: 23, minute: 59 });
    expect(parseLocalTime(' 9:05 ')).toEqual({ hour: 9, minute: 5 });
  });

  it('rejects anything that is not a valid time', () => {
    for (const bad of ['24:00', '20:60', '-1:00', '2030', '', 'abc', '20:3']) {
      expect(parseLocalTime(bad), bad).toBeUndefined();
    }
  });
});

describe('partsInZone', () => {
  it('reads the wall clock in the target zone', () => {
    // 2026-08-14T04:00Z は シンガポール（+8）で同日 12:00
    const parts = partsInZone(new Date('2026-08-14T04:00:00Z'), SG);
    expect(parts).toEqual({
      year: 2026,
      month: 8,
      day: 14,
      hour: 12,
      minute: 0,
    });
  });

  // 深夜を 24 時と返す実装があるため 0 に正規化している。
  it('normalises midnight to hour 0', () => {
    expect(partsInZone(new Date('2026-08-13T16:00:00Z'), SG).hour).toBe(0);
  });

  it('crosses the date line correctly', () => {
    // UTC ではまだ 13 日だが、シンガポールでは 14 日
    const parts = partsInZone(new Date('2026-08-13T20:00:00Z'), SG);
    expect(parts.day).toBe(14);
    expect(parts.hour).toBe(4);
  });
});

describe('zonedWallClockToInstant', () => {
  it('converts a local wall clock back to the right instant', () => {
    const instant = zonedWallClockToInstant(
      { year: 2026, month: 8, day: 14, hour: 20, minute: 30 },
      SG,
    );
    expect(instant.toISOString()).toBe('2026-08-14T12:30:00.000Z');
  });

  it('round-trips through the zone', () => {
    for (const iso of [
      '2026-01-01T00:00:00Z',
      '2026-06-15T12:00:00Z',
      '2026-12-31T23:59:00Z',
    ]) {
      const instant = new Date(iso);
      const parts = partsInZone(instant, SG);
      expect(zonedWallClockToInstant(parts, SG).toISOString()).toBe(
        instant.toISOString(),
      );
    }
  });

  // 夏時間のある地域では、素朴な足し引きは年二回だけ一時間ずれる。
  it('handles a zone with daylight saving on both sides of the change', () => {
    // 冬（EST, UTC-5）：20:30 → 翌 01:30Z
    expect(
      zonedWallClockToInstant(
        { year: 2026, month: 1, day: 15, hour: 20, minute: 30 },
        NY,
      ).toISOString(),
    ).toBe('2026-01-16T01:30:00.000Z');

    // 夏（EDT, UTC-4）：20:30 → 翌 00:30Z
    expect(
      zonedWallClockToInstant(
        { year: 2026, month: 7, day: 15, hour: 20, minute: 30 },
        NY,
      ).toISOString(),
    ).toBe('2026-07-16T00:30:00.000Z');
  });
});

describe('nextDailyOccurrence', () => {
  it('picks today when the time is still ahead', () => {
    const now = new Date('2026-08-14T04:00:00Z'); // SG 12:00
    const next = nextDailyOccurrence(now, { localTime: '20:30', timeZone: SG });
    expect(next?.toISOString()).toBe('2026-08-14T12:30:00.000Z'); // SG 20:30 同日
  });

  it('rolls to tomorrow once the time has passed', () => {
    const now = new Date('2026-08-14T13:00:00Z'); // SG 21:00、20:30 は過ぎている
    const next = nextDailyOccurrence(now, { localTime: '20:30', timeZone: SG });
    expect(next?.toISOString()).toBe('2026-08-15T12:30:00.000Z');
  });

  // 発火直後に次回を計算する。同時刻を「これから」と数えると同じ日に二度鳴る。
  it('never returns the current instant', () => {
    const exactly = new Date('2026-08-14T12:30:00Z'); // ちょうど SG 20:30
    const next = nextDailyOccurrence(exactly, {
      localTime: '20:30',
      timeZone: SG,
    });
    expect(next?.getTime()).toBeGreaterThan(exactly.getTime());
    expect(next?.toISOString()).toBe('2026-08-15T12:30:00.000Z');
  });

  it('crosses a month boundary', () => {
    const now = new Date('2026-08-31T13:00:00Z'); // SG 8/31 21:00
    const next = nextDailyOccurrence(now, { localTime: '20:30', timeZone: SG });
    expect(next?.toISOString()).toBe('2026-09-01T12:30:00.000Z');
  });

  it('crosses a year boundary', () => {
    const now = new Date('2026-12-31T13:00:00Z'); // SG 12/31 21:00
    const next = nextDailyOccurrence(now, { localTime: '20:30', timeZone: SG });
    expect(next?.toISOString()).toBe('2027-01-01T12:30:00.000Z');
  });

  it('is always in the future and within 24 hours', () => {
    const day = 24 * 60 * 60 * 1000;
    for (let offset = 0; offset < 48; offset += 1) {
      const now = new Date(Date.UTC(2026, 6, 1) + offset * 3_600_000);
      const next = nextDailyOccurrence(now, {
        localTime: '20:30',
        timeZone: NY,
      });
      expect(next, String(offset)).toBeDefined();
      if (next === undefined) continue;
      const delta = next.getTime() - now.getTime();
      expect(delta, String(offset)).toBeGreaterThan(0);
      expect(delta, String(offset)).toBeLessThanOrEqual(day + 3_600_000);
    }
  });

  it('returns nothing for an unparseable time', () => {
    expect(
      nextDailyOccurrence(new Date(), { localTime: 'noon', timeZone: SG }),
    ).toBeUndefined();
  });
});

describe('localDateKey', () => {
  it('uses the learner’s calendar day, not the server’s', () => {
    // UTC ではまだ 13 日だが、シンガポールではもう 14 日
    expect(localDateKey(new Date('2026-08-13T20:00:00Z'), SG)).toBe(
      '2026-08-14',
    );
    expect(localDateKey(new Date('2026-08-13T20:00:00Z'), 'UTC')).toBe(
      '2026-08-13',
    );
  });

  it('pads to a stable width', () => {
    expect(localDateKey(new Date('2026-01-05T04:00:00Z'), SG)).toBe(
      '2026-01-05',
    );
  });
});
