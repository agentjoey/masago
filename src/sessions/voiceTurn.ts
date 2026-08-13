import {
  asRetryTurnHooks,
  type CorrectionTurnHooks,
  type NewPendingIssue,
  type RetryEvaluationPreparation,
  type SurfacingDirective,
} from '../corrections/index.js';
import type { Turn } from '../db/schema/session.js';
import type { Logger } from '../observability/index.js';
import type { HintLevel, ModePolicy } from './modes.js';
import type { NormalizedAudio } from '../speech/normalizer.js';
import { normalizeForStt } from '../speech/normalizer.js';
import type { TempFileOptions, Workspace } from '../speech/tempFiles.js';
import { withTurnWorkspace } from '../speech/tempFiles.js';
import type { AudioFileRef } from '../speech/types.js';
import type { SpeechToTextProvider } from '../speech/stt/types.js';
import type { TextToSpeechProvider, VoiceConfig } from '../speech/tts/types.js';
import type { UsageRecordInput } from '../usage/types.js';
import { runTurn, type TurnStep, type TurnStore } from './turnRunner.js';
import type { ChainStatus } from './turnStateMachine.js';

export interface VoiceFileMeta {
  mimeType?: string;
  fileSize?: number;
  durationSeconds?: number;
}

export interface TelegramFileRef {
  file_path?: string;
  file_size?: number;
}

export interface VoiceFileApi {
  getFile(fileId: string): Promise<TelegramFileRef>;
}

export interface VoiceDownloader {
  download(
    fileId: string,
    destPath: string,
  ): Promise<{ bytes: number; container: string }>;
}

export interface OutboundVoice {
  path?: string;
  bytes?: Buffer;
  format: string;
}

export interface TutorHintRequest {
  level: HintLevel;
}

export interface TutorRequest {
  rawTranscript: string;
  normalizedTranscript: string;
  surfacingDirective?: SurfacingDirective;
  retryEvaluationRequest?: RetryEvaluationPreparation;
  modePolicy?: ModePolicy;
  hint?: TutorHintRequest;
  /** 既知の knowledgeKey。モデルに再利用させ、キーの揺れを防ぐ（§3.3）。 */
  knownKnowledgeKeys?: readonly string[];
}

export interface TutorRetryEvaluation {
  succeeded: boolean;
  feedback: string | null;
}

export interface TutorUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  requestId?: string;
}

export interface TutorResponse {
  replyText: string;
  ttsText?: string;
  detectedIssues?: NewPendingIssue[];
  correctionCard?: string | null;
  retryEvaluation?: TutorRetryEvaluation | null;
  provider: string;
  model: string;
  usage: TutorUsage;
}

export interface Tutor {
  readonly name?: string;
  readonly model?: string;
  respond(request: TutorRequest): Promise<TutorResponse>;
}

export type NormalizeAudioFn = (
  input: AudioFileRef,
  supportedInputFormats: readonly string[],
) => Promise<NormalizedAudio>;

export interface VoiceTurnServices {
  downloader: VoiceDownloader;
  stt: SpeechToTextProvider;
  tts: TextToSpeechProvider;
  tutor: Tutor;
  corrections?: CorrectionTurnHooks;
  voice: VoiceConfig;
  sendText(text: string): Promise<void>;
  sendVoice(audio: OutboundVoice): Promise<void>;
  persist?(ctx: VoiceTurnContext): Promise<void>;
  persistTelegramFileId?(turnId: string, fileId: string): Promise<void>;
  normalizeAudio?: NormalizeAudioFn;
  normalizeTranscript?(rawText: string): Promise<string>;
  recordUsage?(usage: UsageRecordInput): Promise<void>;
}

export interface VoiceTurnContext {
  turn: Turn;
  fileId: string;
  workspace: Workspace;
  durationSeconds?: number;
  audio?: AudioFileRef & { bytes?: number };
  sttAudio?: AudioFileRef;
  rawTranscript?: string;
  normalizedTranscript?: string;
  replyText?: string;
  ttsText?: string;
  surfacingDirective?: SurfacingDirective;
  correctionCard?: string | null;
}

export const VOICE_DOWNLOAD_FAILED_REPLY =
  '语音下载或校验失败，请重新发送，或改用文字输入。';
export const VOICE_REMUX_FAILED_REPLY =
  '语音格式处理失败，请重新发送，或改用文字输入。';
export const STT_FAILED_REPLY = '语音识别失败，请重新发送，或改用文字输入。';
export const LLM_FAILED_REPLY = '抱歉，本轮暂时无法完成，请稍后再试。';
export const PERSIST_FAILED_REPLY = '本轮回复已生成，但记录可能未保存。';

