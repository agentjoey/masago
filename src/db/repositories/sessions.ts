import { and, desc, eq, sql } from 'drizzle-orm';
import {
  sessions,
  type NewSession,
  type Session,
} from '../schema/session.js';
import type { Executor } from './executor.js';

export async function findActiveByLearner(
  tx: Executor,
  learnerId: string,
): Promise<Session | undefined> {
  const [row] = await tx
    .select()
    .from(sessions)
    .where(and(eq(sessions.learnerId, learnerId), eq(sessions.status, 'ACTIVE')))
    .orderBy(desc(sessions.lastActivityAt))
    .limit(1);
  return row;
}

export async function create(
  tx: Executor,
  input: NewSession,
): Promise<Session> {
  const [row] = await tx.insert(sessions).values(input).returning();
  if (!row) {
    throw new Error('sessions insert returned no row');
  }
  return row;
}

export async function touch(tx: Executor, sessionId: string): Promise<void> {
  await tx
    .update(sessions)
    .set({ lastActivityAt: sql`now()` })
    .where(eq(sessions.id, sessionId));
}

export async function close(
  tx: Executor,
  sessionId: string,
  summary?: string,
): Promise<Session> {
  const [row] = await tx
    .update(sessions)
    .set({
      status: 'CLOSED',
      closedAt: sql`now()`,
      ...(summary !== undefined ? { summary } : {}),
    })
    .where(eq(sessions.id, sessionId))
    .returning();
  if (!row) {
    throw new Error('sessions close matched no row');
  }
  return row;
}
