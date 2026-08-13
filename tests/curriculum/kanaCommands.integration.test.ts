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
  kanaCommands: typeof import('../../src/learning/kanaCommands.js');
};

let modules: Modules | undefined;
function need(): Modules {
  if (modules === undefined) throw new Error('modules were not loaded');
  return modules;
}

const RUN = Date.now();
const TELEGRAM_USER_ID = 9_600_000_000 + (RUN % 100_000);
const UNKNOWN_USER_ID = 9_700_000_000 + (RUN % 100_000);

let learnerId = '';
let clock = new Date('2026-09-01T09:00:00Z');

/** 決定的な乱数。問題の中身が実行ごとに変わると検証にならない。 */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

function makeCommands(): ReturnType<
  Modules['kanaCommands']['createKanaCommands']
> {
  const { db, kanaCommands } = need();
  return kanaCommands.createKanaCommands({
    executor: db,
    now: () => clock,
    random: seeded(42),
    requestRetention: 0.9,
    optionCount: 4,
    newPerDay: 5,
    maxReviews: 20,
    backlogThreshold: 20,
  });
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbModule = await import('../../src/db/index.js');
  const schema = await import('../../src/db/schema/index.js');
  const seed = await import('../../src/learning/kanaSeed.js');
  const kanaCommands = await import('../../src/learning/kanaCommands.js');
  modules = {
    db: dbModule.db,
    closeDb: dbModule.closeDb,
    schema,
    seed,
    kanaCommands,
  };

  const { db } = need();
  await seed.ensureKanaSeeded(db);
  const [learner] = await db
    .insert(schema.learnerProfiles)
    .values({ telegramUserId: TELEGRAM_USER_ID })
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

describe.skipIf(!HAS_DB)('kana commands', () => {
  it(
    'runs a whole first session: today → kana → answer',
    { timeout: 180000 },
    async () => {
      const commands = makeCommands();
      clock = new Date('2026-09-01T09:00:00Z');

      const today = await commands.today(TELEGRAM_USER_ID);
      expect(today).toHaveLength(1);
      expect(today[0]?.text).toContain('あ(a)');
      expect(today[0]?.text).toContain('0/104');

      // /kana：まず 5 枚教えてから、最初の一問
      const drill = await commands.drill(TELEGRAM_USER_ID);
      expect(drill).toHaveLength(6);
      for (let i = 0; i < 5; i += 1) {
        expect(drill[i]?.audioKanaId).toBeDefined();
        expect(drill[i]?.buttons).toBeUndefined();
      }

      const question = drill[5];
      expect(question?.buttons).toBeDefined();
      expect(question?.buttons).toHaveLength(4);
      // 未習の字を誤答に混ぜない——導入した 5 つの中から出す
      for (const button of question?.buttons ?? []) {
        expect(button.data).toMatch(/^kq:[gra]:[a-z]+:[a-z]+$/);
        const chosen = button.data.split(':')[3];
        expect(['a', 'i', 'u', 'e', 'o']).toContain(chosen);
      }

      // 正解を選ぶ
      const first = question?.buttons?.[0];
      if (first === undefined) throw new Error('no buttons');
      const targetId = first.data.split(':')[2];
      const correct = (question?.buttons ?? []).find(
        (b) => b.data.split(':')[3] === targetId,
      );
      if (correct === undefined) throw new Error('no correct option');

      clock = new Date(clock.getTime() + 2_000);
      const answered = await commands.answer(
        TELEGRAM_USER_ID,
        correct.data,
        new Date(clock.getTime() - 2_000),
      );
      expect(answered[0]?.text).toContain('✅');
      // 続けて次の問題が出る
      expect(answered[1]?.buttons).toBeDefined();
    },
  );

  it(
    'tells the learner the right answer when they are wrong, with audio',
    { timeout: 120000 },
    async () => {
      const commands = makeCommands();
      clock = new Date('2026-09-01T10:00:00Z');

      const drill = await commands.drill(TELEGRAM_USER_ID);
      const question = drill[drill.length - 1];
      const buttons = question?.buttons ?? [];
      const targetId = buttons[0]?.data.split(':')[2];
      const wrong = buttons.find((b) => b.data.split(':')[3] !== targetId);
      if (wrong === undefined) throw new Error('no wrong option available');

      const answered = await commands.answer(TELEGRAM_USER_ID, wrong.data, clock);
      expect(answered[0]?.text).toContain('❌');
      // 間違えた字は音でも確かめさせる
      expect(answered[0]?.audioKanaId).toBe(targetId);
    },
  );

  it(
    'does not crash on a stale or malformed button',
    { timeout: 120000 },
    async () => {
      const commands = makeCommands();
      for (const data of ['', 'kq:g:nope:tu', 'garbage', 'kq:z:a:i']) {
        const replies = await commands.answer(TELEGRAM_USER_ID, data, clock);
        expect(replies).toHaveLength(1);
        expect(replies[0]?.text).toContain('过期');
      }
    },
  );

  it(
    'ignores an impossible response time instead of trusting it',
    { timeout: 120000 },
    async () => {
      const commands = makeCommands();
      clock = new Date('2026-09-02T09:00:00Z');
      const drill = await commands.drill(TELEGRAM_USER_ID);
      const question = drill[drill.length - 1];
      const buttons = question?.buttons ?? [];
      const targetId = buttons[0]?.data.split(':')[2];
      const correct = buttons.find((b) => b.data.split(':')[3] === targetId);
      if (correct === undefined) throw new Error('no correct option');

      // 未来から来た問題（時計のずれ）。負の応答時間を信じてはいけない。
      const future = new Date(clock.getTime() + 60_000);
      const replies = await commands.answer(
        TELEGRAM_USER_ID,
        correct.data,
        future,
      );
      expect(replies[0]?.text).toContain('✅');
    },
  );

  it('reports progress', { timeout: 120000 }, async () => {
    const commands = makeCommands();
    const replies = await commands.progress(TELEGRAM_USER_ID);
    expect(replies[0]?.text).toContain('五十音进度');
    expect(replies[0]?.text).toMatch(/已学 \d+\/104/);
  });

  it(
    'asks an unknown user to say hello first',
    { timeout: 120000 },
    async () => {
      const commands = makeCommands();
      for (const replies of [
        await commands.today(UNKNOWN_USER_ID),
        await commands.drill(UNKNOWN_USER_ID),
        await commands.review(UNKNOWN_USER_ID),
        await commands.progress(UNKNOWN_USER_ID),
        await commands.answer(UNKNOWN_USER_ID, 'kq:g:a:i', clock),
      ]) {
        expect(replies[0]?.text).toContain('学习档案');
      }
    },
  );

  it(
    'review introduces nothing new',
    { timeout: 120000 },
    async () => {
      const { db, schema } = need();
      const commands = makeCommands();
      clock = new Date('2026-09-10T09:00:00Z');

      const before = await db
        .select({ id: schema.reviewQueue.id })
        .from(schema.reviewQueue)
        .where(eq(schema.reviewQueue.learnerId, learnerId));

      await commands.review(TELEGRAM_USER_ID);

      const after = await db
        .select({ id: schema.reviewQueue.id })
        .from(schema.reviewQueue)
        .where(eq(schema.reviewQueue.learnerId, learnerId));
      expect(after.length).toBe(before.length);
    },
  );
});
