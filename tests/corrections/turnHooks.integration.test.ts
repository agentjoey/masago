import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import type {
  CorrectionTurnHooks,
  NewPendingIssue,
  SurfacingConfig,
  SurfacingDirective,
} from '../../src/corrections/index.js';

process.loadEnvFile();

const { db, closeDb } = await import('../../src/db/index.js');
const schema = await import('../../src/db/schema/index.js');
const turnsRepo = await import('../../src/db/repositories/turns.js');
const detectedIssuesRepo = await import(
  '../../src/db/repositories/detectedIssues.js'
);
const { createCorrectionTurnHooks } = await import(
  '../../src/corrections/index.js'
);

const RUN = Date.now();
let telegramUserId = 9_300_000_000 + (RUN % 100_000);
let messageId = 8_300_000_000 + (RUN % 100_000);

const DEFAULT_CONFIG: SurfacingConfig = {
  surfaceAfterTurnsConversation: 4,
  surfaceAfterTurnsCoach: 1,
  surfaceMaxItems: 3,
  highImportanceThreshold: 2,
};

const createdSessionIds: string[] = [];
const createdLearnerIds: string[] = [];

function issueFor(
  turnSeq: number,
  overrides: Partial<NewPendingIssue> = {},
): NewPendingIssue {
  return {
    knowledgeKey: `wire_key_${turnSeq}_${RUN}`,
    original: `wire-original-${turnSeq}`,
    recommended: `wire-recommended-${turnSeq}`,
    reason: `reason-${turnSeq}`,
    naturalAlternative: null,
    importance: 'MEDIUM',
    ...overrides,
  };
}

async function createSession(mode: 'CONVERSATION' | 'COACH') {
  telegramUserId += 1;
  const [learner] = await db
    .insert(schema.learnerProfiles)
    .values({ telegramUserId })
    .returning();
  if (!learner) throw new Error('failed to create test learner');
  createdLearnerIds.push(learner.id);
  const [session] = await db
    .insert(schema.sessions)
    .values({ learnerId: learner.id, mode })
    .returning();
  if (!session) throw new Error('failed to create test session');
  createdSessionIds.push(session.id);
  return { learnerId: learner.id, sessionId: session.id };
}

async function simulateTurn(
  hooks: CorrectionTurnHooks,
  sessionId: string,
  turnSeq: number,
  issues: NewPendingIssue[],
  extras: { explicitRequest?: boolean; sessionEnding?: boolean } = {},
): Promise<SurfacingDirective> {
  messageId += 1;
  const turn = await turnsRepo.create(db, {
    sessionId,
    telegramMessageId: messageId,
    inputType: 'TEXT',
    rawTranscript: `wire turn ${turnSeq}`,
  });
  const directive = await hooks.prepareSurfacing({
    turnId: turn.id,
    sessionId,
    ...extras,
  });
  await hooks.finalizeSurfacing({
    turnId: turn.id,
    sessionId,
    directive,
    detectedIssues: issues,
  });
  return directive;
}

async function allIssues(sessionId: string) {
  return db
    .select()
    .from(schema.detectedIssues)
    .where(eq(schema.detectedIssues.sessionId, sessionId));
}

afterAll(async () => {
  for (const sessionId of createdSessionIds) {
    await db
      .delete(schema.detectedIssues)
      .where(eq(schema.detectedIssues.sessionId, sessionId));
    await db.delete(schema.turns).where(eq(schema.turns.sessionId, sessionId));
    await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
  }
  for (const learnerId of createdLearnerIds) {
    await db
      .delete(schema.learnerProfiles)
      .where(eq(schema.learnerProfiles.id, learnerId));
  }
  await closeDb();
});

