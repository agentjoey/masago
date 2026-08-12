import {
  handleIncomingMessage,
  VOICE_NOT_ENABLED_REPLY,
  type OrchestratorDeps,
} from './orchestrator.js';

export type {
  IncomingMessage,
  IncomingTextMessage,
  IncomingVoiceMessage,
  OrchestratorDeps,
  OrchestratorResult,
  OrchestratorVoiceDeps,
} from './orchestrator.js';
export { handleIncomingMessage, VOICE_NOT_ENABLED_REPLY };

export type { TextTurnDeps, TextTurnInput, TextTurnResult } from './textTurn.js';
export { runTextTurn } from './textTurn.js';

export {
  assertTransition,
  canTransition,
  chainIndex,
  InvalidTransitionError,
  isChainStatus,
  isTerminal,
  nextStatus,
  TURN_CHAIN,
} from './turnStateMachine.js';
export type { ChainStatus, TurnStatus } from './turnStateMachine.js';

export {
  createDrizzleTurnStore,
  encodeTurnFailure,
  parseTurnFailure,
  runTurn,
  TurnNotFoundError,
  TurnStepFailedError,
} from './turnRunner.js';
export type {
  StepOutcome,
  TurnFailure,
  TurnPatch,
  TurnRunnerDeps,
  TurnStep,
  TurnStore,
} from './turnRunner.js';

export {
  buildVoiceTurnSteps,
  LLM_FAILED_REPLY,
  PERSIST_FAILED_REPLY,
  runVoiceTurn,
  STT_FAILED_REPLY,
  VOICE_DOWNLOAD_FAILED_REPLY,
  VOICE_REMUX_FAILED_REPLY,
  voiceFailureReply,
} from './voiceTurn.js';
export type {
  NormalizeAudioFn,
  OutboundVoice,
  RunVoiceTurnDeps,
  TelegramFileRef,
  Tutor,
  TutorRequest,
  TutorResponse,
  TutorUsage,
  VoiceDownloader,
  VoiceFileApi,
  VoiceFileMeta,
  VoiceTurnContext,
  VoiceTurnResult,
  VoiceTurnServices,
} from './voiceTurn.js';

export interface IncomingMessageContext {
  from?: { id: number };
  message?: {
    message_id: number;
    text?: string;
    voice?: {
      file_id: string;
      mime_type?: string;
      file_size?: number;
      duration?: number;
    };
  };
  api?: {
    getFile(fileId: string): Promise<{ file_path?: string; file_size?: number }>;
  };
  reply(text: string): Promise<unknown>;
  replyWithVoice?(voice: unknown): Promise<unknown>;
}

export function createHandleUpdate(
  deps: OrchestratorDeps,
): (ctx: IncomingMessageContext) => Promise<void> {
  return async (ctx) => {
    const telegramUserId = ctx.from?.id;
    const message = ctx.message;
    if (telegramUserId === undefined || message === undefined) {
      return;
    }
    if (message.text !== undefined) {
      const result = await handleIncomingMessage(deps, {
        telegramUserId,
        telegramMessageId: message.message_id,
        kind: 'text',
        text: message.text,
      });
      await ctx.reply(result.reply);
      return;
    }
    if (message.voice !== undefined) {
      const voice = message.voice;
      const result = await handleIncomingMessage(deps, {
        telegramUserId,
        telegramMessageId: message.message_id,
        kind: 'voice',
        fileId: voice.file_id,
        mimeType: voice.mime_type,
        fileSize: voice.file_size,
        durationSeconds: voice.duration,
        fileApi: ctx.api ?? {
          getFile: () =>
            Promise.reject(new Error('telegram file api unavailable')),
        },
        sendText: async (text) => {
          await ctx.reply(text);
        },
        sendVoice: async (audio) => {
          await ctx.replyWithVoice?.({ path: audio.path, bytes: audio.bytes });
        },
      });
      if (!result.replySent) {
        await ctx.reply(result.reply);
      }
    }
  };
}
