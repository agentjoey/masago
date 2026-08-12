import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { Turn } from '../../src/db/schema/session.js';
import type { Logger } from '../../src/observability/index.js';
import { MockSttProvider } from '../../src/speech/stt/mock.js';
import { MockTtsProvider } from '../../src/speech/tts/mock.js';
import { FfmpegError } from '../../src/speech/ffmpeg.js';
import type { AudioFileRef } from '../../src/speech/types.js';
import type { SttOptions, Transcript } from '../../src/speech/stt/types.js';
import type { AudioResult, VoiceConfig } from '../../src/speech/tts/types.js';
import {
  runVoiceTurn,
  type OutboundVoice,
  type Tutor,
  type TutorRequest,
  type VoiceTurnServices,
} from '../../src/sessions/voiceTurn.js';
import {
  TurnStepFailedError,
  type TurnStore,
} from '../../src/sessions/turnRunner.js';
import type { TurnStatus } from '../../src/sessions/turnStateMachine.js';
import { createVoiceDownloader } from '../../src/telegram/voice.js';
import type { UsageRecordInput } from '../../src/usage/types.js';

const RAW_TRANSCRIPT = '昨日友達と映画を見るました';
const NORMALIZED_TRANSCRIPT = '昨日、友達と映画を見ました';
const TUTOR_REPLY = '映画を見ましたね！面白かったですか？';

interface LogRecord {
  level: string;
  msg: string;
  fields?: Record<string, unknown>;
}

function fakeLogger(): Logger & { records: LogRecord[] } {
  const records: LogRecord[] = [];
  const make =
    (level: string) =>
    (msg: string, fields?: Record<string, unknown>) => {
      records.push({ level, msg, fields });
    };
  const logger: Logger & { records: LogRecord[] } = {
    records,
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    child() {
      return logger;
    },
  };
  return logger;
}

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: 'turn-voice-1',
    sessionId: 'session-1',
    telegramMessageId: 777,
    telegramFileId: null,
    inputType: 'VOICE',
    status: 'RECEIVED',
    rawTranscript: null,
    normalizedTranscript: null,
    replyText: null,
    error: null,
    createdAt: new Date('2026-08-12T00:00:00Z'),
    updatedAt: new Date('2026-08-12T00:00:00Z'),
    ...overrides,
  };
}

class FakeTurnStore implements TurnStore {
  turn: Turn;
  readonly advanceCalls: Array<{ status: TurnStatus }> = [];

  constructor(turn: Turn) {
    this.turn = turn;
  }

  load(): Promise<Turn> {
    return Promise.resolve(this.turn);
  }

  advance(
    status: TurnStatus,
    patch: {
      rawTranscript?: string;
      normalizedTranscript?: string;
      replyText?: string;
      error?: string;
    } = {},
  ): Promise<Turn> {
    this.advanceCalls.push({ status });
    this.turn = { ...this.turn, ...patch, status, updatedAt: new Date() };
    return Promise.resolve(this.turn);
  }
}

interface PipelineSpies {
  download: ReturnType<typeof vi.fn>;
  transcribe: MockInstance<
    (audio: AudioFileRef, options?: SttOptions) => Promise<Transcript>
  >;
  respond: ReturnType<typeof vi.fn>;
  synthesize: MockInstance<
    (text: string, voice: VoiceConfig) => Promise<AudioResult>
  >;
  normalizeAudio: ReturnType<typeof vi.fn>;
  normalizeTranscript: ReturnType<typeof vi.fn>;
  persist: ReturnType<typeof vi.fn>;
  sendText: ReturnType<typeof vi.fn>;
  sendVoice: ReturnType<typeof vi.fn>;
  recordUsage: ReturnType<typeof vi.fn>;
}

interface PipelineOptions {
  ttsOutputDir: string;
  sttFailure?: Error;
  ttsFailure?: Error;
  tutorFailure?: Error;
  normalizeFailure?: Error;
  downloader?: VoiceTurnServices['downloader'];
}

