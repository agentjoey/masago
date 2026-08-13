import { desc, eq, inArray } from 'drizzle-orm';
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
  repo: typeof import('../../src/db/repositories/reviewQueue.js');
  service: typeof import('../../src/learning/review.js');
};

let modules: Modules | undefined;

function need(): Modules {
  if (modules === undefined) {
    throw new Error('database modules were not loaded');
  }
  return modules;
}

const RUN = Date.now();
const TELEGRAM_USER_ID = 9_300_000_000 + (RUN % 100_000);
const OTHER_TELEGRAM_USER_ID = 9_400_000_000 + (RUN % 100_000);
const RETENTION = 0.9;
const NOW = new Date('2026-08-14T09:00:00Z');

const created = {
  learnerId: '',
  otherLearnerId: '',
  itemIds: [] as string[],
};

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbModule = await import('../../src/db/index.js');
  const schema = await import('../../src/db/schema/index.js');
  const repo = await import('../../src/db/repositories/reviewQueue.js');
  const service = await import('../../src/learning/review.js');
  modules = {
    db: dbModule.db,
    closeDb: dbModule.closeDb,
    schema,
    repo,
    service,
  };

  const { db } = need();
  for (const [telegramUserId, field] of [
    [TELEGRAM_USER_ID, 'learnerId'],
    [OTHER_TELEGRAM_USER_ID, 'otherLearnerId'],
  ] as const) {
    const [learner] = await db
      .insert(schema.learnerProfiles)
      .values({ telegramUserId })
      .returning();
    if (!learner) throw new Error('failed to create test learner');
    created[field] = learner.id;
  }

  const items = await db
    .insert(schema.knowledgeItems)
    .values(
      ['a', 'i', 'u'].map((kana) => ({
        type: 'KANA' as const,
        key: `kana_${kana}_${RUN}`,
      })),
    )
    .returning({ id: schema.knowledgeItems.id });
  created.itemIds = items.map((item) => item.id);
});

afterAll(async () => {
  if (modules === undefined) return;
  const { db, schema, closeDb } = need();
  const learnerIds = [created.learnerId, created.otherLearnerId].filter(
    (id) => id !== '',
  );
  if (learnerIds.length > 0) {
    // 事件は knowledge_items と learner_profiles を参照するので先に消す。
    await db
      .delete(schema.learningEvents)
      .where(inArray(schema.learningEvents.learnerId, learnerIds));
    await db
      .delete(schema.reviewQueue)
      .where(inArray(schema.reviewQueue.learnerId, learnerIds));
  }
  if (created.itemIds.length > 0) {
    await db
      .delete(schema.knowledgeItems)
      .where(inArray(schema.knowledgeItems.id, created.itemIds));
  }
  for (const learnerId of learnerIds) {
    await db
      .delete(schema.learnerProfiles)
      .where(eq(schema.learnerProfiles.id, learnerId));
  }
  await closeDb();
});

