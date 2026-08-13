import {
  learningEvents,
  type LearningEvent,
  type NewLearningEvent,
} from '../schema/learning.js';
import type { Executor } from './executor.js';

export async function insertMany(
  tx: Executor,
  events: NewLearningEvent[],
): Promise<LearningEvent[]> {
  if (events.length === 0) {
    return [];
  }
  return tx
    .insert(learningEvents)
    .values(events)
    .onConflictDoNothing({ target: learningEvents.dedupeKey })
    .returning();
}
