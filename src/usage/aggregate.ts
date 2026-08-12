import { usdStringToMicroUsd } from './types.js';

export interface AggregatableUsageRecord {
  provider: string;
  model: string;
  operation: string;
  estimatedCost: string | null;
  success: boolean;
  createdAt: Date;
}

export interface UsageTotals {
  calls: number;
  failedCalls: number;
  costMicroUsd: number;
  costUsd: number;
  unknownCostCalls: number;
}

export interface UsageBreakdownRow extends UsageTotals {
  provider: string;
  model: string;
  operation: string;
}

export interface CostSummary {
  timezone: string;
  today: UsageTotals;
  thisWeek: UsageTotals;
  thisMonth: UsageTotals;
  breakdownThisMonth: UsageBreakdownRow[];
}

function emptyTotals(): UsageTotals {
  return { calls: 0, failedCalls: 0, costMicroUsd: 0, costUsd: 0, unknownCostCalls: 0 };
}

const dayFormatterCache = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = dayFormatterCache.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dayFormatterCache.set(timezone, formatter);
  }
  return formatter;
}

export function localDayKey(date: Date, timezone: string): string {
  return dayFormatter(timezone).format(date);
}

export function localWeekKey(date: Date, timezone: string): string {
  const dayKey = localDayKey(date, timezone);
  const [year, month, day] = dayKey.split('-').map(Number) as [number, number, number];
  const utcNoon = new Date(Date.UTC(year, month - 1, day, 12));
  const dayOfWeek = utcNoon.getUTCDay() === 0 ? 7 : utcNoon.getUTCDay();
  const monday = new Date(utcNoon.getTime() - (dayOfWeek - 1) * 86_400_000);
  return monday.toISOString().slice(0, 10);
}

export function localMonthKey(date: Date, timezone: string): string {
  return localDayKey(date, timezone).slice(0, 7);
}

function addRecord(totals: UsageTotals, record: AggregatableUsageRecord): void {
  totals.calls += 1;
  if (!record.success) {
    totals.failedCalls += 1;
  }
  if (record.estimatedCost === null) {
    totals.unknownCostCalls += 1;
  } else {
    totals.costMicroUsd += usdStringToMicroUsd(record.estimatedCost);
  }
}

function finalize<T extends UsageTotals>(totals: T): T {
  totals.costUsd = totals.costMicroUsd / 1_000_000;
  return totals;
}

export function summarizeUsage(
  records: readonly AggregatableUsageRecord[],
  options: { timezone: string; now: Date },
): CostSummary {
  const { timezone, now } = options;
  const todayKey = localDayKey(now, timezone);
  const weekKey = localWeekKey(now, timezone);
  const monthKey = localMonthKey(now, timezone);

  const today = emptyTotals();
  const thisWeek = emptyTotals();
  const thisMonth = emptyTotals();
  const breakdown = new Map<string, UsageBreakdownRow>();

  for (const record of records) {
    const recordDay = localDayKey(record.createdAt, timezone);
    const recordWeek = localWeekKey(record.createdAt, timezone);
    const recordMonth = localMonthKey(record.createdAt, timezone);

    if (recordDay === todayKey) {
      addRecord(today, record);
    }
    if (recordWeek === weekKey) {
      addRecord(thisWeek, record);
    }
    if (recordMonth === monthKey) {
      addRecord(thisMonth, record);
      const key = `${record.provider}${record.model}${record.operation}`;
      let row = breakdown.get(key);
      if (row === undefined) {
        row = {
          provider: record.provider,
          model: record.model,
          operation: record.operation,
          ...emptyTotals(),
        };
        breakdown.set(key, row);
      }
      addRecord(row, record);
    }
  }

  return {
    timezone,
    today: finalize(today),
    thisWeek: finalize(thisWeek),
    thisMonth: finalize(thisMonth),
    breakdownThisMonth: [...breakdown.values()].map((row) => finalize(row)),
  };
}
