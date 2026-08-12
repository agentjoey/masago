import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { sessionMode } from '../schema/enums.js';
import {
  detectedIssues,
  sessions,
  turns,
  type DetectedIssue,
  type NewDetectedIssue,
} from '../schema/session.js';
import type { Executor } from './executor.js';

type SessionMode = (typeof sessionMode.enumValues)[number];
type Importance = DetectedIssue['importance'];

export async function insertMany(
  tx: Executor,
  issues: NewDetectedIssue[],
): Promise<DetectedIssue[]> {
  if (issues.length === 0) {
    return [];
  }
  return tx
    .insert(detectedIssues)
    .values(issues)
    .onConflictDoNothing({
      target: [
        detectedIssues.turnId,
        detectedIssues.knowledgeKey,
        detectedIssues.original,
      ],
    })
    .returning();
}

const IMPORTANCE_ORDER = sql`case when ${detectedIssues.importance} = 'HIGH' then 0 when ${detectedIssues.importance} = 'MEDIUM' then 1 else 2 end`;

export async function listPending(
  tx: Executor,
  learnerId: string,
): Promise<DetectedIssue[]> {
  const rows = await tx
    .select({ issue: detectedIssues })
    .from(detectedIssues)
    .innerJoin(sessions, eq(detectedIssues.sessionId, sessions.id))
    .where(
      and(eq(sessions.learnerId, learnerId), isNull(detectedIssues.surfacedAt)),
    )
    .orderBy(
      IMPORTANCE_ORDER,
      asc(detectedIssues.createdAt),
      asc(detectedIssues.id),
    );
  return rows.map((row) => row.issue);
}

export async function markSurfaced(
  tx: Executor,
  ids: string[],
  at?: Date,
  options: { retryRequested?: boolean } = {},
): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  await tx
    .update(detectedIssues)
    .set({
      surfacedAt: at ?? sql`now()`,
      ...(options.retryRequested === true
        ? { retryStatus: 'REQUESTED' as const }
        : {}),
    })
    .where(inArray(detectedIssues.id, ids));
}

export async function countPendingByImportance(
  tx: Executor,
  learnerId: string,
): Promise<Record<Importance, number>> {
  const rows = await tx
    .select({
      importance: detectedIssues.importance,
      count: sql<number>`count(*)::int`,
    })
    .from(detectedIssues)
    .innerJoin(sessions, eq(detectedIssues.sessionId, sessions.id))
    .where(
      and(eq(sessions.learnerId, learnerId), isNull(detectedIssues.surfacedAt)),
    )
    .groupBy(detectedIssues.importance);
  const result: Record<Importance, number> = { LOW: 0, MEDIUM: 0, HIGH: 0 };
  for (const row of rows) {
    result[row.importance] = row.count;
  }
  return result;
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
