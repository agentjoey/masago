import { and, gte, lt } from 'drizzle-orm';
import {
  usageRecords,
  type NewUsageRecord,
  type UsageRecord,
} from '../schema/ops.js';
import type { Executor } from './executor.js';

export async function insert(
  tx: Executor,
  input: NewUsageRecord,
): Promise<UsageRecord> {
  const rows = await tx.insert(usageRecords).values(input).returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error('insert into usage_records returned no row');
  }
  return row;
}

export async function findCreatedBetween(
  tx: Executor,
  from: Date,
  to: Date,
): Promise<UsageRecord[]> {
  return tx
    .select()
    .from(usageRecords)
    .where(
      and(
        gte(usageRecords.createdAt, from),
        lt(usageRecords.createdAt, to),
      ),
    );
}
