import type { AppConfig } from '../config/index.js';
import type { Executor } from '../db/index.js';
import {
  learnerProfilesRepo,
  sessionsRepo,
  turnsRepo,
} from '../db/index.js';
import type { Logger } from '../observability/index.js';

export interface OrchestratorDeps {
  config: AppConfig;
  executor: Executor;
  logger: Logger;
}

export interface IncomingMessage {
  telegramUserId: number;
  telegramMessageId: number;
  kind: 'text' | 'voice';
  text?: string;
}

export interface OrchestratorResult {
  reply: string;
  sessionId: string;
  turnId: string;
  newSession: boolean;
}

export const VOICE_NOT_ENABLED_REPLY = '语音功能尚未启用';

async function resolveSession(
  deps: OrchestratorDeps,
  learnerId: string,
): Promise<{ sessionId: string; newSession: boolean }> {
  const { executor, config, logger } = deps;
  const idleMs = config.session.idleMinutes * 60_000;

  const active = await sessionsRepo.findActiveByLearner(executor, learnerId);
  if (active !== undefined) {
    const idleForMs = Date.now() - active.lastActivityAt.getTime();
    if (idleForMs <= idleMs) {
      await sessionsRepo.touch(executor, active.id);
      return { sessionId: active.id, newSession: false };
    }
    logger.info('session idle timeout, closing', {
      sessionId: active.id,
      idleForMinutes: Math.floor(idleForMs / 60_000),
    });
    await sessionsRepo.close(executor, active.id);
  }

  const created = await sessionsRepo.create(executor, {
    learnerId,
    mode: 'CONVERSATION',
  });
  return { sessionId: created.id, newSession: true };
}

export async function handleIncomingMessage(
  deps: OrchestratorDeps,
  input: IncomingMessage,
): Promise<OrchestratorResult> {
  const { executor, logger } = deps;

  let learner = await learnerProfilesRepo.findByTelegramUserId(
    executor,
    input.telegramUserId,
  );
  if (learner === undefined) {
    learner = await learnerProfilesRepo.upsert(executor, {
      telegramUserId: input.telegramUserId,
    });
    logger.info('learner profile created', { learnerId: learner.id });
  }

  const { sessionId, newSession } = await resolveSession(deps, learner.id);

  if (input.kind === 'voice') {
    const turn = await turnsRepo.create(executor, {
      sessionId,
      telegramMessageId: input.telegramMessageId,
      inputType: 'VOICE',
    });
    await turnsRepo.updateStatus(executor, turn.id, 'COMPLETED', {
      replyText: VOICE_NOT_ENABLED_REPLY,
    });
    return { reply: VOICE_NOT_ENABLED_REPLY, sessionId, turnId: turn.id, newSession };
  }

  const text = input.text ?? '';
  const turn = await turnsRepo.create(executor, {
    sessionId,
    telegramMessageId: input.telegramMessageId,
    inputType: 'TEXT',
    rawTranscript: text,
  });
  const reply = `echo: ${text}`;
  await turnsRepo.updateStatus(executor, turn.id, 'COMPLETED', { replyText: reply });
  return { reply, sessionId, turnId: turn.id, newSession };
}