function buildPipeline(options: PipelineOptions): {
  services: VoiceTurnServices;
  spies: PipelineSpies;
} {
  const stt = new MockSttProvider({
    transcript: RAW_TRANSCRIPT,
    failure: options.sttFailure,
  });
  const tts = new MockTtsProvider({
    outputDir: options.ttsOutputDir,
    failure: options.ttsFailure,
  });

  const spies: PipelineSpies = {
    download: vi.fn(async (fileId: string, destPath: string) => {
      void fileId;
      const bytes = Buffer.from('fake-ogg-opus-bytes');
      await writeFile(destPath, bytes);
      return { bytes: bytes.byteLength, container: 'ogg' };
    }),
    transcribe: vi.spyOn(stt, 'transcribe'),
    respond: vi.fn(async (request: TutorRequest) => {
      void request;
      if (options.tutorFailure !== undefined) {
        throw options.tutorFailure;
      }
      return {
        replyText: TUTOR_REPLY,
        provider: 'mock-llm',
        model: 'mock-tutor-1',
        usage: { inputTokens: 12, outputTokens: 8, requestId: 'req-llm-1' },
      };
    }),
    synthesize: vi.spyOn(tts, 'synthesize'),
    normalizeAudio: vi.fn(
      async (input: { path: string; container: string }) => {
        if (options.normalizeFailure !== undefined) {
          throw options.normalizeFailure;
        }
        return {
          path: input.path.replace(/\.oga$/, '.webm'),
          container: 'webm',
          codec: 'opus',
          transcoded: false,
        };
      },
    ),
    normalizeTranscript: vi.fn(async (raw: string) => {
      void raw;
      return NORMALIZED_TRANSCRIPT;
    }),
    persist: vi.fn(async () => {}),
    sendText: vi.fn(async (text: string) => {
      void text;
    }),
    sendVoice: vi.fn(async (audio: OutboundVoice) => {
      void audio;
    }),
    recordUsage: vi.fn(async (usage: UsageRecordInput) => {
      void usage;
    }),
  };

  const tutor: Tutor = {
    name: 'mock-llm',
    model: 'mock-tutor-1',
    respond: spies.respond as Tutor['respond'],
  };

  const services: VoiceTurnServices = {
    downloader: options.downloader ?? { download: spies.download },
    stt,
    tts,
    tutor,
    voice: { voiceId: 'ja-voice-1' },
    sendText: spies.sendText,
    sendVoice: spies.sendVoice,
    persist: spies.persist,
    normalizeAudio: spies.normalizeAudio,
    normalizeTranscript: spies.normalizeTranscript,
    recordUsage: spies.recordUsage,
  };

  return { services, spies };
}

