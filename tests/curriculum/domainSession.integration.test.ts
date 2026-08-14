import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOMAIN_VOCAB, domainVocabOf } from '../../src/curriculum/domainVocab.js';

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
  seed: typeof import('../../src/learning/domainSeed.js');
  session: typeof import('../../src/learning/domainSession.js');
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
const NOW = new Date('2027-06-01T09:00:00Z');
let learnerId = '';

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbModule = await import('../../src/db/index.js');
  const schema = await import('../../src/db/schema/index.js');
  const seed = await import('../../src/learning/domainSeed.js');
  const session = await import('../../src/learning/domainSession.js');
  modules = { db: dbModule.db, closeDb: dbModule.closeDb, schema, seed, session };

  const { db } = need();
  await seed.ensureDomainVocabSeeded(db);
  const [learner] = await db
    .insert(schema.learnerProfiles)
    .values({ telegramUserId: 9_950_000_000 + (RUN % 100_000) })
    .returning();
  if (!learner) throw new Error('failed to create learner');
  learnerId = learner.id;
});

afterAll(async () => {
  if (modules === undefined) return;
  const { db, schema, closeDb } = need();
  // 合成 id 以外は消さない。過去に実在の記録を消したことがある。
  if (learnerId !== '') {
    const [row] = await db
      .select({ telegramUserId: schema.learnerProfiles.telegramUserId })
      .from(schema.learnerProfiles)
      .where(eq(schema.learnerProfiles.id, learnerId));
    if (row !== undefined && row.telegramUserId < 9_900_000_000) {
      throw new Error(`refusing to delete a non-synthetic learner`);
    }
    await db.delete(schema.learningEvents).where(eq(schema.learningEvents.learnerId, learnerId));
    await db.delete(schema.reviewQueue).where(eq(schema.reviewQueue.learnerId, learnerId));
    await db.delete(schema.learnerProfiles).where(eq(schema.learnerProfiles.id, learnerId));
  }
  await closeDb();
});

describe.skipIf(!HAS_DB)('分野別語彙の入庫', () => {
  it('seeds every entry idempotently', async () => {
    const { db, seed } = need();
    const again = await seed.ensureDomainVocabSeeded(db);
    expect(again.inserted).toBe(0);
    expect(again.total).toBe(DOMAIN_VOCAB.length);
  });

  /**
   * DOMAIN 型にしてあるのは、型で引く問い合わせに混ざらないため。
   * VOCABULARY にすると /today や /vocab の件数が主線だけを指さなくなる。
   */
  it('never leaks into the main-line vocabulary counts', async () => {
    const { db, schema } = need();
    const rows = await db
      .select({ type: schema.knowledgeItems.type, key: schema.knowledgeItems.key })
      .from(schema.knowledgeItems);
    const domainRows = rows.filter((r) => r.key.startsWith('domain_'));
    expect(domainRows.length).toBe(DOMAIN_VOCAB.length);
    for (const row of domainRows) expect(row.type).toBe('DOMAIN');
    // 逆向き：VOCABULARY 型に domain_ の鍵が紛れていないこと
    const vocab = rows.filter((r) => r.type === 'VOCABULARY');
    expect(vocab.filter((r) => r.key.startsWith('domain_'))).toEqual([]);
  });
});

describe.skipIf(!HAS_DB)('分野別語彙の駆動', () => {
  it('introduces a few at a time and tracks progress per domain', async () => {
    const { db, session } = need();
    const lesson = await session.planDomainSession(db, learnerId, 'golf', NOW, {
      newPerDay: 3,
      maxReviews: 20,
    });
    expect(lesson?.newEntries).toHaveLength(3);
    expect(lesson?.progress.total).toBe(domainVocabOf('golf').length);

    await session.introduceDomainVocab(
      db,
      learnerId,
      (lesson?.newEntries ?? []).map((e) => e.id),
      NOW,
    );

    const overview = await session.domainOverview(db, learnerId, NOW);
    const golf = overview.find((row) => row.domain.id === 'golf');
    const business = overview.find((row) => row.domain.id === 'business');
    expect(golf?.introduced).toBe(3);
    // 他の分野は影響を受けない
    expect(business?.introduced).toBe(0);
  });

  it('asks only about the domain that was chosen', async () => {
    const { db, session } = need();
    const next = await session.nextDomainQuestion(db, learnerId, 'golf', NOW, {
      optionCount: 4,
      random: seeded(4),
    });
    expect(next).toBeDefined();
    expect(next?.entry.domain).toBe('golf');
    // 別の分野を訊いても、そちらは未導入なので何も出ない
    const other = await session.nextDomainQuestion(db, learnerId, 'business', NOW, {
      optionCount: 4,
      random: seeded(4),
    });
    expect(other).toBeUndefined();
  });

  it('grades a choice and moves the card forward', async () => {
    const { db, session } = need();
    const next = await session.nextDomainQuestion(db, learnerId, 'golf', NOW, {
      optionCount: 4,
      random: seeded(4),
    });
    if (next === undefined) throw new Error('expected a question');

    const graded = await session.gradeDomainAnswer(
      db,
      learnerId,
      { targetId: next.entry.id, chosenId: next.entry.id },
      NOW,
      0.9,
      2_000,
    );
    expect(graded?.correct).toBe(true);
    expect(graded?.applied.entry.reps).toBe(1);
    expect(graded?.applied.entry.nextReviewAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('records a wrong answer against the right entry', async () => {
    const { db, session } = need();
    const golf = domainVocabOf('golf');
    const target = golf[0];
    const other = golf.find((e) => e.meaning !== target?.meaning);
    if (target === undefined || other === undefined) throw new Error('no data');

    const graded = await session.gradeDomainAnswer(
      db,
      learnerId,
      { targetId: target.id, chosenId: other.id },
      new Date(NOW.getTime() + 60_000),
      0.9,
    );
    expect(graded?.correct).toBe(false);
    expect(graded?.target.id).toBe(target.id);
    expect(graded?.chosen?.id).toBe(other.id);
  });

  it('refuses an unknown domain instead of guessing', async () => {
    const { db, session } = need();
    expect(
      await session.planDomainSession(db, learnerId, 'nope', NOW, {
        newPerDay: 3,
        maxReviews: 20,
      }),
    ).toBeUndefined();
  });
});
