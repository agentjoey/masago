import { eq } from 'drizzle-orm';
import { telegramUpdates, type TelegramUpdate } from '../schema/ops.js';
import type { Executor } from './executor.js';

export interface InsertIfAbsentResult {
  inserted: boolean;
  record: TelegramUpdate;
}

export async function insertIfAbsent(
  tx: Executor,
  updateId: number,
  payload: unknown,
): Promise<InsertIfAbsentResult> {
  const rows = await tx
    .insert(telegramUpdates)
    .values({ updateId, payload })
    .onConflictDoNothing({ target: telegramUpdates.updateId })
    .returning();
  const inserted = rows[0];
  if (inserted) {
    return { inserted: true, record: inserted };
  }
  const [existing] = await tx
    .select()
    .from(telegramUpdates)
    .where(eq(telegramUpdates.updateId, updateId))
    .limit(1);
  if (!existing) {
    throw new Error('telegram_update missing after insert conflict');
  }
  return { inserted: false, record: existing };
}
