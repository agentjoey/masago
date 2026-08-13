import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as helpers from './helpers.js';

try {
  process.loadEnvFile();
} catch {
  // CI 没有 .env：本文件全部用例跳过
}

const HAS_DB = Boolean(process.env['DATABASE_URL']);

type Modules = {
  db: (typeof import('../../src/db/index.js'))['db'];
  closeDb: (typeof import('../../src/db/index.js'))['closeDb'];
  telegramUpdatesRepo: typeof import('../../src/db/repositories/telegramUpdates.js');
  schema: typeof import('../../src/db/schema/index.js');
  config: (typeof import('../../src/config/index.js'))['config'];
  createHandleUpdate: (typeof import('../../src/sessions/index.js'))['createHandleUpdate'];
  handleIncomingMessage: (typeof import('../../src/sessions/index.js'))['handleIncomingMessage'];
  createBot: (typeof import('../../src/telegram/index.js'))['createBot'];
};

let modules: Modules | undefined;
let dbReachable = false;

const RUN = Date.now() % 1_000_000;
const ORCH_USER_ID = 9_100_000_000 + RUN;

/**
 * 本番の Telegram ユーザ id では絶対に走らせない。
 *
 * このテストは `config.telegram.allowedUserId` として更新を投げ、
 * 出来た learner profile を後片付けで削除する。`.env` を読んだ状態だと
 * その id は**実際の利用者**——つまり本人の学習記録を消しに行く。
 * 今日までは空の行だったので誰も気づかなかったが、復習キューが
 * 出来た途端に外部キーが削除を止めた。止めてくれたから助かった、では
 * 再発する。設定を読み込む前に合成 id へ差し替える。
 */
const TEST_ALLOWED_USER_ID = 9_300_000_000 + RUN;
process.env['ALLOWED_TELEGRAM_USER_ID'] = String(TEST_ALLOWED_USER_ID);

/** 後片付けで触ってよい id の範囲。合成 id は必ず 90 億台。 */
function isSyntheticUserId(telegramUserId: number): boolean {
  return telegramUserId >= 9_000_000_000;
}
const trackedUpdateIds: number[] = [];
const trackedLearnerIds: string[] = [];
const trackedSessionIds: string[] = [];

function uniqueId(offset: number): number {
  return 9_200_000_000 + RUN * 100 + offset;
}

function need(): Modules {
  if (modules === undefined) {
    throw new Error('database modules were not loaded');
  }
  return modules;
}

