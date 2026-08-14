import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KANA } from '../../src/curriculum/kana.js';

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
  data: typeof import('../../src/miniapp/data.js');
};
let modules: Modules | undefined;
function need(): Modules {
  if (modules === undefined) throw new Error('modules were not loaded');
  return modules;
}

const RUN = Date.now();
const NOW = new Date('2027-12-01T09:00:00Z');
let learnerId = '';

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbModule = await import('../../src/db/index.js');
  const schema = await import('../../src/db/schema/index.js');
  const seed = await import('../../src/learning/kanaSeed.js');
  const session = await import('../../src/learning/kanaSession.js');
  const data = await import('../../src/miniapp/data.js');
  modules = { db: dbModule.db, closeDb: dbModule.closeDb, schema, seed, session, data };
  const { db } = need();
  await seed.ensureKanaSeeded(db);
  const [learner] = await db
    .insert(schema.learnerProfiles)
    .values({ telegramUserId: 9_870_000_000 + (RUN % 100_000) })
    .returning();
  if (!learner) throw new Error('failed to create learner');
  learnerId = learner.id;
});

afterAll(async () => {
  if (modules === undefined) return;
  const { db, schema, closeDb } = need();
  if (learnerId !== '') {
    await db.delete(schema.learningEvents).where(eq(schema.learningEvents.learnerId, learnerId));
    await db.delete(schema.reviewQueue).where(eq(schema.reviewQueue.learnerId, learnerId));
    await db.delete(schema.learnerProfiles).where(eq(schema.learnerProfiles.id, learnerId));
  }
  await closeDb();
});

describe.skipIf(!HAS_DB)('kana table for the mini app', () => {
  it('returns the whole grid even before anything is learned', { timeout: 120000 }, async () => {
    const { db, data } = need();
    const sections = await data.loadKanaTable(db, learnerId, NOW);
    const cells = sections.flatMap((s) => s.rows.flatMap((r) => r.cells));
    const present = cells.filter((c) => c !== null);
    expect(present).toHaveLength(KANA.length);
    // まだ何も学んでいないので状態は全部 null（表では灰色になる）
    expect(present.every((c) => c?.state === null)).toBe(true);
  });

  it('lights up what has been introduced', { timeout: 120000 }, async () => {
    const { db, session, data } = need();
    await session.introduceKana(db, learnerId, ['a', 'i', 'u'], NOW);

    const sections = await data.loadKanaTable(db, learnerId, NOW);
    const byId = new Map(
      sections
        .flatMap((s) => s.rows.flatMap((r) => r.cells))
        .filter((c) => c !== null)
        .map((c) => [c.id, c]),
    );
    expect(byId.get('a')?.state).not.toBeNull();
    expect(byId.get('e')?.state).toBeNull();
    // 導入直後は期日が来ている
    expect(byId.get('a')?.state?.due).toBe(true);
    expect(byId.get('a')?.state?.reps).toBe(0);
  });

  it('reports strength between 0 and 1', { timeout: 120000 }, async () => {
    const { db, session, data } = need();
    await session.recordKanaAnswer(
      db, learnerId, 'a',
      { kind: 'CORRECT', hinted: false, inputMode: 'ROMAJI' },
      NOW, 0.9,
    );
    const sections = await data.loadKanaTable(db, learnerId, NOW);
    const a = sections
      .flatMap((s) => s.rows.flatMap((r) => r.cells))
      .find((c) => c?.id === 'a');
    expect(a?.state?.reps).toBe(1);
    expect(a?.state?.strength).toBeGreaterThanOrEqual(0);
    expect(a?.state?.strength).toBeLessThanOrEqual(1);
  });

  // 学習者が求めているのは「今出して」であって「忘れたことにして」ではない。
  it('markDueNow brings an item forward without erasing its history', { timeout: 120000 }, async () => {
    const { db, data, schema } = need();
    const later = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);

    const before = await db
      .select()
      .from(schema.reviewQueue)
      .where(eq(schema.reviewQueue.learnerId, learnerId));
    const target = before.find((r) => r.reps > 0);
    expect(target).toBeDefined();
    if (target === undefined) return;

    const ok = await data.markDueNow(db, learnerId, 'kana_a', later);
    expect(ok).toBe(true);

    const [after] = await db
      .select()
      .from(schema.reviewQueue)
      .where(eq(schema.reviewQueue.id, target.id));
    expect(after?.nextReviewAt.getTime()).toBe(later.getTime());
    // 履歴は残っている
    expect(after?.reps).toBe(target.reps);
    expect(after?.stability).toBe(target.stability);
    expect(after?.state).toBe(target.state);
  });

  it('markDueNow refuses an unknown key', { timeout: 60000 }, async () => {
    const { db, data } = need();
    expect(await data.markDueNow(db, learnerId, 'kana_nope', NOW)).toBe(false);
  });
});
