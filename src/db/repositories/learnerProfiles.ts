import { eq, sql } from 'drizzle-orm';
import {
  learnerProfiles,
  type LearnerProfile,
  type NewLearnerProfile,
} from '../schema/learner.js';
import type { Executor } from './executor.js';

export async function findByTelegramUserId(
  tx: Executor,
  telegramUserId: number,
): Promise<LearnerProfile | undefined> {
  const [row] = await tx
    .select()
    .from(learnerProfiles)
    .where(eq(learnerProfiles.telegramUserId, telegramUserId))
    .limit(1);
  return row;
}

export async function upsert(
  tx: Executor,
  input: NewLearnerProfile & { telegramUserId: number },
): Promise<LearnerProfile> {
  const [row] = await tx
    .insert(learnerProfiles)
    .values(input)
    .onConflictDoUpdate({
      target: learnerProfiles.telegramUserId,
      set: {
        levels: input.levels,
        goals: input.goals,
        preferences: input.preferences,
        profileSummary: input.profileSummary,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  if (!row) {
    throw new Error('learner_profiles upsert returned no row');
  }
  return row;
}
