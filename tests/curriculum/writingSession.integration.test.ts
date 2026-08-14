import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PARTICLES } from '../../src/curriculum/particles.js';

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
  particleSeed: typeof import('../../src/learning/particleSeed.js');
  writing: typeof import('../../src/learning/writingSession.js');
};

let modules: Modules | undefined;
function need(): Modules {
  if (modules === undefined) throw new Error('modules were not loaded');
  return modules;
}

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

const RUN = Date.now();
const NOW = new Date('2027-03-02T09:00:00Z');
const RETENTION = 0.9;
let learnerId = '';

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbModule = await import('../../src/db/index.js');
  const schema = await import('../../src/db/schema/index.js');
  const particleSeed = await import('../../src/learning/particleSeed.js');
  const writing = await import('../../src/learning/writingSession.js');
  modules = {
    db: dbModule.db,
    closeDb: dbModule.closeDb,
    schema,
    particleSeed,
    writing,
  };

  const { db } = need();
  await particleSeed.ensureParticlesSeeded(db);
  const [learner] = await db
    .insert(schema.learnerProfiles)
    .values({ telegramUserId: 9_970_000_000 + (RUN % 100_000) })
    .returning();
  if (!learner) throw new Error('failed to create learner');
  learnerId = learner.id;
});

afterAll(async () => {
  if (modules === undefined) return;
  const { db, schema, closeDb } = need();
  // 本物の学習者を消さないための歯止め。合成 id 以外は触らせない
  // ——過去に実在の記録を消したことがある。
  if (learnerId !== '') {
    const [row] = await db
      .select({ telegramUserId: schema.learnerProfiles.telegramUserId })
      .from(schema.learnerProfiles)
      .where(eq(schema.learnerProfiles.id, learnerId));
    if (row !== undefined && row.telegramUserId < 9_900_000_000) {
      throw new Error(
        `refusing to delete a non-synthetic learner: ${String(row.telegramUserId)}`,
      );
    }
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

describe.skipIf(!HAS_DB)('助詞の入庫', () => {
  it('seeds every particle idempotently', async () => {
    const { db, particleSeed } = need();
    const again = await particleSeed.ensureParticlesSeeded(db);
    expect(again.inserted).toBe(0);
    expect(again.total).toBe(PARTICLES.length);
  });

  it('resolves particle ids to knowledge items', async () => {
    const { db, particleSeed } = need();
    const ids = await particleSeed.resolveParticleItemIds(
      db,
      PARTICLES.map((p) => p.id),
    );
    expect(ids.size).toBe(PARTICLES.length);
  });
});

describe.skipIf(!HAS_DB)('書く練習の駆動', () => {
  it('introduces particles a few at a time', async () => {
    const { db, writing } = need();
    const lesson = await writing.planWritingSession(db, learnerId, NOW, {
      newPerDay: 3,
      maxReviews: 20,
    });
    expect(lesson.newParticles).toHaveLength(3);
    expect(lesson.progress.introduced).toBe(0);
    expect(lesson.progress.total).toBe(PARTICLES.length);

    const inserted = await writing.introduceParticles(
      db,
      learnerId,
      lesson.newParticles.map((p) => p.id),
      NOW,
    );
    expect(inserted).toBe(3);

    const after = await writing.planWritingSession(db, learnerId, NOW, {
      newPerDay: 3,
      maxReviews: 20,
    });
    expect(after.progress.introduced).toBe(3);
    // 導入済みは新出に混ざらない。
    expect(
      after.newParticles.filter((p) =>
        lesson.newParticles.some((seen) => seen.id === p.id),
      ),
    ).toEqual([]);
  });

  /**
   * 期限が来た助詞そのものが問われること。
   *
   * ここが効いていないと、を の復習期限が来ているのに は の問題が出る
   * ——復習キューは進むが、忘れかけている項目は放置される。
   */
  it('asks about the particle whose review is due', async () => {
    const { db, writing } = need();
    const question = await writing.nextWritingQuestion(db, learnerId, NOW, {
      optionCount: 4,
      random: seeded(5),
    });
    expect(question).toBeDefined();
    expect(question?.kind).toBe('PARTICLE');

    const due = PARTICLES.slice(0, 3).map((p) => p.id);
    expect(due).toContain(question?.particle?.id);
  });

  it('grades a choice and moves the card forward', async () => {
    const { db, writing } = need();
    const question = await writing.nextWritingQuestion(db, learnerId, NOW, {
      optionCount: 4,
      random: seeded(5),
    });
    if (question?.blankAt === undefined || question.particle === undefined) {
      throw new Error('expected a particle question');
    }

    const data = writing.encodeParticleAnswer(
      question.sentenceId,
      question.blankAt,
      question.particle.surface,
    );
    const decoded = writing.decodeParticleAnswer(data);
    expect(decoded).toBeDefined();
    if (decoded === undefined) return;

    const graded = await writing.gradeParticle(
      db,
      learnerId,
      decoded,
      NOW,
      RETENTION,
      4_000,
    );
    expect(graded?.correct).toBe(true);
    expect(graded?.answer.id).toBe(question.particle.id);
    // 正解したので次回は先に延びる。
    expect(graded?.applied.entry.reps).toBe(1);
    expect(graded?.applied.entry.nextReviewAt.getTime()).toBeGreaterThan(
      NOW.getTime(),
    );
  });

  it('records a wrong answer against the right particle', async () => {
    const { db, writing, schema } = need();
    const question = await writing.nextWritingQuestion(db, learnerId, NOW, {
      optionCount: 4,
      random: seeded(77),
    });
    if (question?.blankAt === undefined || question.particle === undefined) {
      throw new Error('expected a particle question');
    }
    const wrong = question.options.find(
      (option) => option !== question.particle?.surface,
    );
    if (wrong === undefined) throw new Error('no wrong option');

    const decoded = writing.decodeParticleAnswer(
      writing.encodeParticleAnswer(question.sentenceId, question.blankAt, wrong),
    );
    if (decoded === undefined) throw new Error('could not decode');

    const graded = await writing.gradeParticle(
      db,
      learnerId,
      decoded,
      new Date(NOW.getTime() + 60_000),
      RETENTION,
    );
    expect(graded?.correct).toBe(false);
    // 記録される項目は**正解の助詞**。選んだ誤答ではない。
    expect(graded?.answer.id).toBe(question.particle.id);

    const events = await db
      .select()
      .from(schema.learningEvents)
      .where(eq(schema.learningEvents.learnerId, learnerId));
    expect(events.some((e) => e.eventType === 'FAILED_RECALL')).toBe(true);
  });

  /**
   * 出題を保持していないので、コールバックのデータだけで採点できること。
   * 古いボタンを押されても取り違えないための性質でもある。
   */
  it('round-trips the callback payload within Telegram 64-byte limit', async () => {
    const { db, writing } = need();
    for (const seed of [1, 2, 3, 8, 13]) {
      const question = await writing.nextWritingQuestion(db, learnerId, NOW, {
        optionCount: 4,
        random: seeded(seed),
      });
      if (question?.blankAt === undefined) continue;
      for (const option of question.options) {
        const data = writing.encodeParticleAnswer(
          question.sentenceId,
          question.blankAt,
          option,
        );
        expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
        expect(writing.decodeParticleAnswer(data)).toEqual({
          sentenceId: question.sentenceId,
          blankAt: question.blankAt,
          chosen: option,
        });
      }
    }
  });

  it('falls back to word order when nothing is due', async () => {
    const { db, writing } = need();
    // 未来に飛ばすのではなく過去を見る：まだ何も期限が来ていない時点。
    const before = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    const question = await writing.nextWritingQuestion(db, learnerId, before, {
      optionCount: 4,
      random: seeded(9),
    });
    expect(question?.kind).toBe('WORD_ORDER');
    expect(question?.pieces.length).toBeGreaterThanOrEqual(3);
  });
});

describe.skipIf(!HAS_DB)('助詞の一日上限', () => {
  /**
   * /write は一回の呼び出しごとに newPerDay 個を導入していた——仮名で
   * 直した「上限が一回あたりに効く」取りこぼし（§2.5）が、新しい型で
   * そのまま再発していた。数え方は dailyCap.ts に一本化してある。
   */
  it('counts what was already introduced today', async () => {
    const { db } = need();
    const { remainingNewToday } = await import(
      '../../src/learning/dailyCap.js'
    );
    // beforeAll〜ここまでで 3 項導入済み（introduces particles a few at a time）
    const dayStart = (): Date => new Date(NOW.getTime() - 60 * 60 * 1000);
    const remaining = await remainingNewToday(db, learnerId, NOW, 'GRAMMAR', {
      newPerDay: 5,
      dayStart,
    });
    expect(remaining).toBe(2);

    // 日界を跨げば戻る
    const nextDay = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    const fresh = await remainingNewToday(db, learnerId, nextDay, 'GRAMMAR', {
      newPerDay: 5,
      dayStart: () => new Date(nextDay.getTime() - 60 * 60 * 1000),
    });
    expect(fresh).toBe(5);
  });
});
