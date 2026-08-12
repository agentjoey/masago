import { describe, expect, it } from 'vitest';
import {
  localDayKey,
  localWeekKey,
  summarizeUsage,
  type AggregatableUsageRecord,
} from '../../src/usage/aggregate.js';

const TZ = 'Asia/Singapore';

function record(overrides: Partial<AggregatableUsageRecord> = {}): AggregatableUsageRecord {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    operation: 'llm',
    estimatedCost: '1.000000',
    success: true,
    createdAt: new Date('2026-08-21T02:00:00Z'),
    ...overrides,
  };
}

describe('localDayKey', () => {
  it('uses the user timezone, not UTC', () => {
    const lateUtc = new Date('2026-08-20T17:00:00Z');
    expect(lateUtc.toISOString().slice(0, 10)).toBe('2026-08-20');
    expect(localDayKey(lateUtc, TZ)).toBe('2026-08-21');
    expect(localDayKey(lateUtc, 'UTC')).toBe('2026-08-20');
  });
});

describe('localWeekKey', () => {
  it('weeks start on Monday in local time', () => {
    expect(localWeekKey(new Date('2026-08-17T00:00:00Z'), 'UTC')).toBe('2026-08-17');
    expect(localWeekKey(new Date('2026-08-16T23:59:00Z'), 'UTC')).toBe('2026-08-10');
    expect(localWeekKey(new Date('2026-08-21T02:00:00Z'), TZ)).toBe('2026-08-17');
  });
});

describe('summarizeUsage', () => {
  it('aggregates two records on different UTC days but the same local day into "today"', () => {
    const now = new Date('2026-08-21T06:00:00Z');
    const records = [
      record({ createdAt: new Date('2026-08-20T17:00:00Z'), estimatedCost: '0.500000' }),
      record({ createdAt: new Date('2026-08-21T02:00:00Z'), estimatedCost: '1.500000' }),
    ];

    const summary = summarizeUsage(records, { timezone: TZ, now });

    expect(summary.today.calls).toBe(2);
    expect(summary.today.costUsd).toBe(2);
    expect(summary.thisWeek.calls).toBe(2);
    expect(summary.thisMonth.calls).toBe(2);
  });

  it('a UTC-day-bucketed summary would split those records; ours does not', () => {
    const now = new Date('2026-08-21T06:00:00Z');
    const records = [
      record({ createdAt: new Date('2026-08-20T17:00:00Z') }),
      record({ createdAt: new Date('2026-08-21T02:00:00Z') }),
    ];
    const utcDays = new Set(records.map((r) => r.createdAt.toISOString().slice(0, 10)));
    expect(utcDays.size).toBe(2);

    const summary = summarizeUsage(records, { timezone: TZ, now });
    expect(summary.today.calls).toBe(2);
  });

  it('excludes records from other days / weeks / months', () => {
    const now = new Date('2026-08-21T06:00:00Z');
    const records = [
      record({ createdAt: new Date('2026-08-21T02:00:00Z') }),
      record({ createdAt: new Date('2026-08-10T02:00:00Z') }),
      record({ createdAt: new Date('2026-07-31T10:00:00Z') }),
    ];

    const summary = summarizeUsage(records, { timezone: TZ, now });

    expect(summary.today.calls).toBe(1);
    expect(summary.thisWeek.calls).toBe(1);
    expect(summary.thisMonth.calls).toBe(2);
  });

  it('counts failed calls in call counts and handles their cost correctly', () => {
    const now = new Date('2026-08-21T06:00:00Z');
    const records = [
      record({ success: false, estimatedCost: '0.000000' }),
      record({ success: false, estimatedCost: null }),
      record({ success: true, estimatedCost: '2.000000' }),
    ];

    const summary = summarizeUsage(records, { timezone: TZ, now });

    expect(summary.today.calls).toBe(3);
    expect(summary.today.failedCalls).toBe(2);
    expect(summary.today.unknownCostCalls).toBe(1);
    expect(summary.today.costUsd).toBe(2);
  });

  it('breaks down the month by provider / model / operation', () => {
    const now = new Date('2026-08-21T06:00:00Z');
    const records = [
      record({ estimatedCost: '2.000000' }),
      record({ estimatedCost: '1.000000' }),
      record({
        provider: 'minimax',
        model: 'speech-2.8-turbo',
        operation: 'tts',
        estimatedCost: '0.600000',
      }),
    ];

    const summary = summarizeUsage(records, { timezone: TZ, now });

    expect(summary.breakdownThisMonth).toHaveLength(2);
    const llmRow = summary.breakdownThisMonth.find((row) => row.provider === 'anthropic');
    const ttsRow = summary.breakdownThisMonth.find((row) => row.provider === 'minimax');
    expect(llmRow?.calls).toBe(2);
    expect(llmRow?.costUsd).toBe(3);
    expect(ttsRow?.calls).toBe(1);
    expect(ttsRow?.costUsd).toBeCloseTo(0.6, 6);
  });
});