export function voiceFailureReply(failedAt: ChainStatus): string {
  switch (failedAt) {
    case 'AUDIO_READY':
      return VOICE_DOWNLOAD_FAILED_REPLY;
    case 'AUDIO_NORMALIZED':
      return VOICE_REMUX_FAILED_REPLY;
    case 'STT_DONE':
      return STT_FAILED_REPLY;
    case 'LLM_DONE':
      return LLM_FAILED_REPLY;
    case 'PERSISTED':
      return PERSIST_FAILED_REPLY;
    default:
      return '';
  }
}

async function recordFailedCall(
  services: VoiceTurnServices,
  operation: string,
  provider: { readonly name: string; readonly model: string },
  cause: unknown,
): Promise<void> {
  await services.recordUsage?.({
    provider: provider.name,
    model: provider.model,
    operation,
    success: false,
    errorCode: cause instanceof Error ? cause.name : 'Error',
  });
}

export function buildVoiceTurnSteps(
  services: VoiceTurnServices,
): TurnStep<VoiceTurnContext>[] {
  const normalizeAudio = services.normalizeAudio ?? normalizeForStt;
  const normalizeTranscript =
    services.normalizeTranscript ?? ((raw: string) => Promise.resolve(raw));

  return [
    {
      status: 'AUDIO_READY',
      async execute(ctx) {
        await services.persistTelegramFileId?.(ctx.turn.id, ctx.fileId);
        const destPath = ctx.workspace.path('input.oga');
        const result = await services.downloader.download(ctx.fileId, destPath);
        ctx.audio = {
          path: destPath,
          container: result.container,
          bytes: result.bytes,
        };
      },
    },
    {
      status: 'AUDIO_NORMALIZED',
      async execute(ctx) {
        if (ctx.audio === undefined) {
          throw new Error('audio missing from voice turn context');
        }
        const normalized = await normalizeAudio(
          { path: ctx.audio.path, container: ctx.audio.container },
          services.stt.supportedInputFormats,
        );
        ctx.sttAudio = { path: normalized.path, container: normalized.container };
      },
    },
    {
      status: 'STT_DONE',
      async execute(ctx) {
        if (ctx.sttAudio === undefined) {
          throw new Error('normalized audio missing from voice turn context');
        }
        let transcript;
        try {
          transcript = await services.stt.transcribe(ctx.sttAudio, {
            language: 'ja',
            durationSeconds: ctx.durationSeconds,
          });
        } catch (cause) {
          await recordFailedCall(services, 'stt', services.stt, cause);
          throw cause;
        }
        const normalizedText = await normalizeTranscript(transcript.rawText);
        ctx.rawTranscript = transcript.rawText;
        ctx.normalizedTranscript = normalizedText;
        return {
          patch: {
            rawTranscript: transcript.rawText,
            normalizedTranscript: normalizedText,
          },
          requestId: transcript.usage.requestId,
          usage: {
            provider: transcript.provider,
            model: transcript.model,
            operation: 'stt',
            audioInputSeconds:
              ctx.durationSeconds ?? transcript.usage.audioSeconds,
            success: true,
            requestId: transcript.usage.requestId,
          },
        };
      },
    },
    {
      status: 'LLM_DONE',
      async execute(ctx) {
        if (ctx.rawTranscript === undefined) {
          throw new Error('raw transcript missing from voice turn context');
        }
        let response;
        try {
          const retryHooks = services.corrections
            ? asRetryTurnHooks(services.corrections)
            : undefined;
          const retryPreparation = retryHooks
            ? await retryHooks.prepareRetryEvaluation({
                sessionId: ctx.turn.sessionId,
              })
            : undefined;
          const directive = services.corrections
            ? await services.corrections.prepareSurfacing({
                turnId: ctx.turn.id,
                sessionId: ctx.turn.sessionId,
              })
            : undefined;
          ctx.surfacingDirective = directive;
          response = await services.tutor.respond({
            rawTranscript: ctx.rawTranscript,
            normalizedTranscript:
              ctx.normalizedTranscript ?? ctx.rawTranscript,
            ...(directive !== undefined
              ? { surfacingDirective: directive }
              : {}),
            ...(retryPreparation !== undefined
              ? { retryEvaluationRequest: retryPreparation }
              : {}),
          });
          if (retryHooks !== undefined && retryPreparation !== undefined) {
            await retryHooks.finalizeTurnCorrections({
              retryEvaluation: {
                turnId: ctx.turn.id,
                sessionId: ctx.turn.sessionId,
                preparation: retryPreparation,
                evaluation: response.retryEvaluation ?? null,
              },
              surfacing: {
                turnId: ctx.turn.id,
                sessionId: ctx.turn.sessionId,
                directive: directive ?? { action: 'HOLD' },
                detectedIssues: response.detectedIssues ?? [],
              },
            });
          } else {
            await services.corrections?.finalizeSurfacing({
              turnId: ctx.turn.id,
              sessionId: ctx.turn.sessionId,
              directive: directive ?? { action: 'HOLD' },
              detectedIssues: response.detectedIssues ?? [],
            });
          }
        } catch (cause) {
          await recordFailedCall(services, 'llm', {
            name: services.tutor.name ?? 'llm',
            model: services.tutor.model ?? 'unknown',
          }, cause);
          throw cause;
        }
        ctx.replyText = response.replyText;
        ctx.ttsText = response.ttsText;
        ctx.correctionCard = response.correctionCard ?? null;
        return {
          patch: { replyText: response.replyText },
          requestId: response.usage.requestId,
          usage: {
            provider: response.provider,
            model: response.model,
            operation: 'llm',
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
            cacheReadTokens: response.usage.cacheReadTokens,
            cacheWriteTokens: response.usage.cacheWriteTokens,
            success: true,
            requestId: response.usage.requestId,
          },
        };
      },
    },
    {
      status: 'PERSISTED',
      async execute(ctx) {
        await services.persist?.(ctx);
      },
    },
    {
      status: 'TEXT_SENT',
      async execute(ctx) {
        if (ctx.replyText === undefined) {
          throw new Error('reply text missing from voice turn context');
        }
        const text = ctx.correctionCard
          ? `${ctx.replyText}\n\n${ctx.correctionCard}`
          : ctx.replyText;
        await services.sendText(text);
      },
    },
    {
      status: 'VOICE_SENT',
      async execute(ctx) {
        const ttsText = ctx.ttsText ?? ctx.replyText;
        if (ttsText === undefined) {
          throw new Error('reply text missing from voice turn context');
        }
        let audio;
        try {
          audio = await services.tts.synthesize(ttsText, services.voice);
        } catch (cause) {
          await recordFailedCall(services, 'tts', services.tts, cause);
          throw cause;
        }
        const usage: UsageRecordInput = {
          provider: audio.provider,
          model: audio.model,
          operation: 'tts',
          ttsCharacters: audio.usage.characters,
          success: true,
          requestId: audio.usage.requestId,
        };
        let outbound: OutboundVoice;
        if (audio.bytes !== undefined) {
          const path = await ctx.workspace.writeFile('reply.mp3', audio.bytes);
          outbound = { path, bytes: audio.bytes, format: audio.format };
        } else {
          outbound = { path: audio.path, format: audio.format };
        }
        try {
          await services.sendVoice(outbound);
        } catch (cause) {
          await services.recordUsage?.(usage);
          throw cause;
        }
        return { requestId: audio.usage.requestId, usage };
      },
    },
    {
      status: 'COMPLETED',
      execute() {
        return Promise.resolve();
      },
    },
  ];
}

