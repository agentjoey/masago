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
  /**
   * 今の一輪が始まった時刻。`/kana` `/review` など**自分から入ってきた**
   * ところで打ち直す。輪の長さはここからの作答数で数える。
   *
   * 時間窓（直近 30 分）で数えていた頃は、一輪ぶん答えたあと窓が満杯の
   * ままになり、次の `/review` が毎回一問で切れていた。輪の起点は
   * 時刻の引き算ではなく、利用者が入ってきたその瞬間。
   */
  roundStartedAt: timestamp('round_started_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type LearnerProfile = typeof learnerProfiles.$inferSelect;
export type NewLearnerProfile = typeof learnerProfiles.$inferInsert;
