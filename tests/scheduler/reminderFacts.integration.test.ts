import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
  seed: typeof import('../../src/learning/kanaSeed.js');
  session: typeof import('../../src/learning/kanaSession.js');
  facts: typeof import('../../src/learning/reminderFacts.js');
};

let modules: Modules | undefined;
function need(): Modules {
  if (modules === undefined) throw new Error('modules were not loaded');
  return modules;
}

const RUN = Date.now();
const TELEGRAM_USER_ID = 9_950_000_000 + (RUN % 100_000);
const OPTIONS = { newPerDay: 5, maxReviews: 20, backlogThreshold: 20 };
let learnerId = '';

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbModule = await import('../../src/db/index.js');
  const schema = await import('../../src/db/schema/index.js');
  const seed = await import('../../src/learning/kanaSeed.js');
  const session = await import('../../src/learning/kanaSession.js');
  const facts = await import('../../src/learning/reminderFacts.js');
  modules = {
    db: dbModule.db,
    closeDb: dbModule.closeDb,
    schema,
    seed,
    session,
    facts,
  };
  const { db } = need();
  await seed.ensureKanaSeeded(db);
});

afterAll(async () => {
  if (modules === undefined) return;
  const { db, schema, closeDb } = need();
  if (learnerId !== '') {
    await db
      .delete(schema.learningEvents)
      .where(eq(schema.learningEvents.learnerId, learnerId));
    await db
      .delete(schema.reviewQueue)
      .where(eq(schema.reviewQueue.learnerId, learnerId));
    await db
      .delete(schema.learnerProfiles)
      .where(eq(schema.learnerProfiles.id, learnerId));
  }
  await closeDb();
});

const NOW = new Date('2026-08-14T12:30:00Z'); // SG 20:30
const DAY_START = new Date('2026-08-13T16:00:00Z'); // SG 当日 00:00

describe.skipIf(!HAS_DB)('reminder facts', () => {
  it(
    'says nothing is pending for someone who never started',
    { timeout: 60000 },
    async () => {
      const { db, facts } = need();
      const result = await facts.collectReminderFacts(
        { executor: db, telegramUserId: 1, ...OPTIONS },
        NOW,
        DAY_START,
      );
      expect(result).toEqual({ dueCount: 0, newCount: 0, answeredToday: 0 });
    },
  );

  it(
    'reports new kana for a learner who has not begun',
    { timeout: 60000 },
    async () => {
      const { db, schema, facts } = need();
      const [learner] = await db
        .insert(schema.learnerProfiles)
        .values({ telegramUserId: TELEGRAM_USER_ID })
        .returning();
      if (!learner) throw new Error('failed to create learner');
      learnerId = learner.id;

      const result = await facts.collectReminderFacts(
        { executor: db, telegramUserId: TELEGRAM_USER_ID, ...OPTIONS },
        NOW,
        DAY_START,
      );
      expect(result.newCount).toBe(5);
      expect(result.dueCount).toBe(0);
      expect(result.answeredToday).toBe(0);
    },
  );

  it(
    'counts due items after kana are introduced',
    { timeout: 60000 },
    async () => {
      const { db, session, facts } = need();
      await session.introduceKana(
        db,
        learnerId,
        ['a', 'i', 'u', 'e', 'o'],
        NOW,
      );

      const result = await facts.collectReminderFacts(
        { executor: db, telegramUserId: TELEGRAM_USER_ID, ...OPTIONS },
        NOW,
        DAY_START,
      );
      expect(result.dueCount).toBe(5);
      expect(result.answeredToday).toBe(0);
    },
  );

  // もう今日やった人に催促を送ると、通知を読まない習慣がつく。
  it(
    'notices that the learner already studied today',
    { timeout: 60000 },
    async () => {
      const { db, session, facts } = need();
      await session.recordKanaAnswer(
        db,
        learnerId,
        'a',
        { kind: 'CORRECT', hinted: false, inputMode: 'CHOICE' },
        NOW,
        0.9,
      );

      const result = await facts.collectReminderFacts(
        { executor: db, telegramUserId: TELEGRAM_USER_ID, ...OPTIONS },
        NOW,
        DAY_START,
      );
      expect(result.answeredToday).toBe(1);
    },
  );

  // 昨日やった分を今日の実績に数えてはいけない。
  it(
    'does not count yesterday’s practice as today’s',
    { timeout: 60000 },
    async () => {
      const { db, facts } = need();
      const tomorrowStart = new Date('2026-08-14T16:00:00Z'); // 翌 SG 00:00
      const result = await facts.collectReminderFacts(
        { executor: db, telegramUserId: TELEGRAM_USER_ID, ...OPTIONS },
        new Date('2026-08-15T12:30:00Z'),
        tomorrowStart,
      );
      expect(result.answeredToday).toBe(0);
    },
  );
});
