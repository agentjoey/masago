import { pgEnum } from 'drizzle-orm/pg-core';

export const sessionMode = pgEnum('session_mode', [
  'CONVERSATION',
  'COACH',
  'CHALLENGE',
]);

export const sessionStatus = pgEnum('session_status', ['ACTIVE', 'CLOSED']);

export const turnInputType = pgEnum('turn_input_type', ['TEXT', 'VOICE']);

export const turnStatus = pgEnum('turn_status', [
  'RECEIVED',
  'AUDIO_READY',
  'AUDIO_NORMALIZED',
  'STT_DONE',
  'LLM_DONE',
  'PERSISTED',
  'TEXT_SENT',
  'VOICE_SENT',
  'COMPLETED',
  'FAILED',
]);

export const knowledgeType = pgEnum('knowledge_type', [
  'VOCABULARY',
  'GRAMMAR',
  'EXPRESSION',
  'ERROR_PATTERN',
]);

export const learningEventType = pgEnum('learning_event_type', [
  'INTRODUCED',
  'REVIEWED',
  'USER_ERROR',
  'USER_CORRECT',
  'RETRY_SUCCEEDED',
  'FAILED_RECALL',
  'USED_WITH_HINT',
  'USED_SPONTANEOUSLY',
  'MASTERED',
]);

export const importance = pgEnum('importance', ['LOW', 'MEDIUM', 'HIGH']);

export const retryStatus = pgEnum('retry_status', [
  'NONE',
  'REQUESTED',
  'SUCCEEDED',
  'FAILED',
]);

export const reviewState = pgEnum('review_state', [
  'NEW',
  'LEARNING',
  'REVIEW',
  'MASTERED',
]);

export const planStatus = pgEnum('plan_status', [
  'DRAFT',
  'ACTIVE',
  'COMPLETED',
  'ABANDONED',
]);

export const planItemType = pgEnum('plan_item_type', [
  'REVIEW',
  'NEW',
  'CHALLENGE',
]);

export const updateStatus = pgEnum('update_status', [
  'RECEIVED',
  'PROCESSING',
  'PROCESSED',
  'FAILED',
]);

export const jobStatus = pgEnum('job_status', [
  'PENDING',
  'RUNNING',
  'DONE',
  'FAILED',
]);
