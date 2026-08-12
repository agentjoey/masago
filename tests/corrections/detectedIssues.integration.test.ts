import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.loadEnvFile();

const { db, closeDb } = await import('../../src/db/index.js');
const schema = await import('../../src/db/schema/index.js');
const turnsRepo = await import('../../src/db/repositories/turns.js');
const repo = await import('../../src/db/repositories/detectedIssues.js');

const RUN = Date.now();
const TELEGRAM_USER_ID = 9_100_000_000 + (RUN % 100_000);
const OTHER_TELEGRAM_USER_ID = 9_200_000_000 + (RUN % 100_000);
let messageId = 8_100_000_000 + (RUN % 100_000);

const created = {
  learnerId: '',
  otherLearnerId: '',
  sessionId: '',
  otherSessionId: '',
};

function nextMessageId(): number {
  messageId += 1;
  return messageId;
}

async function createTurn(sessionId: string) {
  return turnsRepo.create(db, {
    sessionId,
    telegramMessageId: nextMessageId(),
    inputType: 'TEXT',
    rawTranscript: 'テスト',
  });
}

function makeIssue(turnId: string, sessionId: string, seq: number) {
  return {
    turnId,
    sessionId,
    knowledgeKey: `key_${seq}_${RUN}`,
    original: `original-${seq}`,
    recommended: `recommended-${seq}`,
    reason: `reason-${seq}`,
    naturalAlternative: null,
    importance: 'MEDIUM' as const,
  };
}

beforeAll(async () => {
  const [learner] = await db
    .insert(schema.learnerProfiles)
    .values({ telegramUserId: TELEGRAM_USER_ID })
    .returning();
  if (!learner) throw new Error('failed to create test learner');
  created.learnerId = learner.id;
  const [session] = await db
    .insert(schema.sessions)
    .values({ learnerId: learner.id, mode: 'CONVERSATION' })
    .returning();
  if (!session) throw new Error('failed to create test session');
  created.sessionId = session.id;

  const [otherLearner] = await db
    .insert(schema.learnerProfiles)
    .values({ telegramUserId: OTHER_TELEGRAM_USER_ID })
    .returning();
  if (!otherLearner) throw new Error('failed to create other learner');
  created.otherLearnerId = otherLearner.id;
  const [otherSession] = await db
    .insert(schema.sessions)
    .values({ learnerId: otherLearner.id, mode: 'CONVERSATION' })
    .returning();
  if (!otherSession) throw new Error('failed to create other session');
  created.otherSessionId = otherSession.id;
});

afterAll(async () => {
  for (const sessionId of [created.sessionId, created.otherSessionId]) {
    if (!sessionId) continue;
    await db
      .delete(schema.detectedIssues)
      .where(eq(schema.detectedIssues.sessionId, sessionId));
    await db.delete(schema.turns).where(eq(schema.turns.sessionId, sessionId));
    await db
      .delete(schema.sessions)
      .where(eq(schema.sessions.id, sessionId));
  }
  for (const learnerId of [created.learnerId, created.otherLearnerId]) {
    if (!learnerId) continue;
    await db
      .delete(schema.learnerProfiles)
      .where(eq(schema.learnerProfiles.id, learnerId));
  }
  await closeDb();
});

describe('detectedIssues repository', () => {
  it('insertMany is idempotent per (turn_id, knowledge_key, original)', { timeout: 60000 }, async () => {
    const turn = await createTurn(created.sessionId);
    const issues = [
      makeIssue(turn.id, created.sessionId, 1),
      makeIssue(turn.id, created.sessionId, 2),
    ];

    const first = await repo.insertMany(db, issues);
    expect(first).toHaveLength(2);
    expect(first.every((row) => row.surfacedAt === null)).toBe(true);

    const second = await repo.insertMany(db, issues);
    expect(second).toHaveLength(0);

    const rows = await db
      .select()
      .from(schema.detectedIssues)
      .where(eq(schema.detectedIssues.turnId, turn.id));
    expect(rows).toHaveLength(2);
  });

  it('listPending returns only unsurfaced issues for the learner, HIGH first then oldest first', { timeout: 60000 }, async () => {
    const turn = await createTurn(created.sessionId);
    const base = Date.UTC(2026, 7, 2);
    await repo.insertMany(db, [
      { ...makeIssue(turn.id, created.sessionId, 10), importance: 'LOW', createdAt: new Date(base) },
      { ...makeIssue(turn.id, created.sessionId, 11), importance: 'HIGH', createdAt: new Date(base + 2000) },
      { ...makeIssue(turn.id, created.sessionId, 12), importance: 'MEDIUM', createdAt: new Date(base + 3000) },
      { ...makeIssue(turn.id, created.sessionId, 13), importance: 'HIGH', createdAt: new Date(base + 1000) },
    ]);
    const otherTurn = await createTurn(created.otherSessionId);
    await repo.insertMany(db, [
      makeIssue(otherTurn.id, created.otherSessionId, 14),
    ]);

    const pending = await repo.listPending(db, created.learnerId);
    const keys = pending.map((row) => row.knowledgeKey);
    expect(keys).toHaveLength(6);
    expect(keys.slice(0, 2)).toEqual([`key_13_${RUN}`, `key_11_${RUN}`]);
    expect(keys[2]).toBe(`key_12_${RUN}`);
    expect(keys.slice(2, 5)).toContain(`key_1_${RUN}`);
    expect(keys.slice(2, 5)).toContain(`key_2_${RUN}`);
    expect(keys[5]).toBe(`key_10_${RUN}`);
  });

  it('countPendingByImportance groups unsurfaced issues by importance', { timeout: 60000 }, async () => {
    const counts = await repo.countPendingByImportance(db, created.learnerId);
    expect(counts).toEqual({ HIGH: 2, MEDIUM: 3, LOW: 1 });

    const otherCounts = await repo.countPendingByImportance(
      db,
      created.otherLearnerId,
    );
    expect(otherCounts).toEqual({ HIGH: 0, MEDIUM: 1, LOW: 0 });
  });

  it('markSurfaced removes issues from pending and can flag retry tracking', { timeout: 60000 }, async () => {
    const pending = await repo.listPending(db, created.learnerId);
    const high = pending.filter((row) => row.importance === 'HIGH');
    expect(high).toHaveLength(2);

    await repo.markSurfaced(
      db,
      high.map((row) => row.id),
      new Date(),
      { retryRequested: true },
    );

    const after = await repo.listPending(db, created.learnerId);
    const afterKeys = after.map((row) => row.knowledgeKey);
    expect(afterKeys).toHaveLength(4);
    expect(afterKeys[0]).toBe(`key_12_${RUN}`);
    expect(afterKeys[3]).toBe(`key_10_${RUN}`);
    expect(afterKeys).not.toContain(`key_11_${RUN}`);
    expect(afterKeys).not.toContain(`key_13_${RUN}`);

    const surfacedIds = new Set(high.map((row) => row.id));
    const allRows = await db
      .select()
      .from(schema.detectedIssues)
      .where(eq(schema.detectedIssues.sessionId, created.sessionId));
    for (const row of allRows) {
      if (surfacedIds.has(row.id)) {
        expect(row.surfacedAt).not.toBeNull();
        expect(row.retryStatus).toBe('REQUESTED');
      } else {
        expect(row.surfacedAt).toBeNull();
        expect(row.retryStatus).toBe('NONE');
      }
    }

    const counts = await repo.countPendingByImportance(db, created.learnerId);
    expect(counts).toEqual({ HIGH: 0, MEDIUM: 3, LOW: 1 });
  });
});
