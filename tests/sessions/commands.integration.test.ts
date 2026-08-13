import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SurfacingConfig } from '../../src/corrections/index.js';
import type {
  Tutor,
  TutorRequest,
  TutorResponse,
} from '../../src/sessions/voiceTurn.js';
import { fakeLogger } from '../telegram/helpers.js';

try {
  process.loadEnvFile();
} catch {
  // CI 没有 .env：本文件全部用例跳过
}

const HAS_DB = Boolean(process.env['DATABASE_URL']);

type Modules = {
  db: (typeof import('../../src/db/index.js'))['db'];
  closeDb: (typeof import('../../src/db/index.js'))['closeDb'];
  schema: typeof import('../../src/db/schema/index.js');
  turnsRepo: typeof import('../../src/db/repositories/turns.js');
  config: (typeof import('../../src/config/index.js'))['config'];
  createCommandHandlers: (typeof import('../../src/sessions/index.js'))['createCommandHandlers'];
  createCorrectionTurnHooks: (typeof import('../../src/corrections/index.js'))['createCorrectionTurnHooks'];
};

let modules: Modules | undefined;
let dbReachable = false;

const RUN = Date.now() % 1_000_000;
const trackedLearnerIds: string[] = [];

const SURFACING_CONFIG: SurfacingConfig = {
  surfaceAfterTurnsConversation: 4,
  surfaceAfterTurnsCoach: 1,
  surfaceMaxItems: 3,
  highImportanceThreshold: 2,
};

function need(): Modules {
  if (modules === undefined) {
    throw new Error('database modules were not loaded');
  }
  return modules;
}

function uniqueTelegramUserId(offset: number): number {
  return 9_400_000_000 + RUN * 10 + offset;
}

let messageIdSeq = 8_800_000_000 + RUN;
function nextMessageId(): number {
  messageIdSeq += 1;
  return messageIdSeq;
}

interface CapturedCall {
  request: TutorRequest;
}

function fakeTutor(response: Omit<TutorResponse, 'provider' | 'model' | 'usage'>) {
  const calls: CapturedCall[] = [];
  const tutor: Tutor = {
    name: 'mock-llm',
    model: 'mock-tutor-1',
    respond: (request) => {
      calls.push({ request });
      return Promise.resolve({
        ...response,
        provider: 'mock-llm',
        model: 'mock-tutor-1',
        usage: { inputTokens: 5, outputTokens: 5 },
      });
    },
  };
  return { tutor, calls };
}

function makeCommands(tutor: Tutor) {
  const { config, db, createCommandHandlers, createCorrectionTurnHooks } =
    need();
  return createCommandHandlers({
    config,
    executor: db,
    logger: fakeLogger(),
    tutor,
    corrections: createCorrectionTurnHooks({
      executor: db,
      config: SURFACING_CONFIG,
    }),
  });
}

async function insertPendingIssue(sessionId: string, original: string) {
  const { db, schema, turnsRepo } = need();
  const turn = await turnsRepo.create(db, {
    sessionId,
    telegramMessageId: nextMessageId(),
    inputType: 'TEXT',
    rawTranscript: `setup turn for ${original}`,
  });
  const [issue] = await db
    .insert(schema.detectedIssues)
    .values({
      turnId: turn.id,
      sessionId,
      knowledgeKey: `cmd_key_${original}_${RUN}`,
      original,
      recommended: `recommended-${original}`,
      reason: 'test',
      naturalAlternative: null,
      importance: 'MEDIUM',
    })
    .returning();
  if (issue === undefined) throw new Error('failed to insert pending issue');
  return issue;
}

async function activeSessionOf(telegramUserId: number) {
  const { db, schema } = need();
  const learners = await db
    .select()
    .from(schema.learnerProfiles)
    .where(eq(schema.learnerProfiles.telegramUserId, telegramUserId));
  const learner = learners[0];
  if (learner === undefined) throw new Error('learner not found');
  trackedLearnerIds.push(learner.id);
  const sessions = await db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.learnerId, learner.id));
  const session = sessions[sessions.length - 1];
  if (session === undefined) throw new Error('session not found');
  return { learner, session };
}

async function issueById(id: string) {
  const { db, schema } = need();
  const rows = await db
    .select()
    .from(schema.detectedIssues)
    .where(eq(schema.detectedIssues.id, id));
  return rows[0];
}

