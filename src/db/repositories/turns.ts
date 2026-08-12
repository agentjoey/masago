import { eq, sql } from 'drizzle-orm';
import { turns, type NewTurn, type Turn } from '../schema/session.js';
import type { turnStatus } from '../schema/enums.js';
import type { Executor } from './executor.js';

type TurnStatus = (typeof turnStatus.enumValues)[number];

export async function create(tx: Executor, input: NewTurn): Promise<Turn> {
  const [row] = await tx.insert(turns).values(input).returning();
  if (!row) {
    throw new Error('turns insert returned no row');
  }
  return row;
}

export async function updateStatus(
  tx: Executor,
  turnId: string,
  status: TurnStatus,
  patch: Partial<
    Pick<Turn, 'rawTranscript' | 'normalizedTranscript' | 'replyText' | 'error'>
  > = {},
): Promise<Turn> {
  const [row] = await tx
    .update(turns)
    .set({ status, ...patch, updatedAt: sql`now()` })
    .where(eq(turns.id, turnId))
    .returning();
  if (!row) {
    throw new Error('turns updateStatus matched no row');
  }
  return row;
}

export async function findById(
  tx: Executor,
  turnId: string,
): Promise<Turn | undefined> {
  const [row] = await tx
    .select()
    .from(turns)
    .where(eq(turns.id, turnId))
    .limit(1);
  return row;
}

export async function findByTelegramMessageId(
  tx: Executor,
  telegramMessageId: number,
): Promise<Turn | undefined> {
  const [row] = await tx
    .select()
    .from(turns)
    .where(eq(turns.telegramMessageId, telegramMessageId))
    .limit(1);
  return row;
}
