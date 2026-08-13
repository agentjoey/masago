import { eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KANA, kanaKey } from '../../src/curriculum/kana.js';

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
};

let modules: Modules | undefined;

function need(): Modules {
  if (modules === undefined) {
    throw new Error('database modules were not loaded');
  }
  return modules;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbModule = await import('../../src/db/index.js');
  const schema = await import('../../src/db/schema/index.js');
  const seed = await import('../../src/learning/kanaSeed.js');
  modules = {
    db: dbModule.db,
    closeDb: dbModule.closeDb,
    schema,
    seed,
  };
});

afterAll(async () => {
  if (modules === undefined) return;
  await need().closeDb();
});

describe.skipIf(!HAS_DB)('kana seeding', () => {
  it(
    'seeds all 104 kana and is idempotent',
    { timeout: 120000 },
    async () => {
      const { db, schema, seed } = need();

      const first = await seed.ensureKanaSeeded(db);
      expect(first.total).toBe(KANA.length);

      // 二度目は一件も入れない。ここが崩れると mastery が毎回巻き戻る。
      const second = await seed.ensureKanaSeeded(db);
      expect(second.inserted).toBe(0);

      const rows = await db
        .select({ key: schema.knowledgeItems.key })
        .from(schema.knowledgeItems)
        .where(eq(schema.knowledgeItems.type, 'KANA'));
      const keys = new Set(rows.map((row) => row.key));
      for (const kana of KANA) {
        expect(keys.has(kanaKey(kana.id)), kana.id).toBe(true);
      }
    },
  );

  it(
    'does not overwrite mastery on re-seed',
    { timeout: 120000 },
    async () => {
      const { db, schema, seed } = need();
      await seed.ensureKanaSeeded(db);

      await db
        .update(schema.knowledgeItems)
        .set({ mastery: 0.75 })
        .where(eq(schema.knowledgeItems.key, kanaKey('a')));

      await seed.ensureKanaSeeded(db);

      const [row] = await db
        .select({ mastery: schema.knowledgeItems.mastery })
        .from(schema.knowledgeItems)
        .where(eq(schema.knowledgeItems.key, kanaKey('a')));
      expect(row?.mastery).toBe(0.75);

      await db
        .update(schema.knowledgeItems)
        .set({ mastery: 0 })
        .where(eq(schema.knowledgeItems.key, kanaKey('a')));
    },
  );

  it('resolves kana ids to knowledge item ids', { timeout: 120000 }, async () => {
    const { db, seed } = need();
    await seed.ensureKanaSeeded(db);

    const ids = await seed.resolveKanaItemIds(db, ['a', 'ka', 'zi', 'kya']);
    expect(ids.size).toBe(4);
    for (const kanaId of ['a', 'ka', 'zi', 'kya']) {
      expect(ids.get(kanaId), kanaId).toMatch(
        /^[0-9a-f-]{36}$/,
      );
    }
    expect(new Set(ids.values()).size).toBe(4);
  });

  it('returns an empty map for no input', { timeout: 60000 }, async () => {
    const { db, seed } = need();
    expect((await seed.resolveKanaItemIds(db, [])).size).toBe(0);
  });

  it(
    'stores the reading and both scripts for each kana',
    { timeout: 60000 },
    async () => {
      const { db, schema, seed } = need();
      await seed.ensureKanaSeeded(db);

      const [row] = await db
        .select()
        .from(schema.knowledgeItems)
        .where(eq(schema.knowledgeItems.key, kanaKey('sya')));
      expect(row?.canonicalForm).toBe('しゃ');
      expect(row?.metadata).toMatchObject({
        hiragana: 'しゃ',
        katakana: 'シャ',
        romaji: 'sha',
        group: 'youon',
      });
    },
  );

  it(
    'keeps kana keys distinct from other knowledge types',
    { timeout: 60000 },
    async () => {
      const { db, schema, seed } = need();
      await seed.ensureKanaSeeded(db);

      const rows = await db
        .select({ type: schema.knowledgeItems.type })
        .from(schema.knowledgeItems)
        .where(like(schema.knowledgeItems.key, 'kana\\_%'));
      for (const row of rows) {
        expect(row.type).toBe('KANA');
      }
      expect(rows.length).toBeGreaterThanOrEqual(KANA.length);
    },
  );
});