describe.skipIf(!HAS_DB)('session command handlers (real database)', () => {
  beforeAll(async () => {
    const dbModule = await import('../../src/db/index.js');
    const schema = await import('../../src/db/schema/index.js');
    const turnsRepo = await import('../../src/db/repositories/turns.js');
    const { config } = await import('../../src/config/index.js');
    const { createCommandHandlers } = await import(
      '../../src/sessions/index.js'
    );
    const { createCorrectionTurnHooks } = await import(
      '../../src/corrections/index.js'
    );
    modules = {
      db: dbModule.db,
      closeDb: dbModule.closeDb,
      schema,
      turnsRepo,
      config,
      createCommandHandlers,
      createCorrectionTurnHooks,
    };
    try {
      await modules.db.execute(sql`select 1`);
      dbReachable = true;
    } catch {
      dbReachable = false;
    }
  }, 30_000);

  afterAll(async () => {
    if (modules === undefined) return;
    const { db, schema, closeDb } = modules;
    if (dbReachable && trackedLearnerIds.length > 0) {
      const sessions = await db
        .select()
        .from(schema.sessions)
        .where(inArray(schema.sessions.learnerId, trackedLearnerIds));
      const sessionIds = sessions.map((row) => row.id);
      if (sessionIds.length > 0) {
        await db
          .delete(schema.detectedIssues)
          .where(inArray(schema.detectedIssues.sessionId, sessionIds));
        await db
          .delete(schema.turns)
          .where(inArray(schema.turns.sessionId, sessionIds));
        await db
          .delete(schema.sessions)
          .where(inArray(schema.sessions.id, sessionIds));
      }
      await db
        .delete(schema.learnerProfiles)
        .where(inArray(schema.learnerProfiles.id, trackedLearnerIds));
    }
    await closeDb();
  }, 30_000);

  it('/coach flushes pending corrections immediately and never surfaces the same issue twice', async (t) => {
    if (!dbReachable) t.skip();
    const userId = uniqueTelegramUserId(1);
    const { tutor, calls } = fakeTutor({
      replyText: '添削結果です。',
      correctionCard: '・X → Y',
    });
    const commands = makeCommands(tutor);

    // 建立会话（此时无 pending，不调用 tutor）
    const first = await commands.switchToCoach(userId, nextMessageId());
    expect(first).toContain('现在没有待呈现的纠错');
    expect(calls).toHaveLength(0);

    const { session } = await activeSessionOf(userId);
    expect(session.mode).toBe('COACH');
    const issue = await insertPendingIssue(session.id, 'cmd-original-1');

    // /coach 立即冲刷：explicitRequest 直达 tutor，呈现一次
    const second = await commands.switchToCoach(userId, nextMessageId());
    expect(second).toContain('添削結果です。');
    expect(second).toContain('・X → Y');
    expect(calls).toHaveLength(1);
    const directive = calls[0]?.request.surfacingDirective;
    if (directive?.action !== 'SURFACE') {
      throw new Error('explicit /coach request must SURFACE pending issues');
    }
    expect(directive.requestRetry).toBe(true);
    expect(directive.issues.map((row) => row.id)).toEqual([issue.id]);

    const surfaced = await issueById(issue.id);
    expect(surfaced?.surfacedAt).not.toBeNull();
    expect(surfaced?.retryStatus).toBe('REQUESTED');

    // 同一批 issue 不会被呈现两次
    const third = await commands.switchToCoach(userId, nextMessageId());
    expect(third).not.toContain('・X → Y');
    expect(third).toContain('现在没有待呈现的纠错');
    expect(calls).toHaveLength(1);
  }, 60_000);

  it('/end surfaces the remaining issues one last time with requestRetry=false and closes the session', async (t) => {
    if (!dbReachable) t.skip();
    const userId = uniqueTelegramUserId(2);
    const { tutor, calls } = fakeTutor({
      replyText: '今日のまとめです。',
      correctionCard: '・A → B',
    });
    const commands = makeCommands(tutor);

    await commands.switchToConversation(userId);
    const { session } = await activeSessionOf(userId);
    const issue = await insertPendingIssue(session.id, 'cmd-original-2');

    const reply = await commands.endSession(userId, nextMessageId());
    expect(reply).toContain('今日のまとめです。');
    expect(reply).toContain('・A → B');
    expect(calls).toHaveLength(1);
    const directive = calls[0]?.request.surfacingDirective;
    if (directive?.action !== 'SURFACE') {
      throw new Error('session end must SURFACE remaining issues');
    }
    expect(directive.requestRetry).toBe(false);
    expect(directive.issues.map((row) => row.id)).toEqual([issue.id]);

    // requestRetry=false → 不进入 retry 跟踪
    const surfaced = await issueById(issue.id);
    expect(surfaced?.surfacedAt).not.toBeNull();
    expect(surfaced?.retryStatus).toBe('NONE');

    const { schema, db } = need();
    const sessions = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, session.id));
    expect(sessions[0]?.status).toBe('CLOSED');

    // 会话已关闭，再次 /end 不会再呈现
    const again = await commands.endSession(userId, nextMessageId());
    expect(again).toBe('当前没有进行中的会话。');
    expect(calls).toHaveLength(1);
  }, 60_000);
});
