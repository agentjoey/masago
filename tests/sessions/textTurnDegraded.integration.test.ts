import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Logger } from '../../src/observability/index.js';

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
  textTurn: typeof import('../../src/sessions/textTurn.js');
};

let modules: Modules | undefined;
function need(): Modules {
  if (modules === undefined) throw new Error('modules were not loaded');
  return modules;
}

interface LogRecord {
  level: string;
  msg: string;
  fields?: Record<string, unknown>;
}

function fakeLogger(): Logger & { records: LogRecord[] } {
  const records: LogRecord[] = [];
  const make =
    (level: string) =>
    (msg: string, fields?: Record<string, unknown>) => {
      records.push({ level, msg, fields });
    };
  return {
    records,
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    debug: make('debug'),
  } as unknown as Logger & { records: LogRecord[] };
}

const RUN = Date.now();
let learnerId = '';
let sessionId = '';
let messageId = 7_700_000_000 + (RUN % 100_000);

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbModule = await import('../../src/db/index.js');
  const schema = await import('../../src/db/schema/index.js');
  const textTurn = await import('../../src/sessions/textTurn.js');
  modules = {
    db: dbModule.db,
    closeDb: dbModule.closeDb,
    schema,
    textTurn,
  };

  const { db } = need();
  const [learner] = await db
    .insert(schema.learnerProfiles)
    .values({ telegramUserId: 9_800_000_000 + (RUN % 100_000) })
    .returning();
  if (!learner) throw new Error('failed to create learner');
  learnerId = learner.id;
  const [session] = await db
    .insert(schema.sessions)
    .values({ learnerId: learner.id, mode: 'CONVERSATION' })
    .returning();
  if (!session) throw new Error('failed to create session');
  sessionId = session.id;
});

afterAll(async () => {
  if (modules === undefined) return;
  const { db, schema, closeDb } = need();
  if (sessionId !== '') {
    await db.delete(schema.turns).where(eq(schema.turns.sessionId, sessionId));
    await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
  }
  if (learnerId !== '') {
    await db
      .delete(schema.learnerProfiles)
      .where(eq(schema.learnerProfiles.id, learnerId));
  }
  await closeDb();
});

/** 何をしても投げるだけのチューター。 */
function throwingTutor(error: unknown) {
  return {
    respond: () => Promise.reject(error),
  } as unknown as Parameters<
    Modules['textTurn']['runTextTurn']
  >[0]['tutor'];
}

const corrections = {
  prepareSurfacing: () => Promise.resolve({ action: 'HOLD' as const }),
  finalizeSurfacing: () => Promise.resolve(),
} as unknown as Parameters<Modules['textTurn']['runTextTurn']>[0]['corrections'];

describe.skipIf(!HAS_DB)('text turn degradation', () => {
  it(
    'answers with a fallback instead of swallowing the message',
    { timeout: 60000 },
    async () => {
      const { db, schema, textTurn } = need();
      const logger = fakeLogger();
      messageId += 1;

      const error = Object.assign(
        new Error('tutor llm output failed schema validation'),
        {
          name: 'TutorOutputError',
          validationErrors: 'reply.japanese: Required',
        },
      );

      const result = await textTurn.runTextTurn(
        { executor: db, tutor: throwingTutor(error), corrections, logger },
        { sessionId, telegramMessageId: messageId, text: 'Hi Masami' },
      );

      expect(result.reply).toBe(textTurn.TUTOR_DEGRADED_REPLY);
      expect(result.degraded).toBe(true);

      // 学習者が読めるのは中国語のほう。両方入っていること。
      expect(result.reply).toContain('请再发一次');

      // ターンは未完了のまま残さない
      const [turn] = await db
        .select()
        .from(schema.turns)
        .where(eq(schema.turns.id, result.turnId));
      expect(turn?.status).toBe('FAILED');
      expect(turn?.replyText).toBe(textTurn.TUTOR_DEGRADED_REPLY);
    },
  );

  // 原因が残らないと、稀にしか出ない失敗は永遠に直せない。
  it(
    'records the validation detail so the failure can be diagnosed',
    { timeout: 60000 },
    async () => {
      const { db, textTurn } = need();
      const logger = fakeLogger();
      messageId += 1;

      const error = Object.assign(new Error('boom'), {
        name: 'TutorOutputError',
        validationErrors: 'detectedIssues.0.knowledgeKey: Invalid format',
      });

      await textTurn.runTextTurn(
        { executor: db, tutor: throwingTutor(error), corrections, logger },
        { sessionId, telegramMessageId: messageId, text: 'test' },
      );

      const record = logger.records.find((r) => r.msg === 'tutor turn degraded');
      expect(record).toBeDefined();
      expect(record?.level).toBe('error');
      expect(record?.fields?.['validationErrors']).toBe(
        'detectedIssues.0.knowledgeKey: Invalid format',
      );
    },
  );

  // 模型の失敗は検証エラーだけではない。切断も時間切れも同じく答えが無い。
  it(
    'degrades for any failure, not just schema validation',
    { timeout: 60000 },
    async () => {
      const { db, textTurn } = need();
      const logger = fakeLogger();
      messageId += 1;

      const result = await textTurn.runTextTurn(
        {
          executor: db,
          tutor: throwingTutor(new TypeError('fetch failed')),
          corrections,
          logger,
        },
        { sessionId, telegramMessageId: messageId, text: 'network down' },
      );

      expect(result.degraded).toBe(true);
      expect(result.reply).toBe(textTurn.TUTOR_DEGRADED_REPLY);
      expect(
        logger.records.some((r) => r.msg === 'tutor turn degraded'),
      ).toBe(true);
    },
  );

  it(
    'still completes normally when the tutor works',
    { timeout: 60000 },
    async () => {
      const { db, schema, textTurn } = need();
      messageId += 1;

      const workingTutor = {
        respond: () =>
          Promise.resolve({
            replyText: 'こんにちは！',
            correctionCard: null,
            detectedIssues: [],
          }),
      } as unknown as Parameters<
        Modules['textTurn']['runTextTurn']
      >[0]['tutor'];

      const result = await textTurn.runTextTurn(
        { executor: db, tutor: workingTutor, corrections, logger: fakeLogger() },
        { sessionId, telegramMessageId: messageId, text: 'ok' },
      );

      expect(result.degraded).toBeUndefined();
      expect(result.reply).toBe('こんにちは！');
      const [turn] = await db
        .select()
        .from(schema.turns)
        .where(eq(schema.turns.id, result.turnId));
      expect(turn?.status).toBe('COMPLETED');
    },
  );
});
