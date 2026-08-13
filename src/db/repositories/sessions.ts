import { and, desc, eq, sql } from 'drizzle-orm';
import type { sessionMode } from '../schema/enums.js';
import {
  sessions,
  type NewSession,
  type Session,
} from '../schema/session.js';
import type { Executor } from './executor.js';

type SessionMode = (typeof sessionMode.enumValues)[number];

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

export async function setMode(
  tx: Executor,
  sessionId: string,
  mode: SessionMode,
): Promise<Session> {
  const [row] = await tx
    .update(sessions)
    .set({ mode, lastActivityAt: sql`now()` })
    .where(eq(sessions.id, sessionId))
    .returning();
  if (!row) {
    throw new Error('sessions setMode matched no row');
  }
  return row;
}

export interface SessionCorrectionContext {
  learnerId: string;
  mode: SessionMode;
}

export async function getSessionCorrectionContext(
  tx: Executor,
  sessionId: string,
): Promise<SessionCorrectionContext | undefined> {
  const [row] = await tx
    .select({ learnerId: sessions.learnerId, mode: sessions.mode })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return row;
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