describe.skipIf(!HAS_DB)('reviewQueue repository', () => {
  it(
    'enqueueIfAbsent is idempotent and never resets an existing card',
    { timeout: 60000 },
    async () => {
      const { db, repo, service } = need();
      const [itemId] = created.itemIds;
      if (itemId === undefined) throw new Error('missing item');

      expect(
        await service.enqueueNew(db, created.learnerId, [itemId], NOW),
      ).toBe(1);
      // 二度目は何も積まない
      expect(
        await service.enqueueNew(db, created.learnerId, [itemId], NOW),
      ).toBe(0);

      await service.applyReview(
        db,
        created.learnerId,
        itemId,
        { kind: 'CORRECT', hinted: false, inputMode: 'ROMAJI' },
        NOW,
        RETENTION,
      );
      const learned = await repo.findEntry(db, created.learnerId, itemId);
      expect(learned?.reps).toBe(1);

      // 学習済みの項目に再度積んでも、履歴を消してはいけない
      await service.enqueueNew(db, created.learnerId, [itemId], NOW);
      const after = await repo.findEntry(db, created.learnerId, itemId);
      expect(after?.reps).toBe(1);
      expect(after?.stability).toBe(learned?.stability);
    },
  );

  it(
    'round-trips every FSRS field through postgres',
    { timeout: 60000 },
    async () => {
      const { db, repo, service } = need();
      const itemId = created.itemIds[1];
      if (itemId === undefined) throw new Error('missing item');

      // REVIEW まで上げて、全フィールドに 0 以外が入った状態を作る
      let at = NOW;
      for (let i = 0; i < 3; i += 1) {
        const { entry } = await service.applyReview(
          db,
          created.learnerId,
          itemId,
          { kind: 'CORRECT', hinted: false, inputMode: 'ROMAJI' },
          at,
          RETENTION,
        );
        at = entry.nextReviewAt;
      }

      const stored = await repo.findEntry(db, created.learnerId, itemId);
      expect(stored).toBeDefined();
      if (stored === undefined) return;

      expect(stored.reps).toBe(3);
      expect(stored.stability).toBeGreaterThan(0);
      expect(stored.difficulty).toBeGreaterThan(0);
      expect(stored.state).toBe('REVIEW');
      expect(stored.lastReview).toBeInstanceOf(Date);
      expect(stored.intervalDays).toBeGreaterThan(0);

      // 読み戻した状態から続きを計算できる＝履歴が失われていない
      const next = await service.applyReview(
        db,
        created.learnerId,
        itemId,
        { kind: 'CORRECT', hinted: false, inputMode: 'ROMAJI' },
        stored.nextReviewAt,
        RETENTION,
      );
      expect(next.entry.reps).toBe(4);
      expect(next.entry.stability).toBeGreaterThan(stored.stability);
      expect(next.previousState).toBe('REVIEW');
    },
  );

  it(
    'RELEARNING survives the enum round-trip',
    { timeout: 60000 },
    async () => {
      const { db, repo, service } = need();
      const itemId = created.itemIds[2];
      if (itemId === undefined) throw new Error('missing item');

      let at = NOW;
      let state = 'NEW';
      while (state !== 'REVIEW') {
        const { entry } = await service.applyReview(
          db,
          created.learnerId,
          itemId,
          { kind: 'CORRECT', hinted: false, inputMode: 'ROMAJI' },
          at,
          RETENTION,
        );
        at = entry.nextReviewAt;
        state = entry.state;
      }

      const { entry } = await service.applyReview(
        db,
        created.learnerId,
        itemId,
        { kind: 'INCORRECT' },
        at,
        RETENTION,
      );
      expect(entry.state).toBe('RELEARNING');
      expect(entry.lapses).toBe(1);

      const reread = await repo.findEntry(db, created.learnerId, itemId);
      expect(reread?.state).toBe('RELEARNING');
    },
  );

  it(
    'listDue and countDue only see this learner, and only what is due',
    { timeout: 60000 },
    async () => {
      const { db, repo, service } = need();
      const [first] = created.itemIds;
      if (first === undefined) throw new Error('missing item');

      // 別の学習者の同じ項目は混ざってはいけない
      await service.enqueueNew(db, created.otherLearnerId, [first], NOW);

      const far = new Date(NOW.getTime() + 3650 * 24 * 60 * 60 * 1000);
      const due = await repo.listDue(db, created.learnerId, far, 50);
      expect(due.length).toBe(created.itemIds.length);
      for (const item of due) {
        expect(item.entry.learnerId).toBe(created.learnerId);
        expect(item.knowledgeType).toBe('KANA');
        expect(item.knowledgeKey).toMatch(/^kana_/);
      }
      // 期日の早い順
      const times = due.map((d) => d.entry.nextReviewAt.getTime());
      expect([...times].sort((a, b) => a - b)).toEqual(times);

      expect(await repo.countDue(db, created.learnerId, far)).toBe(
        created.itemIds.length,
      );

      // まだ誰も期日を迎えていない時点では 0
      const past = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
      expect(await repo.countDue(db, created.learnerId, past)).toBe(0);
      expect(await repo.listDue(db, created.learnerId, past, 50)).toEqual([]);

      expect(await repo.countDue(db, created.otherLearnerId, far)).toBe(1);
    },
  );

  it(
    'applyReview creates the entry when the item was never enqueued',
    { timeout: 60000 },
    async () => {
      const { db, schema, repo, service } = need();
      const [item] = await db
        .insert(schema.knowledgeItems)
        .values({ type: 'KANA', key: `kana_unqueued_${RUN}` })
        .returning({ id: schema.knowledgeItems.id });
      if (item === undefined) throw new Error('failed to create item');
      created.itemIds.push(item.id);

      expect(
        await repo.findEntry(db, created.learnerId, item.id),
      ).toBeUndefined();

      const { entry, previousState } = await service.applyReview(
        db,
        created.learnerId,
        item.id,
        { kind: 'INCORRECT' },
        NOW,
        RETENTION,
      );
      expect(previousState).toBe('NEW');
      expect(entry.reps).toBe(1);
    },
  );

  it('markMastered is scoped to one learner', { timeout: 60000 }, async () => {
    const { db, repo } = need();
    const [first] = created.itemIds;
    if (first === undefined) throw new Error('missing item');

    await repo.markMastered(db, created.learnerId, first);
    expect((await repo.findEntry(db, created.learnerId, first))?.state).toBe(
      'MASTERED',
    );
    expect(
      (await repo.findEntry(db, created.otherLearnerId, first))?.state,
    ).not.toBe('MASTERED');
  });
});

