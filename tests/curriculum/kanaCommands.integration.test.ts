import { eq } from 'drizzle-orm';
import { KANA_BY_ID } from '../../src/curriculum/kana.js';
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
    dailyLimitUsd: 1,
    explainItem: (t) => Promise.resolve(`讲解：${t.subject}`),
    monthlyLimitUsd: 10,
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

  it('reports progress for both stages', { timeout: 120000 }, async () => {
    const commands = makeCommands();
    const replies = await commands.progress(TELEGRAM_USER_ID);
    expect(replies[0]?.text).toContain('学习进度');
    expect(replies[0]?.text).toContain('五十音');
    expect(replies[0]?.text).toMatch(/已学 \d+\/104/);
    // 清音がまだなので単語の行は出さない
    expect(replies[0]?.text).not.toContain('N5 单词');
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

describe.skipIf(!HAS_DB)('typed answers (§4.3 第二档)', () => {
  it(
    'switches from buttons to typing once the kana is familiar',
    { timeout: 180000 },
    async () => {
      const { db, schema } = need();
      const commands = makeCommands();

      // 専用の学習者を立てる。他の用例の進度に引きずられないため。
      const [learner] = await db
        .insert(schema.learnerProfiles)
        .values({ telegramUserId: 9_900_000_000 + (RUN % 100_000) })
        .returning();
      if (!learner) throw new Error('failed to create learner');
      const userId = 9_900_000_000 + (RUN % 100_000);

      try {
        clock = new Date('2026-12-01T09:00:00Z');
        await commands.drill(userId); // あ行を導入

        // 復習間隔は答えるたびに伸びる。時計を一定量ずつ進めると
        // すぐ「期日が来ていない」だけになるので、次の期日まで飛ばす。
        const jumpToNextDue = async (): Promise<boolean> => {
          const [row] = await db
            .select({ at: schema.reviewQueue.nextReviewAt })
            .from(schema.reviewQueue)
            .where(eq(schema.reviewQueue.learnerId, learner.id))
            .orderBy(schema.reviewQueue.nextReviewAt)
            .limit(1);
          if (row === undefined) return false;
          if (row.at.getTime() > clock.getTime()) clock = new Date(row.at);
          return true;
        };

        let sawButtons = 0;
        let sawTyped = 0;
        const drillModule = await import('../../src/learning/kanaDrill.js');

        for (let round = 0; round < 60 && sawTyped < 2; round += 1) {
          const replies = await commands.review(userId);
          const question = replies[0];
          if (question === undefined) break;

          if (question.buttons !== undefined) {
            sawButtons += 1;
            const targetId = question.buttons[0]?.data.split(':')[2];
            const correct = question.buttons.find(
              (b) => b.data.split(':')[3] === targetId,
            );
            if (correct === undefined) throw new Error('no correct option');
            await commands.answer(userId, correct.data, clock);
          } else if (question.expectsReply === true) {
            sawTyped += 1;
            // 打ち込みの問題には選択肢が無い
            expect(question.buttons).toBeUndefined();
            expect(question.text).toContain('直接回复');

            const asked = drillModule.targetOfQuestionText(question.text);
            expect(asked).toBeDefined();
            if (asked === undefined) break;
            const romaji = KANA_BY_ID.get(asked)?.romaji ?? '';
            const graded = await commands.answerTyped(
              userId,
              question.text,
              romaji,
              clock,
            );
            expect(graded?.[0]?.text).toContain('✅');
          }
          if (!(await jumpToNextDue())) break;
        }

        expect(sawButtons).toBeGreaterThan(0);
        // 十分繰り返せば必ず打たせる段に届く
        expect(sawTyped).toBeGreaterThan(0);
      } finally {
        await db
          .delete(schema.learningEvents)
          .where(eq(schema.learningEvents.learnerId, learner.id));
        await db
          .delete(schema.reviewQueue)
          .where(eq(schema.reviewQueue.learnerId, learner.id));
        await db
          .delete(schema.learnerProfiles)
          .where(eq(schema.learnerProfiles.id, learner.id));
      }
    },
  );

  // 会話への返信を採点してしまうと、話しかけただけで不正解が積まれる。
  it(
    'leaves a reply to an ordinary message alone',
    { timeout: 60000 },
    async () => {
      const commands = makeCommands();
      const result = await commands.answerTyped(
        TELEGRAM_USER_ID,
        'こんにちは！今日はどうでしたか？',
        'げんきです',
        clock,
      );
      expect(result).toBeUndefined();
    },
  );

  it(
    'accepts kunrei spelling as well as hepburn',
    { timeout: 60000 },
    async () => {
      const commands = makeCommands();
      const question = '这个假名怎么读？\n\nし\n\n直接回复罗马字（例：ka）';
      for (const typed of ['shi', 'si', ' SHI ']) {
        const replies = await commands.answerTyped(
          TELEGRAM_USER_ID,
          question,
          typed,
          clock,
        );
        expect(replies?.[0]?.text, typed).toContain('✅');
      }
    },
  );

  it(
    'shows what was typed when it is wrong',
    { timeout: 60000 },
    async () => {
      const commands = makeCommands();
      const replies = await commands.answerTyped(
        TELEGRAM_USER_ID,
        '这个假名怎么读？\n\nし\n\n直接回复罗马字（例：ka）',
        'sa',
        clock,
      );
      expect(replies?.[0]?.text).toContain('❌');
      expect(replies?.[0]?.text).toContain('「sa」');
      expect(replies?.[0]?.audioKanaId).toBe('si');
    },
  );
});

describe.skipIf(!HAS_DB)('/explain', () => {
  it(
    'explains the item the learner just answered',
    { timeout: 120000 },
    async () => {
      const commands = makeCommands();
      clock = new Date('2027-02-01T09:00:00Z');
      await commands.drill(TELEGRAM_USER_ID);

      const replies = await commands.explain(TELEGRAM_USER_ID);
      expect(replies[0]?.text).toContain('讲解：');
      // 直近に答えた項目を指している
      expect(replies[0]?.text).toMatch(/[ぁ-ん]|[一-龯]/);
    },
  );

  it('asks the learner to practise first when there is nothing to explain', { timeout: 120000 }, async () => {
    const { db, schema, kanaCommands } = need();
    const [fresh] = await db
      .insert(schema.learnerProfiles)
      .values({ telegramUserId: 9_930_000_000 + (RUN % 100_000) })
      .returning();
    if (!fresh) throw new Error('failed to create learner');
    try {
      const commands = kanaCommands.createKanaCommands({
        executor: db,
        now: () => clock,
        random: seeded(1),
        requestRetention: 0.9,
        optionCount: 4,
        newPerDay: 5,
        maxReviews: 20,
        backlogThreshold: 20,
        dailyLimitUsd: 1,
        monthlyLimitUsd: 10,
        explainItem: () => Promise.resolve('讲解'),
      });
      const replies = await commands.explain(9_930_000_000 + (RUN % 100_000));
      expect(replies[0]?.text).toContain('先发');
    } finally {
      await db
        .delete(schema.learnerProfiles)
        .where(eq(schema.learnerProfiles.id, fresh.id));
    }
  });

  // 解説が落ちても学習は続く。例外をそのまま上げない。
  it('degrades gracefully when the explainer fails', { timeout: 120000 }, async () => {
    const { db, kanaCommands } = need();
    const commands = kanaCommands.createKanaCommands({
      executor: db,
      now: () => clock,
      random: seeded(1),
      requestRetention: 0.9,
      optionCount: 4,
      newPerDay: 5,
      maxReviews: 20,
      backlogThreshold: 20,
      dailyLimitUsd: 1,
      monthlyLimitUsd: 10,
      explainItem: () => Promise.reject(new Error('llm down')),
    });
    const replies = await commands.explain(TELEGRAM_USER_ID);
    expect(replies[0]?.text).toContain('暂时不可用');
  });
});

describe.skipIf(!HAS_DB)('/start', () => {
  const NEW_USER = 9_940_000_000 + (RUN % 100_000);

  afterAll(async () => {
    const { db, schema } = need();
    await db
      .delete(schema.learnerProfiles)
      .where(eq(schema.learnerProfiles.telegramUserId, NEW_USER));
  });

  // Telegram は bot を開いた時点で /start を送る。ここで記録を作らないと、
  // 続けて /today を叩いた人が「先に一言送ってください」から始まる。
  it('creates the learner record so the next command works', async () => {
    const commands = makeCommands();

    const welcome = await commands.start(NEW_USER);
    expect(welcome[0]?.text).toContain('MasaGo');
    expect(welcome[0]?.text).toContain('/kana');

    // 直後に /today が使える
    const today = await commands.today(NEW_USER);
    expect(today[0]?.text).not.toContain('学习档案');
    expect(today[0]?.text).toContain('今天的学习');
  });

  it('greets a returning learner differently', async () => {
    const commands = makeCommands();
    const again = await commands.start(NEW_USER);
    expect(again[0]?.text).toContain('欢迎回来');
    expect(again[0]?.text).not.toContain('我是 MasaGo');
  });
});

describe.skipIf(!HAS_DB)('daily new-item cap', () => {
  // newPerDay は「一回で出す数」ではなく「その日に出した総数」。
  // 実測で /kana を 5 回叩くと 25 個入り、翌日以降の復習が雪だるまになった。
  it('caps introductions per day, not per call', { timeout: 180000 }, async () => {
    const { db, schema, kanaCommands } = need();
    const userId = 9_910_000_000 + (RUN % 100_000);
    const [learner] = await db
      .insert(schema.learnerProfiles)
      .values({ telegramUserId: userId })
      .returning();
    if (!learner) throw new Error('failed to create learner');

    let localClock = new Date('2027-10-01T09:00:00Z');
    const dayStart = (now: Date): Date => {
      const day = new Date(now);
      day.setUTCHours(0, 0, 0, 0);
      return day;
    };
    const commands = kanaCommands.createKanaCommands({
      executor: db,
      now: () => localClock,
      random: seeded(3),
      requestRetention: 0.9,
      optionCount: 4,
      newPerDay: 5,
      maxReviews: 20,
      backlogThreshold: 20,
      dailyLimitUsd: 1,
      monthlyLimitUsd: 10,
      dayStart,
    });

    const introduced = async (): Promise<number> => {
      const rows = await db
        .select()
        .from(schema.reviewQueue)
        .where(eq(schema.reviewQueue.learnerId, learner.id));
      return rows.length;
    };

    try {
      for (let call = 0; call < 4; call += 1) {
        await commands.drill(userId);
      }
      expect(await introduced()).toBe(5);

      // 翌日はまた 5 個ぶんの枠が戻る
      localClock = new Date('2027-10-02T09:00:00Z');
      await commands.drill(userId);
      expect(await introduced()).toBe(10);

      // /today も残り枠を反映する（枠を使い切った日は新出を出さない）
      await commands.drill(userId);
      const today = await commands.today(userId);
      expect(today[0]?.text).not.toContain('新假名 5 个');
    } finally {
      await db
        .delete(schema.learningEvents)
        .where(eq(schema.learningEvents.learnerId, learner.id));
      await db
        .delete(schema.reviewQueue)
        .where(eq(schema.reviewQueue.learnerId, learner.id));
      await db
        .delete(schema.learnerProfiles)
        .where(eq(schema.learnerProfiles.id, learner.id));
    }
  });
});
