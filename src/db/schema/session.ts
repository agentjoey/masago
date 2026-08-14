import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  importance,
  retryStatus,
  sessionMode,
  sessionStatus,
  turnInputType,
  turnStatus,
  issueSource,
} from './enums.js';
import { learnerProfiles } from './learner.js';
import { knowledgeItems } from './learning.js';

export const sessions = pgTable('sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  learnerId: uuid('learner_id')
    .notNull()
    .references(() => learnerProfiles.id),
  mode: sessionMode('mode').notNull(),
  topic: text('topic'),
  status: sessionStatus('status').default('ACTIVE').notNull(),
  summary: text('summary'),
  startedAt: timestamp('started_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
});

export const turns = pgTable(
  'turns',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id),
    telegramMessageId: bigint('telegram_message_id', { mode: 'number' })
      .notNull()
      .unique(),
    telegramFileId: text('telegram_file_id'),
    inputType: turnInputType('input_type').notNull(),
    status: turnStatus('status').default('RECEIVED').notNull(),
    rawTranscript: text('raw_transcript'),
    normalizedTranscript: text('normalized_transcript'),
    replyText: text('reply_text'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index('turns_session_id_idx').on(table.sessionId)],
);

export const detectedIssues = pgTable(
  'detected_issues',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    turnId: uuid('turn_id')
      .notNull()
      .references(() => turns.id),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id),
    knowledgeItemId: uuid('knowledge_item_id').references(
      () => knowledgeItems.id,
    ),
    knowledgeKey: text('knowledge_key').notNull(),
    original: text('original').notNull(),
    recommended: text('recommended').notNull(),
    reason: text('reason'),
    naturalAlternative: text('natural_alternative'),
    importance: importance('importance').default('MEDIUM').notNull(),
    /**
     * 誰が見つけたか。`LLM` か `RULE`（形態素解析＋規則、§8）。
     *
     * 混ぜて保存するので、後から「規則が拾った分だけ」を見たり、
     * 両者の一致率を測ったりできる。区別を持たないと、Error Bank の
     * 信頼度を上げたのか下げたのか確かめようがない。
     */
    source: issueSource('source').default('LLM').notNull(),
    surfacedAt: timestamp('surfaced_at', { withTimezone: true }),
    retryStatus: retryStatus('retry_status').default('NONE').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('detected_issues_turn_key_original_unique').on(
      table.turnId,
      table.knowledgeKey,
      table.original,
    ),
    index('detected_issues_surfaced_at_idx')
      .on(table.surfacedAt)
      .where(sql`${table.surfacedAt} is null`),
  ],
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Turn = typeof turns.$inferSelect;
export type NewTurn = typeof turns.$inferInsert;
export type DetectedIssue = typeof detectedIssues.$inferSelect;
export type NewDetectedIssue = typeof detectedIssues.$inferInsert;
