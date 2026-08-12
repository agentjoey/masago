import { bigint, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const learnerProfiles = pgTable('learner_profiles', {
  id: uuid('id').defaultRandom().primaryKey(),
  telegramUserId: bigint('telegram_user_id', { mode: 'number' })
    .notNull()
    .unique(),
  levels: jsonb('levels'),
  goals: jsonb('goals'),
  preferences: jsonb('preferences'),
  profileSummary: text('profile_summary'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type LearnerProfile = typeof learnerProfiles.$inferSelect;
export type NewLearnerProfile = typeof learnerProfiles.$inferInsert;
