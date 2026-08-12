import type { AppConfig } from '../config/index.js';
import type { Executor } from '../db/index.js';
import {
  learnerProfilesRepo,
  sessionsRepo,
  turnsRepo,
} from '../db/index.js';
import type { Logger } from '../observability/index.js';
import type { TempFileOptions } from '../speech/tempFiles.js';
import type { SpeechToTextProvider } from '../speech/stt/types.js';
import type { TextToSpeechProvider } from '../speech/tts/types.js';
import type { UsageRecordInput } from '../usage/types.js';
import { runTextTurn } from './textTurn.js';
import {
  createDrizzleTurnStore,
  TurnStepFailedError,
} from './turnRunner.js';
import {
  runVoiceTurn,
  voiceFailureReply,
  type NormalizeAudioFn,
  type OutboundVoice,
  type Tutor,
  type VoiceDownloader,
  type VoiceFileApi,
  type VoiceFileMeta,
  type VoiceTurnServices,
} from './voiceTurn.js';

export interface OrchestratorVoiceDeps {
  stt: SpeechToTextProvider;
  tts: TextToSpeechProvider;
  tutor: Tutor;
  createDownloader(api: VoiceFileApi, meta: VoiceFileMeta): VoiceDownloader;
  recordUsage?(usage: UsageRecordInput): Promise<void>;
  normalizeAudio?: NormalizeAudioFn;
  normalizeTranscript?(rawText: string): Promise<string>;
  workspaceOptions?: TempFileOptions;
}

export interface OrchestratorDeps {
  config: AppConfig;
  executor: Executor;
  logger: Logger;
  voice?: OrchestratorVoiceDeps;
}

interface IncomingMessageBase {
  telegramUserId: number;
  telegramMessageId: number;
}

export interface IncomingTextMessage extends IncomingMessageBase {
  kind: 'text';
  text?: string;
}

export interface IncomingVoiceMessage extends IncomingMessageBase {
  kind: 'voice';
  fileId: string;
  mimeType?: string;
  fileSize?: number;
  durationSeconds?: number;
  fileApi: VoiceFileApi;
  sendText(text: string): Promise<void>;
  sendVoice(audio: OutboundVoice): Promise<void>;
}

export type IncomingMessage = IncomingTextMessage | IncomingVoiceMessage;

export interface OrchestratorResult {
  reply: string;
  sessionId: string;
  turnId: string;
  newSession: boolean;
  replySent: boolean;
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

async function touchSessionInTransaction(
  executor: Executor,
  sessionId: string,
): Promise<void> {
  if ('transaction' in executor) {
    await executor.transaction(async (tx) => {
      await sessionsRepo.touch(tx, sessionId);
    });
    return;
  }
  await sessionsRepo.touch(executor, sessionId);
}

async function handleVoiceMessage(
  deps: OrchestratorDeps,
  input: IncomingVoiceMessage,
  sessionId: string,
  newSession: boolean,
): Promise<OrchestratorResult> {
  const { executor, logger, voice } = deps;

  const turn = await turnsRepo.create(executor, {
    sessionId,
    telegramMessageId: input.telegramMessageId,
    inputType: 'VOICE',
  });

  if (voice === undefined) {
    await turnsRepo.updateStatus(executor, turn.id, 'COMPLETED', {
      replyText: VOICE_NOT_ENABLED_REPLY,
    });
    await input.sendText(VOICE_NOT_ENABLED_REPLY);
    return {
      reply: VOICE_NOT_ENABLED_REPLY,
      sessionId,
      turnId: turn.id,
      newSession,
      replySent: true,
    };
  }

  const downloader = voice.createDownloader(input.fileApi, {
    mimeType: input.mimeType,
    fileSize: input.fileSize,
    durationSeconds: input.durationSeconds,
  });

  const services: VoiceTurnServices = {
    downloader,
    stt: voice.stt,
    tts: voice.tts,
    tutor: voice.tutor,
    voice: { voiceId: deps.config.tts.minimaxVoiceId },
    sendText: input.sendText,
    sendVoice: input.sendVoice,
    normalizeAudio: voice.normalizeAudio,
    normalizeTranscript: voice.normalizeTranscript,
    recordUsage: voice.recordUsage,
    persist: () => touchSessionInTransaction(executor, sessionId),
    persistTelegramFileId: (turnId, fileId) =>
      turnsRepo.setTelegramFileId(executor, turnId, fileId),
  };

  try {
    const result = await runVoiceTurn({
      store: createDrizzleTurnStore({
        executor,
        telegramMessageId: input.telegramMessageId,
      }),
      services,
      fileId: input.fileId,
      logger,
      recordUsage: voice.recordUsage,
      workspaceOptions: voice.workspaceOptions,
      durationSeconds: input.durationSeconds,
    });
    return {
      reply: result.replyText ?? '',
      sessionId,
      turnId: turn.id,
      newSession,
      replySent: true,
    };
  } catch (error) {
    if (error instanceof TurnStepFailedError) {
      const reply = voiceFailureReply(error.failedAt);
      logger.warn('voice turn degraded', {
        turnId: turn.id,
        failedAt: error.failedAt,
      });
      if (
        error.failedAt !== 'VOICE_SENT' &&
        error.failedAt !== 'TEXT_SENT' &&
        reply !== ''
      ) {
        await input.sendText(reply);
      }
      return {
        reply,
        sessionId,
        turnId: turn.id,
        newSession,
        replySent: true,
      };
    }
    throw error;
  }
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
    return handleVoiceMessage(deps, input, sessionId, newSession);
  }

  const { turnId, reply } = await runTextTurn(
    { executor },
    {
      sessionId,
      telegramMessageId: input.telegramMessageId,
      text: input.text ?? '',
    },
  );
  return { reply, sessionId, turnId, newSession, replySent: false };
}