describe.skipIf(!HAS_DB)('learning events (§3.3)', () => {
  it(
    'records every answer so history can be recomputed later',
    { timeout: 120000 },
    async () => {
      const { db, schema, service } = need();
      const itemId = created.itemIds[0];
      if (itemId === undefined) throw new Error('missing item');

      const before = await db
        .select()
        .from(schema.learningEvents)
        .where(eq(schema.learningEvents.learnerId, created.learnerId));

      const at = new Date('2027-06-01T09:00:00Z');
      await service.applyReview(
        db,
        created.learnerId,
        itemId,
        { kind: 'CORRECT', hinted: false, inputMode: 'ROMAJI' },
        at,
        RETENTION,
      );
      await service.applyReview(
        db,
        created.learnerId,
        itemId,
        { kind: 'INCORRECT' },
        new Date(at.getTime() + 60_000),
        RETENTION,
      );

      const after = await db
        .select()
        .from(schema.learningEvents)
        .where(eq(schema.learningEvents.learnerId, created.learnerId));

      // review_queue は最後の一回しか持たない。履歴は事件側にしか残らない。
      expect(after.length).toBe(before.length + 2);
      const types = after.map((row) => row.eventType);
      expect(types).toContain('USER_CORRECT');
      expect(types).toContain('FAILED_RECALL');
    },
  );

  it('keeps the evidence needed to recompute', { timeout: 120000 }, async () => {
    const { db, schema, service } = need();
    const itemId = created.itemIds[1];
    if (itemId === undefined) throw new Error('missing item');

    const at = new Date('2027-06-02T09:00:00Z');
    await service.applyReview(
      db,
      created.learnerId,
      itemId,
      { kind: 'CORRECT', hinted: true, inputMode: 'CHOICE', responseMs: 900 },
      at,
      RETENTION,
    );

    const [row] = await db
      .select()
      .from(schema.learningEvents)
      .where(eq(schema.learningEvents.knowledgeItemId, itemId))
      .orderBy(desc(schema.learningEvents.createdAt))
      .limit(1);
    expect(row?.evidence).toMatchObject({
      inputMode: 'CHOICE',
      hinted: true,
    });
  });

  // 同じ項目を積み直しても導入は一度きり。
  it('does not duplicate the introduction event', { timeout: 120000 }, async () => {
    const { db, schema, service } = need();
    const itemId = created.itemIds[2];
    if (itemId === undefined) throw new Error('missing item');
    const now = new Date('2027-06-03T09:00:00Z');

    await service.enqueueNew(db, created.learnerId, [itemId], now);
    await service.enqueueNew(db, created.learnerId, [itemId], now);

    const rows = await db
      .select()
      .from(schema.learningEvents)
      .where(eq(schema.learningEvents.knowledgeItemId, itemId));
    expect(
      rows.filter((r) => r.eventType === 'INTRODUCED').length,
    ).toBeLessThanOrEqual(1);
  });
});