describe('correction turn hooks wiring', () => {
  it('HOLDs turns 1-3 and SURFACEs turn 4 with default config; all detected issues are persisted', { timeout: 60000 }, async () => {
    const { sessionId, learnerId } = await createSession('CONVERSATION');
    const hooks = createCorrectionTurnHooks({
      executor: db,
      config: DEFAULT_CONFIG,
    });

    const d1 = await simulateTurn(hooks, sessionId, 1, [issueFor(1)]);
    const d2 = await simulateTurn(hooks, sessionId, 2, [issueFor(2)]);
    const d3 = await simulateTurn(hooks, sessionId, 3, [issueFor(3)]);
    expect(d1.action).toBe('HOLD');
    expect(d2.action).toBe('HOLD');
    expect(d3.action).toBe('HOLD');

    const rows = await allIssues(sessionId);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.surfacedAt === null)).toBe(true);

    const d4 = await simulateTurn(hooks, sessionId, 4, [issueFor(4)]);
    if (d4.action !== 'SURFACE') {
      throw new Error('turn 4 must SURFACE with default config');
    }
    expect(d4.requestRetry).toBe(true);
    expect(d4.issues).toHaveLength(3);
    expect(d4.issues.map((issue) => issue.original).sort()).toEqual([
      'wire-original-1',
      'wire-original-2',
      'wire-original-3',
    ]);

    const pending = await detectedIssuesRepo.listPending(db, learnerId);
    expect(pending.map((row) => row.original)).toEqual(['wire-original-4']);

    const surfaced = (await allIssues(sessionId)).filter(
      (row) => row.surfacedAt !== null,
    );
    expect(surfaced).toHaveLength(3);
    expect(surfaced.every((row) => row.retryStatus === 'REQUESTED')).toBe(true);
  });

  it('changes the rhythm with config only (SURFACE_AFTER_TURNS_CONVERSATION=2), no prompt change', { timeout: 60000 }, async () => {
    const { sessionId } = await createSession('CONVERSATION');
    const hooks = createCorrectionTurnHooks({
      executor: db,
      config: { ...DEFAULT_CONFIG, surfaceAfterTurnsConversation: 2 },
    });

    const d1 = await simulateTurn(hooks, sessionId, 1, [issueFor(1)]);
    expect(d1.action).toBe('HOLD');
    const d2 = await simulateTurn(hooks, sessionId, 2, [issueFor(2)]);
    if (d2.action !== 'SURFACE') {
      throw new Error('turn 2 must SURFACE when the threshold is 2');
    }
    expect(d2.issues.map((issue) => issue.original)).toEqual([
      'wire-original-1',
    ]);
  });

  it('Coach mode surfaces from the second turn with the same hooks and default config', { timeout: 60000 }, async () => {
    const { sessionId } = await createSession('COACH');
    const hooks = createCorrectionTurnHooks({
      executor: db,
      config: DEFAULT_CONFIG,
    });

    const d1 = await simulateTurn(hooks, sessionId, 1, [issueFor(1)]);
    expect(d1.action).toBe('HOLD');
    const d2 = await simulateTurn(hooks, sessionId, 2, [issueFor(2)]);
    expect(d2.action).toBe('SURFACE');
    const d3 = await simulateTurn(hooks, sessionId, 3, [issueFor(3)]);
    expect(d3.action).toBe('SURFACE');
  });

  it('reprocessing the same turn does not duplicate issues (idempotent finalize)', { timeout: 60000 }, async () => {
    const { sessionId } = await createSession('CONVERSATION');
    const hooks = createCorrectionTurnHooks({
      executor: db,
      config: DEFAULT_CONFIG,
    });

    messageId += 1;
    const turn = await turnsRepo.create(db, {
      sessionId,
      telegramMessageId: messageId,
      inputType: 'TEXT',
      rawTranscript: 'retry this turn',
    });
    const directive = await hooks.prepareSurfacing({
      turnId: turn.id,
      sessionId,
    });
    const finalize = () =>
      hooks.finalizeSurfacing({
        turnId: turn.id,
        sessionId,
        directive,
        detectedIssues: [issueFor(1)],
      });
    await finalize();
    await finalize();

    expect(await allIssues(sessionId)).toHaveLength(1);
  });

  it('SURFACEs immediately on explicit request and on session end (without retry)', { timeout: 60000 }, async () => {
    const { sessionId } = await createSession('CONVERSATION');
    const hooks = createCorrectionTurnHooks({
      executor: db,
      config: DEFAULT_CONFIG,
    });

    await simulateTurn(hooks, sessionId, 1, [issueFor(1)]);
    const d2 = await simulateTurn(hooks, sessionId, 2, [issueFor(2)], {
      explicitRequest: true,
    });
    if (d2.action !== 'SURFACE') {
      throw new Error('explicit request must SURFACE immediately');
    }
    expect(d2.issues.map((issue) => issue.original)).toEqual([
      'wire-original-1',
    ]);

    await simulateTurn(hooks, sessionId, 3, [issueFor(3)]);
    const d4 = await simulateTurn(hooks, sessionId, 4, [issueFor(4)], {
      sessionEnding: true,
    });
    if (d4.action !== 'SURFACE') {
      throw new Error('session end must SURFACE remaining issues');
    }
    expect(d4.requestRetry).toBe(false);
    expect(d4.issues.map((issue) => issue.original).sort()).toEqual([
      'wire-original-2',
      'wire-original-3',
    ]);
  });
});
