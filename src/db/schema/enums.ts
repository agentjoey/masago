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
  // S0 五十音。V2 §9.2 で追加。仮名は語彙でも文法でもなく、
  // 認読・聴辨・字形識別という独自の能力軸を持つため別型にする。
  'KANA',
  'VOCABULARY',
  'GRAMMAR',
  'EXPRESSION',
  'ERROR_PATTERN',
  // 分野別語彙（商务谈判 / 高尔夫 / AI）。VOCABULARY と分けるのは、
  // `countDue(…, 'VOCABULARY')` のような型で引く問い合わせに混ざると
  // /today や /vocab の件数が狂うため——主線の進度は主線だけで数える。
  'DOMAIN',
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

// FSRS の State と 1:1 で対応させる（New/Learning/Review/Relearning）。
// MASTERED は FSRS の状態ではなく、掌握度から導出する本システム独自の段階。
// 同じ列に混ぜると復習スケジュールと学習段階が区別できなくなるため併存させる。
export const reviewState = pgEnum('review_state', [
  'NEW',
  'LEARNING',
  'REVIEW',
  'RELEARNING',
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

/** 誤りを見つけたのが模型か、規則か（§8）。 */
export const issueSource = pgEnum('issue_source', ['LLM', 'RULE']);