export interface RunVoiceTurnDeps {
  store: TurnStore;
  services: VoiceTurnServices;
  fileId: string;
  logger: Logger;
  recordUsage?(usage: UsageRecordInput): Promise<void>;
  workspaceOptions?: TempFileOptions;
  durationSeconds?: number;
}

export interface VoiceTurnResult {
  turn: Turn;
  rawTranscript?: string;
  normalizedTranscript?: string;
  replyText?: string;
}

export async function runVoiceTurn(
  deps: RunVoiceTurnDeps,
): Promise<VoiceTurnResult> {
  const services: VoiceTurnServices = {
    ...deps.services,
    recordUsage: deps.services.recordUsage ?? deps.recordUsage,
  };
  return withTurnWorkspace(async (workspace) => {
    const steps = buildVoiceTurnSteps(services);
    const turn = await runTurn<VoiceTurnContext>({
      store: deps.store,
      steps,
      buildContext: (loaded) => ({
        turn: loaded,
        fileId: deps.fileId,
        workspace,
        durationSeconds: deps.durationSeconds,
        rawTranscript: loaded.rawTranscript ?? undefined,
        normalizedTranscript: loaded.normalizedTranscript ?? undefined,
        replyText: loaded.replyText ?? undefined,
      }),
      logger: deps.logger,
      recordUsage: deps.recordUsage,
    });
    return {
      turn,
      rawTranscript: turn.rawTranscript ?? undefined,
      normalizedTranscript: turn.normalizedTranscript ?? undefined,
      replyText: turn.replyText ?? undefined,
    };
  }, deps.workspaceOptions);
}