describe('voiceTurn pipeline', () => {
  let baseDir: string;
  let ttsOutputDir: string;
  let logger: Logger & { records: LogRecord[] };

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'jp-coach-w6-ws-'));
    ttsOutputDir = await mkdtemp(join(tmpdir(), 'jp-coach-w6-tts-'));
    logger = fakeLogger();
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
    await rm(ttsOutputDir, { recursive: true, force: true });
  });

  async function run(
    store: FakeTurnStore,
    services: VoiceTurnServices,
  ): Promise<unknown> {
    return runVoiceTurn({
      store,
      services,
      fileId: 'telegram-file-id',
      logger,
      recordUsage: services.recordUsage,
      workspaceOptions: { baseDir },
    }).catch((error: unknown) => error);
  }

  it('runs a full voice turn to COMPLETED with raw transcript preserved and normalized kept separate', async () => {
    const store = new FakeTurnStore(makeTurn());
    const { services, spies } = buildPipeline({ ttsOutputDir });

    const result = await run(store, services);

    expect(result).not.toBeInstanceOf(Error);
    const { turn } = result as Awaited<ReturnType<typeof runVoiceTurn>>;
    expect(turn.status).toBe('COMPLETED');
    expect(store.advanceCalls.map((c) => c.status)).toEqual([
      'AUDIO_READY',
      'AUDIO_NORMALIZED',
      'STT_DONE',
      'LLM_DONE',
      'PERSISTED',
      'TEXT_SENT',
      'VOICE_SENT',
      'COMPLETED',
    ]);

    expect(turn.rawTranscript).toBe(RAW_TRANSCRIPT);
    expect(turn.normalizedTranscript).toBe(NORMALIZED_TRANSCRIPT);
    expect(turn.normalizedTranscript).not.toBe(turn.rawTranscript);
    expect(turn.replyText).toBe(TUTOR_REPLY);

    expect(spies.download).toHaveBeenCalledTimes(1);
    expect(spies.normalizeAudio).toHaveBeenCalledTimes(1);
    expect(spies.transcribe).toHaveBeenCalledTimes(1);
    const audioArg = spies.transcribe.mock.calls[0]?.[0] as {
      path: string;
      container: string;
    };
    expect(audioArg.container).toBe('webm');
    expect(spies.respond).toHaveBeenCalledTimes(1);
    expect(spies.respond).toHaveBeenCalledWith({
      rawTranscript: RAW_TRANSCRIPT,
      normalizedTranscript: NORMALIZED_TRANSCRIPT,
    });
    expect(spies.persist).toHaveBeenCalledTimes(1);
    expect(spies.sendText).toHaveBeenCalledTimes(1);
    expect(spies.sendText).toHaveBeenCalledWith(TUTOR_REPLY);
    expect(spies.sendVoice).toHaveBeenCalledTimes(1);
    const voice = spies.sendVoice.mock.calls[0]?.[0] as OutboundVoice;
    expect(voice.format).toBe('mp3');

    const usageOps = spies.recordUsage.mock.calls.map(
      (call) => (call[0] as UsageRecordInput).operation,
    );
    expect(usageOps).toEqual(['stt', 'llm', 'tts']);
    for (const call of spies.recordUsage.mock.calls) {
      expect((call[0] as UsageRecordInput).success).toBe(true);
    }

    expect(await readdir(baseDir)).toEqual([]);
  });

  it('remux failure: marks FAILED at AUDIO_NORMALIZED, never calls STT/tutor, cleans temp files', async () => {
    const store = new FakeTurnStore(makeTurn());
    const { services, spies } = buildPipeline({
      ttsOutputDir,
      normalizeFailure: new FfmpegError('ffmpeg exited with code 1: bad', {
        exitCode: 1,
        stderr: 'bad',
      }),
    });

    const error = await run(store, services);

    expect(error).toBeInstanceOf(TurnStepFailedError);
    expect((error as TurnStepFailedError).failedAt).toBe('AUDIO_NORMALIZED');
    expect(store.turn.status).toBe('FAILED');
    expect(spies.transcribe).not.toHaveBeenCalled();
    expect(spies.respond).not.toHaveBeenCalled();
    expect(spies.persist).not.toHaveBeenCalled();
    expect(spies.sendText).not.toHaveBeenCalled();
    expect(spies.sendVoice).not.toHaveBeenCalled();
    expect(await readdir(baseDir)).toEqual([]);
  });

  it('STT failure: marks FAILED at STT_DONE, writes no transcripts, produces no learning output', async () => {
    const store = new FakeTurnStore(makeTurn());
    const { services, spies } = buildPipeline({
      ttsOutputDir,
      sttFailure: new Error('stt upstream down'),
    });

    const error = await run(store, services);

    expect(error).toBeInstanceOf(TurnStepFailedError);
    expect((error as TurnStepFailedError).failedAt).toBe('STT_DONE');
    expect(store.turn.status).toBe('FAILED');
    expect(store.turn.rawTranscript).toBeNull();
    expect(store.turn.normalizedTranscript).toBeNull();
    expect(spies.respond).not.toHaveBeenCalled();
    expect(spies.persist).not.toHaveBeenCalled();
    expect(spies.sendText).not.toHaveBeenCalled();
    expect(spies.sendVoice).not.toHaveBeenCalled();

    const failures = spies.recordUsage.mock.calls
      .map((call) => call[0] as UsageRecordInput)
      .filter((usage) => !usage.success);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      provider: 'mock-stt',
      operation: 'stt',
      success: false,
    });
    expect(await readdir(baseDir)).toEqual([]);
  });

  it('LLM failure: marks FAILED at LLM_DONE, keeps raw transcript, sends nothing', async () => {
    const store = new FakeTurnStore(makeTurn());
    const { services, spies } = buildPipeline({
      ttsOutputDir,
      tutorFailure: new Error('llm unavailable'),
    });

    const error = await run(store, services);

    expect(error).toBeInstanceOf(TurnStepFailedError);
    expect((error as TurnStepFailedError).failedAt).toBe('LLM_DONE');
    expect(store.turn.status).toBe('FAILED');
    expect(store.turn.rawTranscript).toBe(RAW_TRANSCRIPT);
    expect(store.turn.replyText).toBeNull();
    expect(spies.persist).not.toHaveBeenCalled();
    expect(spies.sendText).not.toHaveBeenCalled();
    expect(spies.sendVoice).not.toHaveBeenCalled();

    const failures = spies.recordUsage.mock.calls
      .map((call) => call[0] as UsageRecordInput)
      .filter((usage) => !usage.success);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      provider: 'mock-llm',
      operation: 'llm',
      success: false,
    });
    expect(await readdir(baseDir)).toEqual([]);
  });

  it('TTS failure: user still gets the Japanese text reply; retry re-sends voice without re-calling the LLM', async () => {
    const store = new FakeTurnStore(makeTurn());
    const failing = buildPipeline({
      ttsOutputDir,
      ttsFailure: new Error('tts boom'),
    });

    const error = await run(store, failing.services);

    expect(error).toBeInstanceOf(TurnStepFailedError);
    expect((error as TurnStepFailedError).failedAt).toBe('VOICE_SENT');
    expect(store.turn.status).toBe('FAILED');
    expect(store.turn.replyText).toBe(TUTOR_REPLY);
    expect(failing.spies.sendText).toHaveBeenCalledTimes(1);
    expect(failing.spies.sendText).toHaveBeenCalledWith(TUTOR_REPLY);
    expect(failing.spies.sendVoice).not.toHaveBeenCalled();
    const ttsFailures = failing.spies.recordUsage.mock.calls
      .map((call) => call[0] as UsageRecordInput)
      .filter((usage) => !usage.success);
    expect(ttsFailures).toHaveLength(1);
    expect(ttsFailures[0]).toMatchObject({
      provider: 'mock-tts',
      operation: 'tts',
      success: false,
    });
    expect(await readdir(baseDir)).toEqual([]);

    const retrying = buildPipeline({ ttsOutputDir });
    const retried = await run(store, retrying.services);

    expect(retried).not.toBeInstanceOf(Error);
    const { turn } = retried as Awaited<ReturnType<typeof runVoiceTurn>>;
    expect(turn.status).toBe('COMPLETED');
    expect(retrying.spies.respond).toHaveBeenCalledTimes(0);
    expect(retrying.spies.transcribe).toHaveBeenCalledTimes(0);
    expect(retrying.spies.download).toHaveBeenCalledTimes(0);
    expect(retrying.spies.normalizeAudio).toHaveBeenCalledTimes(0);
    expect(retrying.spies.persist).toHaveBeenCalledTimes(0);
    expect(retrying.spies.sendText).toHaveBeenCalledTimes(0);
    expect(retrying.spies.synthesize).toHaveBeenCalledTimes(1);
    expect(retrying.spies.sendVoice).toHaveBeenCalledTimes(1);
    const synthText = retrying.spies.synthesize.mock.calls[0]?.[0] as string;
    expect(synthText).toBe(TUTOR_REPLY);
    expect(await readdir(baseDir)).toEqual([]);
  });

  it('rejects invalid voice input at AUDIO_READY without touching any provider', async () => {
    const store = new FakeTurnStore(makeTurn());
    const token = 'secret-token-under-test';
    const downloader = createVoiceDownloader(
      {
        api: { getFile: () => Promise.reject(new Error('must not be called')) },
        token,
        limits: { maxSizeMb: 1, maxDurationSeconds: 120 },
        fetchImpl: () => Promise.reject(new Error('must not be called')),
      },
      { mimeType: 'audio/ogg', fileSize: 2 * 1024 * 1024 },
    );
    const { services, spies } = buildPipeline({ ttsOutputDir, downloader });

    const error = await run(store, services);

    expect(error).toBeInstanceOf(TurnStepFailedError);
    expect((error as TurnStepFailedError).failedAt).toBe('AUDIO_READY');
    expect(store.turn.status).toBe('FAILED');
    expect(spies.normalizeAudio).not.toHaveBeenCalled();
    expect(spies.transcribe).not.toHaveBeenCalled();
    expect(spies.respond).not.toHaveBeenCalled();
    expect(spies.synthesize).not.toHaveBeenCalled();
    expect(spies.sendText).not.toHaveBeenCalled();
    expect(spies.sendVoice).not.toHaveBeenCalled();

    const serialized = JSON.stringify(logger.records);
    expect(serialized).not.toContain(token);
    expect((error as Error).message).not.toContain(token);
    expect(await readdir(baseDir)).toEqual([]);
  });
});
