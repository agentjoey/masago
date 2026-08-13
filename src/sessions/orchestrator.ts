import type { AppConfig } from '../config/index.js';
import type { CorrectionTurnHooks } from '../corrections/index.js';
import type { Executor } from '../db/index.js';
import {
  learnerProfilesRepo,
  sessionsRepo,
  turnsRepo,
} from '../db/index.js';
import type { LearnerProfile } from '../db/schema/learner.js';
import type { Session } from '../db/schema/session.js';
import type { Logger } from '../observability/index.js';
import type { TempFileOptions } from '../speech/tempFiles.js';
import type { SpeechToTextProvider } from '../speech/stt/types.js';
import type { TextToSpeechProvider } from '../speech/tts/types.js';
import type { UsageRecordInput } from '../usage/types.js';
import {
  hintLevelFor,
  isHintRequest,
  policyFor,
  type HintLevel,
} from './modes.js';
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
  corrections?: CorrectionTurnHooks;
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
  tutor?: Tutor;
  corrections?: CorrectionTurnHooks;
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

const MODE_SWITCH_REPLIES = {
  CONVERSATION: '已切换到自由对话模式（Conversation）。',
  COACH: '已切换到 Coach 模式。',
  CHALLENGE:
    '已切换到挑战模式（Challenge）。默认全日语进行；卡壳时发送「ヒント」可获得分级提示。',
} as const;

const COACH_FLUSH_REQUEST_TEXT = '添削をお願いします。';
const SESSION_ENDING_REQUEST_TEXT = '今日はありがとうございました。またね。';
const NO_PENDING_CORRECTIONS_REPLY = '现在没有待呈现的纠错。';
const NO_ACTIVE_SESSION_REPLY = '当前没有进行中的会话。';
const SESSION_ENDED_REPLY = '会话已结束。';

async function ensureLearner(
  deps: OrchestratorDeps,
  telegramUserId: number,
): Promise<LearnerProfile> {
  const existing = await learnerProfilesRepo.findByTelegramUserId(
    deps.executor,
    telegramUserId,
  );
  if (existing !== undefined) {
    return existing;
  }
  const created = await learnerProfilesRepo.upsert(deps.executor, {
    telegramUserId,
  });
  deps.logger.info('learner profile created', { learnerId: created.id });
  return created;
}

