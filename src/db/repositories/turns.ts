import { and, eq, sql } from 'drizzle-orm';
import { detectedIssues, turns, type NewTurn, type Turn } from '../schema/session.js';
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

export async function setTelegramFileId(
  tx: Executor,
  turnId: string,
  telegramFileId: string,
): Promise<void> {
  await tx
    .update(turns)
    .set({ telegramFileId, updatedAt: sql`now()` })
    .where(eq(turns.id, turnId));
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

export async function countSessionTurnsSinceLastSurface(
  tx: Executor,
  sessionId: string,
): Promise<number> {
  const result = await tx.execute<{ count: number }>(sql`
    select count(*)::int as count
    from ${turns}
    where ${turns.sessionId} = ${sessionId}
      and ${turns.createdAt} > coalesce(
        (
          select max(${detectedIssues.surfacedAt})
          from ${detectedIssues}
          where ${detectedIssues.sessionId} = ${sessionId}
        ),
        '-infinity'::timestamptz
      )
  `);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('countSessionTurnsSinceLastSurface returned no row');
  }
  return row.count;
}

export async function countByTranscript(
  tx: Executor,
  sessionId: string,
  rawTranscript: string,
): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(turns)
    .where(
      and(
        eq(turns.sessionId, sessionId),
        eq(turns.rawTranscript, rawTranscript),
      ),
    );
  if (row === undefined) {
    throw new Error('countByTranscript returned no row');
  }
  return row.count;
}
