import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { jobStatus, updateStatus } from './enums.js';
import { turns } from './session.js';

export const telegramUpdates = pgTable('telegram_updates', {
  id: uuid('id').defaultRandom().primaryKey(),
  updateId: bigint('update_id', { mode: 'number' }).notNull().unique(),
  payload: jsonb('payload').notNull(),
  status: updateStatus('status').default('RECEIVED').notNull(),
  attempts: integer('attempts').default(0).notNull(),
  error: text('error'),
  receivedAt: timestamp('received_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const usageRecords = pgTable('usage_records', {
  id: uuid('id').defaultRandom().primaryKey(),
  turnId: uuid('turn_id').references(() => turns.id),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  operation: text('operation').notNull(),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  cachedInputTokens: integer('cached_input_tokens').default(0).notNull(),
  audioInputSeconds: numeric('audio_input_seconds'),
  audioOutputSeconds: numeric('audio_output_seconds'),
  ttsCharacters: integer('tts_characters'),
  providerReportedUnits: jsonb('provider_reported_units'),
  estimatedCost: numeric('estimated_cost'),
  currency: text('currency').default('USD').notNull(),
  pricingVersion: text('pricing_version').notNull(),
  latencyMs: integer('latency_ms'),
  success: boolean('success').default(true).notNull(),
  cacheHit: boolean('cache_hit').default(false).notNull(),
  errorCode: text('error_code'),
  requestId: text('request_id'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const outboxJobs = pgTable(
  'outbox_jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    jobType: text('job_type').notNull(),
    dedupeKey: text('dedupe_key').notNull().unique(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    payload: jsonb('payload'),
    status: jobStatus('status').default('PENDING').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('outbox_jobs_status_due_at_idx').on(table.status, table.dueAt),
  ],
);

export type TelegramUpdate = typeof telegramUpdates.$inferSelect;
export type NewTelegramUpdate = typeof telegramUpdates.$inferInsert;
export type UsageRecord = typeof usageRecords.$inferSelect;
export type NewUsageRecord = typeof usageRecords.$inferInsert;
export type OutboxJob = typeof outboxJobs.$inferSelect;
export type NewOutboxJob = typeof outboxJobs.$inferInsert;

/**
 * 合成済み音声の再利用（V2 §5.3）。
 *
 * 保存するのは音声そのものではなく **Telegram の file_id**。一度でも
 * 送った音声は file_id で何度でも送り直せる——再合成も再アップロードも
 * 要らず、保管場所も要らない。Railway は無状態なのでローカルに置いても
 * 再デプロイで消えるし、オブジェクトストレージを足すには早すぎる。
 *
 * 復習キューは設計上「同じ項目」を何ヶ月も繰り返すので、当たる回数が多い。
 */
export const ttsCache = pgTable(
  'tts_cache',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** hash(text + voice_id + model)。声やモデルを変えたら別物になる。 */
    cacheKey: text('cache_key').notNull().unique(),
    text: text('text').notNull(),
    voiceId: text('voice_id').notNull(),
    model: text('model').notNull(),
    telegramFileId: text('telegram_file_id').notNull(),
    useCount: integer('use_count').default(1).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index('tts_cache_last_used_at_idx').on(table.lastUsedAt)],
);

export type TtsCacheEntry = typeof ttsCache.$inferSelect;
