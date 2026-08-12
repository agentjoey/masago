import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.loadEnvFile();

const { db, pool, closeDb } = await import('../../src/db/index.js');
const schema = await import('../../src/db/schema/index.js');
const telegramUpdatesRepo = await import(
  '../../src/db/repositories/telegramUpdates.js'
);
const turnsRepo = await import('../../src/db/repositories/turns.js');

const RUN = Date.now();
const TELEGRAM_USER_ID = 9_000_000_000 + (RUN % 100_000);
const UPDATE_ID = 9_000_000_000 + (RUN % 100_000);
const MESSAGE_ID = 8_000_000_000 + (RUN % 100_000);

const created = {
  learnerId: '',
  sessionId: '',
  turnId: '',
  knowledgeItemId: '',
};

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  while (typeof current === 'object' && current !== null) {
    if ((current as { code?: string }).code === '23505') {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

beforeAll(async () => {
  await db.execute(sql`select 1`);
});

afterAll(async () => {
  if (created.learnerId) {
    await db
      .delete(schema.reviewQueue)
      .where(eq(schema.reviewQueue.learnerId, created.learnerId));
    await db
      .delete(schema.learningEvents)
      .where(eq(schema.learningEvents.learnerId, created.learnerId));
  }
  if (created.sessionId) {
    await db
      .delete(schema.detectedIssues)
      .where(eq(schema.detectedIssues.sessionId, created.sessionId));
    await db
      .delete(schema.turns)
      .where(eq(schema.turns.sessionId, created.sessionId));
    await db
      .delete(schema.sessions)
      .where(eq(schema.sessions.id, created.sessionId));
  }
  if (created.knowledgeItemId) {
    await db
      .delete(schema.knowledgeItems)
      .where(eq(schema.knowledgeItems.id, created.knowledgeItemId));
  }
  await db
    .delete(schema.telegramUpdates)
    .where(eq(schema.telegramUpdates.updateId, UPDATE_ID));
  if (created.learnerId) {
    await db
      .delete(schema.learnerProfiles)
      .where(eq(schema.learnerProfiles.id, created.learnerId));
  }
  await closeDb();
});

describe('migrations', () => {
  it('runs migrations idempotently on the database', async () => {
    await migrate(db, { migrationsFolder: 'src/db/migrations' });
  });

  it('creates all 12 tables', async () => {
    const rows = await db.execute(
      sql`select table_name from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const names = rows.rows.map((row) => row['table_name']);
    const expected = [
      'learner_profiles',
      'sessions',
      'turns',
      'detected_issues',
      'knowledge_items',
      'learning_events',
      'review_queue',
      'daily_plans',
      'daily_plan_items',
      'telegram_updates',
      'usage_records',
      'outbox_jobs',
    ];
    for (const table of expected) {
      expect(names).toContain(table);
    }
  });

  it('creates the required unique constraints in the database', async () => {
    const constraintRows = await db.execute(
      sql`select conname as name from pg_constraint where contype = 'u'`,
    );
    const indexRows = await db.execute(
      sql`select indexname as name from pg_indexes
          where schemaname = 'public'
            and indexdef ilike 'create unique index%'`,
    );
    const constraints = [
      ...constraintRows.rows.map((row) => row['name']),
      ...indexRows.rows.map((row) => row['name']),
    ];
    const expected = [
      'learner_profiles_telegram_user_id_unique',
      'turns_telegram_message_id_unique',
      'detected_issues_turn_key_original_unique',
      'knowledge_items_type_key_unique',
      'learning_events_dedupe_key_unique',
      'review_queue_learner_item_unique',
      'daily_plans_learner_date_unique',
      'telegram_updates_update_id_unique',
      'outbox_jobs_dedupe_key_unique',
    ];
    for (const name of expected) {
      expect(constraints).toContain(name);
    }
  });
});

describe('connection pool', () => {
  it('takes pool options from config', () => {
    expect(pool.options.max).toBe(2);
    expect(pool.options.idleTimeoutMillis).toBe(15000);
    expect(pool.options.connectionTimeoutMillis).toBe(10000);
  });
});

describe('telegramUpdates.insertIfAbsent', () => {
  it('inserts once and reports inserted=false on duplicate', async () => {
    const first = await telegramUpdatesRepo.insertIfAbsent(db, UPDATE_ID, {
      message: { text: 'こんにちは' },
    });
    expect(first.inserted).toBe(true);
    expect(first.record.updateId).toBe(UPDATE_ID);

    const second = await telegramUpdatesRepo.insertIfAbsent(db, UPDATE_ID, {
      message: { text: 'retry' },
    });
    expect(second.inserted).toBe(false);
    expect(second.record.id).toBe(first.record.id);

    const rows = await db
      .select()
      .from(schema.telegramUpdates)
      .where(eq(schema.telegramUpdates.updateId, UPDATE_ID));
    expect(rows).toHaveLength(1);
  });
});

describe('turns', () => {
  beforeAll(async () => {
    const [learner] = await db
      .insert(schema.learnerProfiles)
      .values({ telegramUserId: TELEGRAM_USER_ID })
      .returning();
    if (!learner) throw new Error('failed to create test learner');
    created.learnerId = learner.id;
    const [session] = await db
      .insert(schema.sessions)
      .values({ learnerId: learner.id, mode: 'CONVERSATION' })
      .returning();
    if (!session) throw new Error('failed to create test session');
    created.sessionId = session.id;
  });

  it('rejects duplicate telegram_message_id with a unique violation', async () => {
    const turn = await turnsRepo.create(db, {
      sessionId: created.sessionId,
      telegramMessageId: MESSAGE_ID,
      inputType: 'TEXT',
    });
    created.turnId = turn.id;

    let error: unknown;
    try {
      await turnsRepo.create(db, {
        sessionId: created.sessionId,
        telegramMessageId: MESSAGE_ID,
        inputType: 'TEXT',
      });
    } catch (caught) {
      error = caught;
    }
    expect(isUniqueViolation(error)).toBe(true);
  });

  it('reads timestamps back as timestamptz values', async () => {
    const found = await turnsRepo.findByTelegramMessageId(db, MESSAGE_ID);
    expect(found).toBeDefined();
    expect(found?.createdAt).toBeInstanceOf(Date);
    expect(found?.updatedAt).toBeInstanceOf(Date);

    const updated = await turnsRepo.updateStatus(db, created.turnId, 'LLM_DONE', {
      rawTranscript: '昨日映画を見るました',
    });
    expect(updated.status).toBe('LLM_DONE');
    expect(updated.rawTranscript).toBe('昨日映画を見るました');
  });
});

describe('review_queue', () => {
  it('rejects duplicate (learner_id, knowledge_item_id)', async () => {
    const [item] = await db
      .insert(schema.knowledgeItems)
      .values({ type: 'GRAMMAR', key: `verb_masu_past_${RUN}` })
      .returning();
    if (!item) throw new Error('failed to create test knowledge item');
    created.knowledgeItemId = item.id;

    const nextReviewAt = new Date();
    await db.insert(schema.reviewQueue).values({
      learnerId: created.learnerId,
      knowledgeItemId: item.id,
      nextReviewAt,
    });

    let error: unknown;
    try {
      await db.insert(schema.reviewQueue).values({
        learnerId: created.learnerId,
        knowledgeItemId: item.id,
        nextReviewAt,
      });
    } catch (caught) {
      error = caught;
    }
    expect(isUniqueViolation(error)).toBe(true);
  });
});