describe.skipIf(!HAS_DB)('telegram W3 integration (real database)', () => {
  beforeAll(async () => {
    const dbModule = await import('../../src/db/index.js');
    const telegramUpdatesRepo = await import(
      '../../src/db/repositories/telegramUpdates.js'
    );
    const schema = await import('../../src/db/schema/index.js');
    const { config } = await import('../../src/config/index.js');
    const { createHandleUpdate, handleIncomingMessage } = await import(
      '../../src/sessions/index.js'
    );
    const { createBot } = await import('../../src/telegram/index.js');
    modules = {
      db: dbModule.db,
      closeDb: dbModule.closeDb,
      telegramUpdatesRepo,
      schema,
      config,
      createHandleUpdate,
      handleIncomingMessage,
      createBot,
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
    if (dbReachable) {
      const sessionIds = new Set<string>(trackedSessionIds);
      const learnerIds = new Set<string>(trackedLearnerIds);
      const orchLearners = await db
        .select()
        .from(schema.learnerProfiles)
        .where(eq(schema.learnerProfiles.telegramUserId, ORCH_USER_ID));
      for (const learner of orchLearners) learnerIds.add(learner.id);
      if (learnerIds.size > 0) {
        const sessions = await db
          .select()
          .from(schema.sessions)
          .where(inArray(schema.sessions.learnerId, [...learnerIds]));
        for (const session of sessions) sessionIds.add(session.id);
      }
      if (sessionIds.size > 0) {
        await db
          .delete(schema.turns)
          .where(inArray(schema.turns.sessionId, [...sessionIds]));
        await db
          .delete(schema.sessions)
          .where(inArray(schema.sessions.id, [...sessionIds]));
      }
      if (trackedUpdateIds.length > 0) {
        await db
          .delete(schema.telegramUpdates)
          .where(inArray(schema.telegramUpdates.updateId, trackedUpdateIds));
      }
      if (learnerIds.size > 0) {
        // 二重の歯止め：合成 id 以外は何があっても消さない。
        // 上で差し替えた前提が将来崩れても、実データは巻き込まれない。
        const rows = await db
          .select()
          .from(schema.learnerProfiles)
          .where(inArray(schema.learnerProfiles.id, [...learnerIds]));
        const deletable = rows
          .filter((row) => isSyntheticUserId(row.telegramUserId))
          .map((row) => row.id);
        if (deletable.length !== rows.length) {
          throw new Error(
            'refusing to delete a real learner profile in teardown — ' +
              'the test must run under a synthetic telegram user id',
          );
        }
        if (deletable.length > 0) {
          await db
            .delete(schema.learnerProfiles)
            .where(inArray(schema.learnerProfiles.id, deletable));
        }
      }
    }
    await closeDb();
  }, 30_000);

  function makeBot() {
    const { config, createBot, createHandleUpdate, telegramUpdatesRepo, db } = need();
    const logger = helpers.fakeLogger();
    const handleUpdate = createHandleUpdate({ config, executor: db, logger });
    const bot = createBot({
      config,
      logger,
      handleUpdate,
      recordUpdate: async (updateId, payload) => {
        const result = await telegramUpdatesRepo.insertIfAbsent(db, updateId, payload);
        return result.inserted;
      },
    });
    const apiCalls = helpers.stubBotApi(bot);
    return { bot, apiCalls, logger };
  }

  it('processes an authorized text update end to end and echoes it back', async (t) => {
    if (!dbReachable) t.skip();
    const { db, schema, config } = need();
    const { bot, apiCalls } = makeBot();
    const updateId = uniqueId(1);
    const messageId = uniqueId(2);
    trackedUpdateIds.push(updateId);

    await bot.handleUpdate(
      helpers.textUpdate({
        updateId,
        userId: config.telegram.allowedUserId,
        messageId,
        text: 'こんにちは',
      }),
    );

    const sends = apiCalls.filter((c) => c.method === 'sendMessage');
    expect(sends).toHaveLength(1);
    expect((sends[0]?.payload as { text?: string }).text).toBe('echo: こんにちは');

    const updates = await db
      .select()
      .from(schema.telegramUpdates)
      .where(eq(schema.telegramUpdates.updateId, updateId));
    expect(updates).toHaveLength(1);

    const learners = await db
      .select()
      .from(schema.learnerProfiles)
      .where(eq(schema.learnerProfiles.telegramUserId, config.telegram.allowedUserId));
    const learner = learners[0];
    expect(learner).toBeDefined();
    if (learner) {
      trackedLearnerIds.push(learner.id);
      const sessions = await db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.learnerId, learner.id));
      for (const s of sessions) trackedSessionIds.push(s.id);
    }

    const turns = await db
      .select()
      .from(schema.turns)
      .where(eq(schema.turns.telegramMessageId, messageId));
    expect(turns).toHaveLength(1);
    expect(turns[0]?.replyText).toBe('echo: こんにちは');
    expect(turns[0]?.status).toBe('COMPLETED');
  }, 30_000);

  it('stores a repeated update_id exactly once and echoes exactly once', async (t) => {
    if (!dbReachable) t.skip();
    const { db, schema, config } = need();
    const { bot, apiCalls } = makeBot();
    const updateId = uniqueId(3);
    trackedUpdateIds.push(updateId);

    const update = helpers.textUpdate({
      updateId,
      userId: config.telegram.allowedUserId,
      messageId: uniqueId(4),
      text: '二度目',
    });
    await bot.handleUpdate(update);
    await bot.handleUpdate(update);

    const rows = await db
      .select()
      .from(schema.telegramUpdates)
      .where(eq(schema.telegramUpdates.updateId, updateId));
    expect(rows).toHaveLength(1);
    expect(apiCalls.filter((c) => c.method === 'sendMessage')).toHaveLength(1);
  }, 30_000);

  it('never writes telegram_updates for an unauthorized user', async (t) => {
    if (!dbReachable) t.skip();
    const { db, schema, config } = need();
    const { bot, apiCalls } = makeBot();
    const updateId = uniqueId(5);

    await bot.handleUpdate(
      helpers.textUpdate({
        updateId,
        userId: config.telegram.allowedUserId + 1,
        messageId: uniqueId(6),
        text: 'intruder',
      }),
    );

    const rows = await db
      .select()
      .from(schema.telegramUpdates)
      .where(eq(schema.telegramUpdates.updateId, updateId));
    expect(rows).toHaveLength(0);
    expect(apiCalls).toHaveLength(0);
  }, 30_000);

  it('runs a voice update through the voice pipeline with mocked providers', async (t) => {
    if (!dbReachable) t.skip();
    const { db, schema, config } = need();
    const { MockSttProvider } = await import('../../src/speech/stt/mock.js');
    const { MockTtsProvider } = await import('../../src/speech/tts/mock.js');
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const ttsOutputDir = await mkdtemp(join(tmpdir(), 'masago-it-tts-'));
    const workspaceBase = await mkdtemp(join(tmpdir(), 'masago-it-ws-'));
    try {
      const logger = helpers.fakeLogger();
      const stt = new MockSttProvider({ transcript: '昨日友達と映画を見るました' });
      const tts = new MockTtsProvider({ outputDir: ttsOutputDir });
      const tutorReply = '映画を見ましたね！';
      const handleUpdate = need().createHandleUpdate({
        config,
        executor: db,
        logger,
        voice: {
          stt,
          tts,
          tutor: {
            name: 'mock-llm',
            model: 'mock-tutor-1',
            respond: () =>
              Promise.resolve({
                replyText: tutorReply,
                provider: 'mock-llm',
                model: 'mock-tutor-1',
                usage: { inputTokens: 5, outputTokens: 5 },
              }),
          },
          normalizeAudio: (input) =>
            Promise.resolve({
              path: input.path,
              container: 'webm',
              codec: 'opus',
              transcoded: false,
            }),
          normalizeTranscript: (raw) =>
            Promise.resolve(raw.replace('見るました', '見ました')),
          createDownloader: () => ({
            async download(fileId, destPath) {
              void fileId;
              const bytes = Buffer.from('fake-ogg-opus');
              await writeFile(destPath, bytes);
              return { bytes: bytes.byteLength, container: 'ogg' };
            },
          }),
          workspaceOptions: { baseDir: workspaceBase },
        },
      });
      const bot = need().createBot({
        config,
        logger,
        handleUpdate,
        recordUpdate: async (updateId, payload) => {
          const result = await need().telegramUpdatesRepo.insertIfAbsent(
            db,
            updateId,
            payload,
          );
          return result.inserted;
        },
      });
      const apiCalls = helpers.stubBotApi(bot);

      const updateId = uniqueId(7);
      const messageId = uniqueId(8);
      trackedUpdateIds.push(updateId);
      await bot.handleUpdate(
        helpers.voiceUpdate({
          updateId,
          userId: config.telegram.allowedUserId,
          messageId,
        }),
      );

      expect(apiCalls.map((c) => c.method)).toEqual(['sendMessage', 'sendVoice']);
      expect((apiCalls[0]?.payload as { text?: string }).text).toBe(tutorReply);

      const turns = await db
        .select()
        .from(schema.turns)
        .where(eq(schema.turns.telegramMessageId, messageId));
      expect(turns).toHaveLength(1);
      expect(turns[0]?.status).toBe('COMPLETED');
      expect(turns[0]?.rawTranscript).toBe('昨日友達と映画を見るました');
      expect(turns[0]?.normalizedTranscript).toBe('昨日友達と映画を見ました');
      expect(turns[0]?.replyText).toBe(tutorReply);

      const learner = await db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.id, turns[0]?.sessionId ?? ''));
      for (const s of learner) trackedSessionIds.push(s.id);
    } finally {
      await rm(ttsOutputDir, { recursive: true, force: true });
      await rm(workspaceBase, { recursive: true, force: true });
    }
  }, 30_000);

  it('reuses the session within the idle window and opens a new one after it', async (t) => {
    if (!dbReachable) t.skip();
    const { db, schema, config, handleIncomingMessage } = need();
    const deps = { config, executor: db, logger: helpers.fakeLogger() };

    const first = await handleIncomingMessage(deps, {
      telegramUserId: ORCH_USER_ID,
      telegramMessageId: uniqueId(20),
      kind: 'text',
      text: '一つ目',
    });
    expect(first.newSession).toBe(true);
    trackedSessionIds.push(first.sessionId);

    const second = await handleIncomingMessage(deps, {
      telegramUserId: ORCH_USER_ID,
      telegramMessageId: uniqueId(21),
      kind: 'text',
      text: '二つ目',
    });
    expect(second.newSession).toBe(false);
    expect(second.sessionId).toBe(first.sessionId);

    const stale = new Date(Date.now() - (config.session.idleMinutes + 1) * 60_000);
    await db
      .update(schema.sessions)
      .set({ lastActivityAt: stale })
      .where(eq(schema.sessions.id, first.sessionId));

    const third = await handleIncomingMessage(deps, {
      telegramUserId: ORCH_USER_ID,
      telegramMessageId: uniqueId(22),
      kind: 'text',
      text: '三つ目',
    });
    expect(third.newSession).toBe(true);
    expect(third.sessionId).not.toBe(first.sessionId);
    trackedSessionIds.push(third.sessionId);

    const oldSessions = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, first.sessionId));
    expect(oldSessions[0]?.status).toBe('CLOSED');
  }, 30_000);
});
