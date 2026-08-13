import {
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  knowledgeType,
  learningEventType,
  planItemType,
  planStatus,
  reviewState,
} from './enums.js';
import { learnerProfiles } from './learner.js';
import { turns } from './session.js';

export const knowledgeItems = pgTable(
  'knowledge_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    type: knowledgeType('type').notNull(),
    key: text('key').notNull(),
    canonicalForm: text('canonical_form'),
    metadata: jsonb('metadata'),
    mastery: doublePrecision('mastery').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('knowledge_items_type_key_unique').on(table.type, table.key),
  ],
);

export const learningEvents = pgTable(
  'learning_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    learnerId: uuid('learner_id')
      .notNull()
      .references(() => learnerProfiles.id),
    turnId: uuid('turn_id').references(() => turns.id),
    knowledgeItemId: uuid('knowledge_item_id').references(
      () => knowledgeItems.id,
    ),
    eventType: learningEventType('event_type').notNull(),
    evidence: jsonb('evidence'),
    dedupeKey: text('dedupe_key').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('learning_events_knowledge_item_id_idx').on(table.knowledgeItemId),
  ],
);

export const reviewQueue = pgTable(
  'review_queue',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    learnerId: uuid('learner_id')
      .notNull()
      .references(() => learnerProfiles.id),
    knowledgeItemId: uuid('knowledge_item_id')
      .notNull()
      .references(() => knowledgeItems.id),
    // ここから下は FSRS の Card をそのまま永続化する（V2 §3.1）。
    // 間隔を計算し直すには前回の状態が全部要る——一つでも欠けると
    // 復習履歴が失われ、毎回 New から数え直すことになる。
    nextReviewAt: timestamp('next_review_at', { withTimezone: true }).notNull(), // Card.due
    intervalDays: integer('interval_days').default(1).notNull(), // Card.scheduled_days
    stability: doublePrecision('stability').default(0).notNull(),
    difficulty: doublePrecision('difficulty').default(0).notNull(),
    elapsedDays: integer('elapsed_days').default(0).notNull(),
    learningSteps: integer('learning_steps').default(0).notNull(),
    reps: integer('reps').default(0).notNull(),
    lapses: integer('lapses').default(0).notNull(),
    // 未復習なら null。0 や epoch で埋めると「大昔に復習した」と誤解される。
    lastReview: timestamp('last_review', { withTimezone: true }),
    priority: doublePrecision('priority').default(0).notNull(),
    state: reviewState('state').default('NEW').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('review_queue_learner_item_unique').on(
      table.learnerId,
      table.knowledgeItemId,
    ),
    index('review_queue_next_review_at_idx').on(table.nextReviewAt),
  ],
);

export const dailyPlans = pgTable(
  'daily_plans',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    learnerId: uuid('learner_id')
      .notNull()
      .references(() => learnerProfiles.id),
    planDate: date('plan_date', { mode: 'string' }).notNull(),
    goal: text('goal'),
    status: planStatus('status').default('DRAFT').notNull(),
    sourceSnapshot: jsonb('source_snapshot'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('daily_plans_learner_date_unique').on(
      table.learnerId,
      table.planDate,
    ),
  ],
);

export const dailyPlanItems = pgTable('daily_plan_items', {
  id: uuid('id').defaultRandom().primaryKey(),
  planId: uuid('plan_id')
    .notNull()
    .references(() => dailyPlans.id, { onDelete: 'cascade' }),
  type: planItemType('type').notNull(),
  knowledgeItemId: uuid('knowledge_item_id').references(
    () => knowledgeItems.id,
  ),
  targetCount: integer('target_count').default(1).notNull(),
  result: jsonb('result'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type KnowledgeItem = typeof knowledgeItems.$inferSelect;
export type NewKnowledgeItem = typeof knowledgeItems.$inferInsert;
export type LearningEvent = typeof learningEvents.$inferSelect;
export type NewLearningEvent = typeof learningEvents.$inferInsert;
export type ReviewQueueEntry = typeof reviewQueue.$inferSelect;
export type NewReviewQueueEntry = typeof reviewQueue.$inferInsert;
export type DailyPlan = typeof dailyPlans.$inferSelect;
export type NewDailyPlan = typeof dailyPlans.$inferInsert;
export type DailyPlanItem = typeof dailyPlanItems.$inferSelect;
export type NewDailyPlanItem = typeof dailyPlanItems.$inferInsert;
