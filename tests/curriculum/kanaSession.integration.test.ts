import { eq, inArray } from 'drizzle-orm';
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
};

let modules: Modules | undefined;

function need(): Modules {
  if (modules === undefined) {
    throw new Error('database modules were not loaded');
  }
  return modules;
}

const RUN = Date.now();
const RETENTION = 0.9;
const DAY = 24 * 60 * 60 * 1000;
const OPTIONS = { newPerDay: 5, maxReviews: 20, backlogThreshold: 20 };

let learnerId = '';

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbModule = await import('../../src/db/index.js');
  const schema = await import('../../src/db/schema/index.js');
  const seed = await import('../../src/learning/kanaSeed.js');
  const session = await import('../../src/learning/kanaSession.js');
  modules = {
    db: dbModule.db,
    closeDb: dbModule.closeDb,
    schema,
    seed,
    session,
  };

  const { db } = need();
  await seed.ensureKanaSeeded(db);
  const [learner] = await db
    .insert(schema.learnerProfiles)
    .values({ telegramUserId: 9_500_000_000 + (RUN % 100_000) })
    .returning();
  if (!learner) throw new Error('failed to create test learner');
  learnerId = learner.id;
});

afterAll(async () => {
  if (modules === undefined) return;
  const { db, schema, closeDb } = need();
  if (learnerId !== '') {
    await db
      .delete(schema.reviewQueue)
      .where(eq(schema.reviewQueue.learnerId, learnerId));
    await db
      .delete(schema.learnerProfiles)
      .where(eq(schema.learnerProfiles.id, learnerId));
  }
  await closeDb();
});

describe.skipIf(!HAS_DB)('S0 kana session', () => {
  it(
    'walks a beginner from nothing through several days',
    { timeout: 180000 },
    async () => {
      const { db, session } = need();
      const day1 = new Date('2026-09-01T09:00:00Z');

      // 一日目：何も知らない状態から あ行
      const first = await session.planKanaLesson(
        db,
        learnerId,
        day1,
        OPTIONS,
      );
      expect(first.newKana.map((k) => k.id)).toEqual([
        'a',
        'i',
        'u',
        'e',
        'o',
      ]);
      expect(first.reviewKana).toEqual([]);
      expect(first.pool).toEqual([]);
      expect(first.progress).toEqual({ introduced: 0, total: 104 });

      const introduced = await session.introduceKana(
        db,
        learnerId,
        first.newKana.map((k) => k.id),
        day1,
      );
      expect(introduced).toBe(5);

      // 導入直後に同じ日の計画を引くと、もう新出は出ない
      const sameDay = await session.planKanaLesson(
        db,
        learnerId,
        day1,
        OPTIONS,
      );
      expect(sameDay.newKana.map((k) => k.id)).toEqual([
        'ka',
        'ki',
        'ku',
        'ke',
        'ko',
      ]);
      expect(sameDay.progress.introduced).toBe(5);
      expect(sameDay.pool.map((k) => k.id)).toEqual(['a', 'i', 'u', 'e', 'o']);

      // 全部正解して学習ステップを進める
      for (const kana of first.newKana) {
        await session.recordKanaAnswer(
          db,
          learnerId,
          kana.id,
          { kind: 'CORRECT', hinted: false, inputMode: 'CHOICE' },
          day1,
          RETENTION,
        );
      }

      // 翌日：あ行 が復習に出てくる
      const day2 = new Date(day1.getTime() + DAY);
      const second = await session.planKanaLesson(
        db,
        learnerId,
        day2,
        OPTIONS,
      );
      expect(second.reviewKana.map((k) => k.id).sort()).toEqual([
        'a',
        'e',
        'i',
        'o',
        'u',
      ]);
      expect(second.newKana.map((k) => k.id)).toEqual([
        'ka',
        'ki',
        'ku',
        'ke',
        'ko',
      ]);
      expect(second.dueTotal).toBe(5);
    },
  );

  it(
    'holds back new kana when reviews pile up',
    { timeout: 180000 },
    async () => {
      const { db, session } = need();
      const start = new Date('2026-10-01T09:00:00Z');

      // 導入だけして一度も答えない日を重ね、期日を溜める
      let at = start;
      for (let day = 0; day < 6; day += 1) {
        const plan = await session.planKanaLesson(db, learnerId, at, OPTIONS);
        if (plan.newKana.length > 0) {
          await session.introduceKana(
            db,
            learnerId,
            plan.newKana.map((k) => k.id),
            at,
          );
        }
        at = new Date(at.getTime() + DAY);
      }

      const backlogged = await session.planKanaLesson(db, learnerId, at, {
        ...OPTIONS,
        backlogThreshold: 10,
      });
      expect(backlogged.dueTotal).toBeGreaterThan(10);
      expect(backlogged.newHeldBackForBacklog).toBe(true);
      expect(backlogged.newKana).toEqual([]);
      // 復習そのものは止めない
      expect(backlogged.reviewKana.length).toBeGreaterThan(0);
    },
  );

  it(
    'refuses to introduce a kana that was never seeded',
    { timeout: 60000 },
    async () => {
      const { db, session } = need();
      await expect(
        session.introduceKana(db, learnerId, ['not_a_kana'], new Date()),
      ).rejects.toThrow(/not seeded/);
    },
  );

  it(
    'only counts kana, not other knowledge types',
    { timeout: 120000 },
    async () => {
      const { db, schema, session } = need();
      const now = new Date('2026-11-01T09:00:00Z');

      const [grammar] = await db
        .insert(schema.knowledgeItems)
        .values({ type: 'GRAMMAR', key: `grammar_probe_${RUN}` })
        .returning({ id: schema.knowledgeItems.id });
      if (grammar === undefined) throw new Error('failed to create item');

      const review = await import('../../src/learning/review.js');
      await review.enqueueNew(db, learnerId, [grammar.id], now);

      const plan = await session.planKanaLesson(db, learnerId, now, OPTIONS);
      for (const kana of plan.reviewKana) {
        expect(kana.id).not.toBe(`grammar_probe_${RUN}`);
      }
      // 文法項目が仮名の進捗に混ざっていない
      expect(plan.progress.total).toBe(104);
      expect(plan.progress.introduced).toBeLessThanOrEqual(104);

      await db
        .delete(schema.reviewQueue)
        .where(inArray(schema.reviewQueue.knowledgeItemId, [grammar.id]));
      await db
        .delete(schema.knowledgeItems)
        .where(eq(schema.knowledgeItems.id, grammar.id));
    },
  );
});
