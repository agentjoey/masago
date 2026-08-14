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
  kanaSeed: typeof import('../../src/learning/kanaSeed.js');
  vocabSeed: typeof import('../../src/learning/vocabSeed.js');
  kanaSession: typeof import('../../src/learning/kanaSession.js');
  vocabSession: typeof import('../../src/learning/vocabSession.js');
};

let modules: Modules | undefined;
function need(): Modules {
  if (modules === undefined) throw new Error('modules were not loaded');
  return modules;
}

const RUN = Date.now();
const OPTIONS = { newPerDay: 5, maxReviews: 20, backlogThreshold: 20 };
const NOW = new Date('2027-01-05T09:00:00Z');
let learnerId = '';

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbModule = await import('../../src/db/index.js');
  const schema = await import('../../src/db/schema/index.js');
  const kanaSeed = await import('../../src/learning/kanaSeed.js');
  const vocabSeed = await import('../../src/learning/vocabSeed.js');
  const kanaSession = await import('../../src/learning/kanaSession.js');
  const vocabSession = await import('../../src/learning/vocabSession.js');
  modules = { db: dbModule.db, closeDb: dbModule.closeDb, schema, kanaSeed, vocabSeed, kanaSession, vocabSession };

  const { db } = need();
  await kanaSeed.ensureKanaSeeded(db);
  await vocabSeed.ensureVocabSeeded(db);
  const [learner] = await db
    .insert(schema.learnerProfiles)
    .values({ telegramUserId: 9_960_000_000 + (RUN % 100_000) })
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

describe.skipIf(!HAS_DB)('S1 vocabulary session', () => {
  it('seeds all N5 vocabulary idempotently', { timeout: 180000 }, async () => {
    const { db, vocabSeed } = need();
    const again = await vocabSeed.ensureVocabSeeded(db);
    expect(again.inserted).toBe(0);
    expect(again.total).toBeGreaterThan(700);
  });

  // 清音の途中で語彙を出すと、読めない字だらけになる。
  it('teaches no vocabulary until the seion are done', { timeout: 120000 }, async () => {
    const { db, kanaSession, vocabSession } = need();
    await kanaSession.introduceKana(db, learnerId, ['a', 'i', 'u'], NOW);

    const lesson = await vocabSession.planVocabSession(db, learnerId, NOW, OPTIONS);
    expect(lesson.stage).toBe('S0_KANA_ONLY');
    expect(lesson.newWords).toEqual([]);
  });

  it('starts vocabulary once every seion is introduced', { timeout: 180000 }, async () => {
    const { db, kanaSession, vocabSession } = need();
    const seion = KANA.filter((k) => k.group === 'seion').map((k) => k.id);
    await kanaSession.introduceKana(db, learnerId, seion, NOW);

    const lesson = await vocabSession.planVocabSession(db, learnerId, NOW, OPTIONS);
    expect(lesson.stage).toBe('S1_VOCAB');
    expect(lesson.newWords).toHaveLength(5);
    // 教科書の第一課から始まる
    for (const word of lesson.newWords) {
      expect(word.genkiLesson).toBe(1);
    }
  });

  it('introduces words and then asks about them', { timeout: 180000 }, async () => {
    const { db, vocabSession } = need();
    const lesson = await vocabSession.planVocabSession(db, learnerId, NOW, OPTIONS);
    const introduced = await vocabSession.introduceVocab(
      db,
      learnerId,
      lesson.newWords.map((w) => w.id),
      NOW,
    );
    expect(introduced).toBe(5);

    const question = await vocabSession.nextVocabQuestion(db, learnerId, NOW, {
      optionCount: 4,
      random: () => 0.5,
    });
    expect(question).toBeDefined();
    if (question === undefined) return;
    expect(question.typed).toBe(false);
    // 誤答は既習の語からだけ
    const knownIds = lesson.newWords.map((w) => w.id);
    for (const option of question.question.options) {
      expect(knownIds).toContain(option.vocabId);
    }
    // 語を見せる問題では読みを添える
    if (question.question.kind === 'WORD_TO_MEANING') {
      expect(question.question.promptReading).toBeDefined();
    }
  });

  it('records an answer and reschedules', { timeout: 120000 }, async () => {
    const { db, vocabSession } = need();
    const question = await vocabSession.nextVocabQuestion(db, learnerId, NOW, {
      optionCount: 4,
      random: () => 0.5,
    });
    if (question === undefined) throw new Error('no question');

    const graded = await vocabSession.gradeVocabChoice(
      db,
      learnerId,
      question.question.targetId,
      question.question.targetId,
      NOW,
      0.9,
    );
    expect(graded.correct).toBe(true);
    expect(graded.applied.entry.reps).toBe(1);
    expect(graded.applied.entry.nextReviewAt.getTime()).toBeGreaterThan(
      NOW.getTime(),
    );
  });

  it('marks a wrong answer as incorrect', { timeout: 120000 }, async () => {
    const { db, vocabSession } = need();
    const lesson = await vocabSession.planVocabSession(db, learnerId, NOW, OPTIONS);
    const known = lesson.pool;
    expect(known.length).toBeGreaterThanOrEqual(2);
    const [a, b] = known;
    if (a === undefined || b === undefined) return;

    const graded = await vocabSession.gradeVocabTyped(
      db,
      learnerId,
      a.id,
      'まったく違う',
      NOW,
      0.9,
    );
    expect(graded.correct).toBe(false);
  });

  it('refuses to introduce a word that was never seeded', { timeout: 60000 }, async () => {
    const { db, vocabSession } = need();
    await expect(
      vocabSession.introduceVocab(db, learnerId, ['not#real'], NOW),
    ).rejects.toThrow(/not seeded/);
  });
});