async function resolveSession(
  deps: OrchestratorDeps,
  learnerId: string,
): Promise<{ session: Session; newSession: boolean }> {
  const { executor, config, logger } = deps;
  const idleMs = config.session.idleMinutes * 60_000;

  const active = await sessionsRepo.findActiveByLearner(executor, learnerId);
  if (active !== undefined) {
    const idleForMs = Date.now() - active.lastActivityAt.getTime();
    if (idleForMs <= idleMs) {
      await sessionsRepo.touch(executor, active.id);
      return { session: active, newSession: false };
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
  return { session: created, newSession: true };
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
    ...(voice.corrections !== undefined
      ? { corrections: voice.corrections }
      : {}),
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
  const learner = await ensureLearner(deps, input.telegramUserId);
  const { session, newSession } = await resolveSession(deps, learner.id);

  if (input.kind === 'voice') {
    return handleVoiceMessage(deps, input, session.id, newSession);
  }

  const text = input.text ?? '';
  const policy = policyFor(session.mode, learner, deps.config.correction);

  let hintLevel: HintLevel | undefined;
  if (policy.hintLadder && isHintRequest(text)) {
    const previousHints = await turnsRepo.countByTranscript(
      deps.executor,
      session.id,
      text.trim(),
    );
    hintLevel = hintLevelFor(previousHints);
  }

  const { turnId, reply } = await runTextTurn(
    {
      executor: deps.executor,
      logger: deps.logger,
      ...(deps.tutor !== undefined ? { tutor: deps.tutor } : {}),
      ...(deps.corrections !== undefined
        ? { corrections: deps.corrections }
        : {}),
    },
    {
      sessionId: session.id,
      telegramMessageId: input.telegramMessageId,
      text,
      modePolicy: policy,
      ...(hintLevel !== undefined ? { hintLevel } : {}),
    },
  );
  return { reply, sessionId: session.id, turnId, newSession, replySent: false };
}

export interface SessionCommands {
  switchToConversation(telegramUserId: number): Promise<string>;
  switchToCoach(
    telegramUserId: number,
    telegramMessageId: number,
  ): Promise<string>;
  switchToChallenge(telegramUserId: number): Promise<string>;
  endSession(
    telegramUserId: number,
    telegramMessageId: number,
  ): Promise<string>;
}

async function flushWithTutor(
  deps: OrchestratorDeps,
  input: {
    learner: LearnerProfile;
    sessionId: string;
    telegramMessageId: number;
    requestText: string;
    rawTranscript: string;
    explicitRequest?: boolean;
    sessionEnding?: boolean;
  },
): Promise<{ reply: string; surfaced: boolean; tutorReply?: string }> {
  const { executor } = deps;
  if (deps.tutor === undefined || deps.corrections === undefined) {
    return { reply: '', surfaced: false };
  }
  const turn = await turnsRepo.create(executor, {
    sessionId: input.sessionId,
    telegramMessageId: input.telegramMessageId,
    inputType: 'TEXT',
    rawTranscript: input.rawTranscript,
  });
  const directive = await deps.corrections.prepareSurfacing({
    turnId: turn.id,
    sessionId: input.sessionId,
    ...(input.explicitRequest !== undefined
      ? { explicitRequest: input.explicitRequest }
      : {}),
    ...(input.sessionEnding !== undefined
      ? { sessionEnding: input.sessionEnding }
      : {}),
  });
  if (directive.action === 'HOLD') {
    await turnsRepo.updateStatus(executor, turn.id, 'COMPLETED');
    return { reply: '', surfaced: false };
  }
  const session = await sessionsRepo.getSessionCorrectionContext(
    executor,
    input.sessionId,
  );
  if (session === undefined) {
    throw new Error('command flush: session not found');
  }
  const response = await deps.tutor.respond({
    rawTranscript: input.requestText,
    normalizedTranscript: input.requestText,
    surfacingDirective: directive,
    modePolicy: policyFor(session.mode, input.learner, deps.config.correction),
  });
  await deps.corrections.finalizeSurfacing({
    turnId: turn.id,
    sessionId: input.sessionId,
    directive,
    detectedIssues: response.detectedIssues ?? [],
  });
  const reply = response.correctionCard
    ? `${response.replyText}\n\n${response.correctionCard}`
    : response.replyText;
  await turnsRepo.updateStatus(executor, turn.id, 'COMPLETED', {
    replyText: reply,
  });
  return { reply, surfaced: true, tutorReply: response.replyText };
}

export function createCommandHandlers(deps: OrchestratorDeps): SessionCommands {
  const { executor } = deps;

  async function switchToConversation(telegramUserId: number): Promise<string> {
    const learner = await ensureLearner(deps, telegramUserId);
    const { session } = await resolveSession(deps, learner.id);
    if (session.mode !== 'CONVERSATION') {
      await sessionsRepo.setMode(executor, session.id, 'CONVERSATION');
    }
    return MODE_SWITCH_REPLIES.CONVERSATION;
  }

  async function switchToChallenge(telegramUserId: number): Promise<string> {
    const learner = await ensureLearner(deps, telegramUserId);
    const { session } = await resolveSession(deps, learner.id);
    if (session.mode !== 'CHALLENGE') {
      await sessionsRepo.setMode(executor, session.id, 'CHALLENGE');
    }
    return MODE_SWITCH_REPLIES.CHALLENGE;
  }

  async function switchToCoach(
    telegramUserId: number,
    telegramMessageId: number,
  ): Promise<string> {
    const learner = await ensureLearner(deps, telegramUserId);
    const { session } = await resolveSession(deps, learner.id);
    if (session.mode !== 'COACH') {
      await sessionsRepo.setMode(executor, session.id, 'COACH');
    }
    const flushed = await flushWithTutor(deps, {
      learner,
      sessionId: session.id,
      telegramMessageId,
      requestText: COACH_FLUSH_REQUEST_TEXT,
      rawTranscript: '/coach',
      explicitRequest: true,
    });
    if (!flushed.surfaced) {
      const suffix =
        deps.tutor !== undefined && deps.corrections !== undefined
          ? NO_PENDING_CORRECTIONS_REPLY
          : '';
      return `${MODE_SWITCH_REPLIES.COACH}${suffix}`;
    }
    return `${MODE_SWITCH_REPLIES.COACH}\n\n${flushed.reply}`;
  }

  async function endSession(
    telegramUserId: number,
    telegramMessageId: number,
  ): Promise<string> {
    const learner = await learnerProfilesRepo.findByTelegramUserId(
      executor,
      telegramUserId,
    );
    if (learner === undefined) {
      return NO_ACTIVE_SESSION_REPLY;
    }
    const session = await sessionsRepo.findActiveByLearner(
      executor,
      learner.id,
    );
    if (session === undefined) {
      return NO_ACTIVE_SESSION_REPLY;
    }
    const flushed = await flushWithTutor(deps, {
      learner,
      sessionId: session.id,
      telegramMessageId,
      requestText: SESSION_ENDING_REQUEST_TEXT,
      rawTranscript: '/end',
      sessionEnding: true,
    });
    await sessionsRepo.close(executor, session.id, flushed.tutorReply);
    deps.logger.info('session ended by command', { sessionId: session.id });
    return flushed.surfaced ? flushed.reply : SESSION_ENDED_REPLY;
  }

  return {
    switchToConversation,
    switchToCoach,
    switchToChallenge,
    endSession,
  };
}
