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
  vocabSeed: typeof import('../../src/learning/vocabSeed.js');
  vocabSession: typeof import('../../src/learning/vocabSession.js');
  reflow: typeof import('../../src/learning/vocabReflow.js');
  review: typeof import('../../src/learning/review.js');
};

let modules: Modules | undefined;
function need(): Modules {
  if (modules === undefined) throw new Error('modules were not loaded');
  return modules;
}

const RUN = Date.now();
const NOW = new Date('2027-05-10T09:00:00Z');
const RETENTION = 0.9;
let learnerId = '';

/** 私は本を読みます。 相当のトークン列を返す偽の解析器。 */
function analyzerFor(text: string) {
  return () =>
    Promise.resolve(
      text === 'FAIL'
        ? Promise.reject(new Error('analyzer down'))
        : [
            { surface: '私', pos: '名詞', posDetail: '代名詞', basicForm: '私', conjugatedForm: '', reading: 'ワタシ' },
            { surface: 'は', pos: '助詞', posDetail: '係助詞', basicForm: 'は', conjugatedForm: '', reading: 'ハ' },
            { surface: '本', pos: '名詞', posDetail: '一般', basicForm: '本', conjugatedForm: '', reading: 'ホン' },
            { surface: 'を', pos: '助詞', posDetail: '格助詞', basicForm: 'を', conjugatedForm: '', reading: 'ヲ' },
            { surface: '読み', pos: '動詞', posDetail: '自立', basicForm: '読む', conjugatedForm: '連用形', reading: 'ヨミ' },
            { surface: 'ます', pos: '助動詞', posDetail: '*', basicForm: 'ます', conjugatedForm: '', reading: 'マス' },
          ],
    ) as never;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbModule = await import('../../src/db/index.js');
  const schema = await import('../../src/db/schema/index.js');
  const vocabSeed = await import('../../src/learning/vocabSeed.js');
  const vocabSession = await import('../../src/learning/vocabSession.js');
  const reflow = await import('../../src/learning/vocabReflow.js');
  const review = await import('../../src/learning/review.js');
  modules = {
    db: dbModule.db,
    closeDb: dbModule.closeDb,
    schema,
    vocabSeed,
    vocabSession,
    reflow,
    review,
  };

  const { db } = need();
  await vocabSeed.ensureVocabSeeded(db);
  const [learner] = await db
    .insert(schema.learnerProfiles)
    .values({ telegramUserId: 9_980_000_000 + (RUN % 100_000) })
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

describe.skipIf(!HAS_DB)('語彙の回流', () => {
  /** 「本」と「読む」に当たる語彙 id を実際の表から引く。 */
  async function introduceTargets(): Promise<string[]> {
    const { db, vocabSession } = need();
    const { VOCAB } = await import('../../src/curriculum/vocab.js');
    const ids = VOCAB.filter(
      (entry) => entry.expression === '本' || entry.expression === '読む',
    ).map((entry) => entry.id);
    expect(ids.length).toBeGreaterThan(0);
    await vocabSession.introduceVocab(db, learnerId, ids, NOW);
    return ids;
  }

  function deps() {
    const { db } = need();
    return {
      executor: db,
      analyze: analyzerFor('ok'),
      requestRetention: RETENTION,
      dayKey: (now: Date) => now.toISOString().slice(0, 10),
    };
  }

  it('records a word the learner used in conversation', async () => {
    const { reflow } = need();
    const ids = await introduceTargets();
    const result = await reflow.reflowVocabulary(
      deps(),
      learnerId,
      '私は本を読みます。',
      NOW,
    );
    expect(result.recorded.length).toBeGreaterThan(0);
    for (const id of result.recorded) expect(ids).toContain(id);
  });

  /**
   * 同じ語を何度使っても、その日の証拠は一つ。
   *
   * 使うたびに Easy を積むと、目の前の字を写しただけで間隔が伸びていく。
   */
  it('folds repeated use in the same day into one event', async () => {
    const { db, reflow, schema } = need();
    await introduceTargets();

    const countSpontaneous = async (): Promise<number> => {
      const rows = await db
        .select()
        .from(schema.learningEvents)
        .where(eq(schema.learningEvents.learnerId, learnerId));
      return rows.filter((row) => row.eventType === 'USED_SPONTANEOUSLY')
        .length;
    };

    const before = await countSpontaneous();
    expect(before).toBeGreaterThan(0); // 前の用例で記録済み

    // 同じ日にもう二回使う
    for (const offset of [60_000, 120_000]) {
      const again = await reflow.reflowVocabulary(
        deps(),
        learnerId,
        '私は本を読みます。',
        new Date(NOW.getTime() + offset),
      );
      expect(again.recorded).toEqual([]);
      // 候補としては見えている。「語が無い」のではなく「畳んだ」こと。
      expect(again.candidates).toBeGreaterThan(0);
    }

    expect(await countSpontaneous()).toBe(before);
  });

  /** 畳んだ回は復習キューも進めない。事件だけ捨てても間隔が伸びてしまう。 */
  it('leaves the review schedule untouched when it folds', async () => {
    const { db, reflow, schema } = need();
    const ids = await introduceTargets();
    const { resolveVocabItemIds } = await import(
      '../../src/learning/vocabSeed.js'
    );
    const itemIds = [...(await resolveVocabItemIds(db, ids)).values()];

    const snapshot = async (): Promise<string> => {
      const rows = await db
        .select()
        .from(schema.reviewQueue)
        .where(eq(schema.reviewQueue.learnerId, learnerId));
      return JSON.stringify(
        rows
          .filter((row) => itemIds.includes(row.knowledgeItemId))
          .map((row) => [row.knowledgeItemId, row.reps, row.nextReviewAt])
          .sort(),
      );
    };

    const before = await snapshot();
    await reflow.reflowVocabulary(
      deps(),
      learnerId,
      '私は本を読みます。',
      new Date(NOW.getTime() + 180_000),
    );
    expect(await snapshot()).toBe(before);
  });

  it('records again on a different day', async () => {
    const { reflow } = need();
    const nextDay = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    const result = await reflow.reflowVocabulary(
      deps(),
      learnerId,
      '私は本を読みます。',
      nextDay,
    );
    expect(result.recorded.length).toBeGreaterThan(0);
  });

  /** 誤りとして指摘された断片に含まれる語は数えない。 */
  it('skips a word the model flagged as wrong', async () => {
    const { reflow } = need();
    const thirdDay = new Date(NOW.getTime() + 48 * 60 * 60 * 1000);
    const result = await reflow.reflowVocabulary(
      deps(),
      learnerId,
      '私は本を読みます。',
      thirdDay,
      [{ original: '読みます' }],
    );
    const { VOCAB } = await import('../../src/curriculum/vocab.js');
    const yomu = VOCAB.filter((e) => e.expression === '読む').map((e) => e.id);
    for (const id of yomu) expect(result.recorded).not.toContain(id);
  });

  it('does not touch words that were never introduced', async () => {
    const { db, reflow, schema } = need();
    const fourthDay = new Date(NOW.getTime() + 72 * 60 * 60 * 1000);
    await reflow.reflowVocabulary(deps(), learnerId, '私は本を読みます。', fourthDay);

    // 「私」は導入していないので、キューにも入らない。
    const { VOCAB } = await import('../../src/curriculum/vocab.js');
    const watashi = VOCAB.filter((e) => e.expression === '私').map((e) => e.id);
    const { resolveVocabItemIds } = await import(
      '../../src/learning/vocabSeed.js'
    );
    const itemIds = await resolveVocabItemIds(db, watashi);
    for (const itemId of itemIds.values()) {
      const rows = await db
        .select()
        .from(schema.reviewQueue)
        .where(eq(schema.reviewQueue.knowledgeItemId, itemId));
      expect(rows.filter((r) => r.learnerId === learnerId)).toEqual([]);
    }
  });

  it('gives up quietly when the analyzer is unavailable', async () => {
    const { db, reflow } = need();
    const result = await reflow.reflowVocabulary(
      {
        executor: db,
        analyze: () => Promise.reject(new Error('analyzer down')),
        requestRetention: RETENTION,
        dayKey: (now: Date) => now.toISOString().slice(0, 10),
      },
      learnerId,
      '私は本を読みます。',
      NOW,
    );
    expect(result).toEqual({ recorded: [], candidates: 0 });
  });
});
