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
  repo: typeof import('../../src/db/repositories/ttsCache.js');
};

let modules: Modules | undefined;
function need(): Modules {
  if (modules === undefined) throw new Error('modules were not loaded');
  return modules;
}

const RUN = Date.now();
const TEXT = `いま-${RUN}`;
const VOICE = 'Japanese_CalmLady';
const MODEL = 'speech-2.8-hd';

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbModule = await import('../../src/db/index.js');
  const schema = await import('../../src/db/schema/index.js');
  const repo = await import('../../src/db/repositories/ttsCache.js');
  modules = { db: dbModule.db, closeDb: dbModule.closeDb, schema, repo };
});

afterAll(async () => {
  if (modules === undefined) return;
  const { db, schema, repo, closeDb } = need();
  await db
    .delete(schema.ttsCache)
    .where(eq(schema.ttsCache.cacheKey, repo.ttsCacheKey(TEXT, VOICE, MODEL)));
  await closeDb();
});

describe.skipIf(!HAS_DB)('tts cache', () => {
  it('misses, remembers, then hits', { timeout: 60000 }, async () => {
    const { db, repo } = need();
    const key = repo.ttsCacheKey(TEXT, VOICE, MODEL);

    expect(await repo.lookup(db, key)).toBeUndefined();

    await repo.remember(db, {
      cacheKey: key,
      text: TEXT,
      voiceId: VOICE,
      model: MODEL,
      telegramFileId: 'AgADBAADqTEST',
    });

    expect(await repo.lookup(db, key)).toBe('AgADBAADqTEST');
  });

  it('counts how often a cached clip is reused', { timeout: 60000 }, async () => {
    const { db, schema, repo } = need();
    const key = repo.ttsCacheKey(TEXT, VOICE, MODEL);
    await repo.lookup(db, key);
    await repo.lookup(db, key);

    const [row] = await db
      .select()
      .from(schema.ttsCache)
      .where(eq(schema.ttsCache.cacheKey, key));
    expect(row?.useCount).toBeGreaterThanOrEqual(3);
  });

  it('is idempotent on remember', { timeout: 60000 }, async () => {
    const { db, repo } = need();
    const key = repo.ttsCacheKey(TEXT, VOICE, MODEL);
    await repo.remember(db, {
      cacheKey: key,
      text: TEXT,
      voiceId: VOICE,
      model: MODEL,
      telegramFileId: 'DIFFERENT',
    });
    // 先に覚えたものを塗り替えない
    expect(await repo.lookup(db, key)).toBe('AgADBAADqTEST');
  });

  // 声やモデルを変えたら別の音。同じ鍵で古い声を配り続けてはいけない。
  it('keys on voice and model, not just text', () => {
    const { repo } = need();
    const a = repo.ttsCacheKey(TEXT, VOICE, MODEL);
    expect(repo.ttsCacheKey(TEXT, 'OtherVoice', MODEL)).not.toBe(a);
    expect(repo.ttsCacheKey(TEXT, VOICE, 'speech-2.8-turbo')).not.toBe(a);
    expect(repo.ttsCacheKey('ちがう', VOICE, MODEL)).not.toBe(a);
  });
});