describe.skipIf(!HAS_DB)('vocabulary metadata upkeep', () => {
  // 冪等な seed は「無い行を足す」だけなので、後から項目を増やしても
  // 既存行は古いまま残る。実測で N4 を足したとき、先に入っていた N5 の
  // 717 行に level が付いていなかった。黙って古いままにしない。
  it('repairs metadata that predates a new field', { timeout: 180000 }, async () => {
    const { db, schema, vocabSeed } = need();
    const { vocabKey } = await import('../../src/curriculum/vocab.js');
    const key = vocabKey('今#いま');

    // 古い形（level 無し）に戻す
    await db
      .update(schema.knowledgeItems)
      .set({ metadata: { expression: '今', reading: 'いま', meaning: 'now' } })
      .where(eq(schema.knowledgeItems.key, key));

    const result = await vocabSeed.ensureVocabSeeded(db);
    expect(result.repaired).toBeGreaterThanOrEqual(1);

    const [row] = await db
      .select()
      .from(schema.knowledgeItems)
      .where(eq(schema.knowledgeItems.key, key));
    expect((row?.metadata as Record<string, unknown>)['level']).toBe('N5');
  });

  it('repairs nothing when everything is current', { timeout: 120000 }, async () => {
    const { db, vocabSeed } = need();
    await vocabSeed.ensureVocabSeeded(db);
    const again = await vocabSeed.ensureVocabSeeded(db);
    expect(again.repaired).toBe(0);
    expect(again.inserted).toBe(0);
  });

  it('carries both levels', { timeout: 120000 }, async () => {
    const { db, schema } = need();
    const rows = await db
      .select({ metadata: schema.knowledgeItems.metadata })
      .from(schema.knowledgeItems)
      .where(eq(schema.knowledgeItems.type, 'VOCABULARY'));
    const levels = new Set(
      rows.map((r) => (r.metadata as Record<string, unknown>)['level']),
    );
    expect(levels).toEqual(new Set(['N5', 'N4']));
  });
});
