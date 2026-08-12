import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Turn } from '../../src/db/schema/session.js';
import type { Logger } from '../../src/observability/index.js';
import { MockSttProvider } from '../../src/speech/stt/mock.js';
import { MockTtsProvider } from '../../src/speech/tts/mock.js';
import {
  encodeTurnFailure,
  parseTurnFailure,
  runTurn,
  TurnStepFailedError,
  type StepOutcome,
  type TurnStep,
  type TurnStore,
} from '../../src/sessions/turnRunner.js';
import type { ChainStatus, TurnStatus } from '../../src/sessions/turnStateMachine.js';
import type { UsageRecordInput } from '../../src/usage/types.js';

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
    id: 'turn-1',
    sessionId: 'session-1',
    telegramMessageId: 42,
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

interface AdvanceCall {
  status: TurnStatus;
  patch: { rawTranscript?: string; normalizedTranscript?: string; replyText?: string; error?: string };
}

class FakeTurnStore implements TurnStore {
  turn: Turn;
  readonly advanceCalls: AdvanceCall[] = [];

  constructor(turn: Turn) {
    this.turn = turn;
  }

  load(): Promise<Turn> {
    return Promise.resolve(this.turn);
  }

  advance(status: TurnStatus, patch: AdvanceCall['patch'] = {}): Promise<Turn> {
    this.advanceCalls.push({ status, patch });
    this.turn = { ...this.turn, ...patch, status, updatedAt: new Date() };
    return Promise.resolve(this.turn);
  }
}

interface Ctx {
  turn: Turn;
  replyText?: string;
  audioPath?: string;
  ttsPath?: string;
}

interface PipelineMocks {
  download: ReturnType<typeof vi.fn>;
  normalize: ReturnType<typeof vi.fn>;
  llm: ReturnType<typeof vi.fn>;
  persist: ReturnType<typeof vi.fn>;
  sendText: ReturnType<typeof vi.fn>;
  sendVoice: ReturnType<typeof vi.fn>;
}

const LLM_REPLY = '今日は何をしましたか？';

function buildPipeline(options: {
  outputDir: string;
  ttsFailure?: Error;
}): { steps: TurnStep<Ctx>[]; mocks: PipelineMocks } {
  const stt = new MockSttProvider({ transcript: '映画を見るました' });
  const tts = new MockTtsProvider({
    outputDir: options.outputDir,
    failure: options.ttsFailure,
  });

  const mocks: PipelineMocks = {
    download: vi.fn(async (ctx: Ctx) => {
      ctx.audioPath = '/tmp/input.oga';
    }),
    normalize: vi.fn(async (ctx: Ctx) => {
      ctx.audioPath = '/tmp/input.webm';
    }),
    llm: vi.fn(async (ctx: Ctx) => {
      ctx.replyText = LLM_REPLY;
    }),
    persist: vi.fn(async () => {}),
    sendText: vi.fn(async () => {}),
    sendVoice: vi.fn(async () => {}),
  };

  const steps: TurnStep<Ctx>[] = [
    {
      status: 'AUDIO_READY',
      async execute(ctx): Promise<StepOutcome> {
        await mocks.download(ctx);
        return {};
      },
    },
    {
      status: 'AUDIO_NORMALIZED',
      async execute(ctx): Promise<StepOutcome> {
        await mocks.normalize(ctx);
        return {};
      },
    },
    {
      status: 'STT_DONE',
      async execute(ctx): Promise<StepOutcome> {
        const transcript = await stt.transcribe({
          path: ctx.audioPath ?? '/tmp/input.webm',
          container: 'webm',
        });
        return { patch: { rawTranscript: transcript.rawText } };
      },
    },
    {
      status: 'LLM_DONE',
      async execute(ctx): Promise<StepOutcome> {
        await mocks.llm(ctx);
        return { patch: { replyText: ctx.replyText }, requestId: 'req-llm-1' };
      },
    },
    {
      status: 'PERSISTED',
      async execute(ctx): Promise<StepOutcome> {
        await mocks.persist(ctx);
        return {};
      },
    },
    {
      status: 'TEXT_SENT',
      async execute(ctx): Promise<StepOutcome> {
        await mocks.sendText(ctx);
        return {};
      },
    },
    {
      status: 'VOICE_SENT',
      async execute(ctx): Promise<StepOutcome> {
        if (ctx.replyText === undefined) {
          throw new Error('replyText missing from context');
        }
        const audio = await tts.synthesize(ctx.replyText, { voiceId: 'ja-voice-1' });
        ctx.ttsPath = audio.path;
        await mocks.sendVoice(ctx);
        return { requestId: audio.usage.requestId };
      },
    },
    {
      status: 'COMPLETED',
      execute(): Promise<StepOutcome> {
        return Promise.resolve({});
      },
    },
  ];

  return { steps, mocks };
}

const buildContext = (turn: Turn): Ctx => ({
  turn,
  replyText: turn.replyText ?? undefined,
});

describe('turnRunner', () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'jp-coach-w5-'));
  });

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  it('runs RECEIVED to COMPLETED, executing each step once in order and persisting after each', async () => {
    const store = new FakeTurnStore(makeTurn());
    const { steps, mocks } = buildPipeline({ outputDir });
    const logger = fakeLogger();

    const result = await runTurn({
      store,
      steps,
      buildContext,
      logger,
    });

    expect(result.status).toBe('COMPLETED');
    expect(store.advanceCalls.map((call) => call.status)).toEqual([
      'AUDIO_READY',
      'AUDIO_NORMALIZED',
      'STT_DONE',
      'LLM_DONE',
      'PERSISTED',
      'TEXT_SENT',
      'VOICE_SENT',
      'COMPLETED',
    ]);
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(mocks.normalize).toHaveBeenCalledTimes(1);
    expect(mocks.llm).toHaveBeenCalledTimes(1);
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(mocks.sendText).toHaveBeenCalledTimes(1);
    expect(mocks.sendVoice).toHaveBeenCalledTimes(1);
    expect(store.turn.rawTranscript).toBe('映画を見るました');
    expect(store.turn.replyText).toBe(LLM_REPLY);
    expect(logger.records.some((r) => r.fields?.requestId === 'req-llm-1')).toBe(true);
  });

  it('retries TTS failure without re-calling the LLM (reuses persisted reply)', async () => {
    const store = new FakeTurnStore(makeTurn());
    const logger = fakeLogger();

    const failing = buildPipeline({ outputDir, ttsFailure: new Error('tts boom') });
    await expect(
      runTurn({ store, steps: failing.steps, buildContext, logger }),
    ).rejects.toThrow(TurnStepFailedError);

    expect(store.turn.status).toBe('FAILED');
    const failure = parseTurnFailure(store.turn.error);
    expect(failure?.failedAt).toBe('VOICE_SENT');
    expect(failure?.message).toContain('tts boom');
    expect(store.turn.replyText).toBe(LLM_REPLY);
    expect(failing.mocks.llm).toHaveBeenCalledTimes(1);
    expect(failing.mocks.sendVoice).toHaveBeenCalledTimes(0);

    const retrying = buildPipeline({ outputDir });
    const result = await runTurn({
      store,
      steps: retrying.steps,
      buildContext,
      logger,
    });

    expect(result.status).toBe('COMPLETED');
    expect(failing.mocks.llm).toHaveBeenCalledTimes(1);
    expect(retrying.mocks.llm).toHaveBeenCalledTimes(0);
    expect(retrying.mocks.download).toHaveBeenCalledTimes(0);
    expect(retrying.mocks.normalize).toHaveBeenCalledTimes(0);
    expect(retrying.mocks.persist).toHaveBeenCalledTimes(0);
    expect(retrying.mocks.sendText).toHaveBeenCalledTimes(0);
    expect(retrying.mocks.sendVoice).toHaveBeenCalledTimes(1);
    const retryCtx = retrying.mocks.sendVoice.mock.calls[0]?.[0] as Ctx;
    expect(retryCtx.replyText).toBe(LLM_REPLY);
  });

  it('resumes from a mid-chain status, executing only remaining steps', async () => {
    const store = new FakeTurnStore(
      makeTurn({
        status: 'LLM_DONE',
        rawTranscript: '映画を見るました',
        replyText: LLM_REPLY,
      }),
    );
    const { steps, mocks } = buildPipeline({ outputDir });

    const result = await runTurn({
      store,
      steps,
      buildContext,
      logger: fakeLogger(),
    });

    expect(result.status).toBe('COMPLETED');
    expect(mocks.download).toHaveBeenCalledTimes(0);
    expect(mocks.normalize).toHaveBeenCalledTimes(0);
    expect(mocks.llm).toHaveBeenCalledTimes(0);
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(mocks.sendText).toHaveBeenCalledTimes(1);
    expect(mocks.sendVoice).toHaveBeenCalledTimes(1);
    expect(store.advanceCalls.map((call) => call.status)).toEqual([
      'PERSISTED',
      'TEXT_SENT',
      'VOICE_SENT',
      'COMPLETED',
    ]);
  });

  it('re-driving a completed turn makes no external calls and no state changes', async () => {
    const store = new FakeTurnStore(makeTurn());
    const { steps, mocks } = buildPipeline({ outputDir });
    const deps = { store, steps, buildContext, logger: fakeLogger() };

    await runTurn(deps);
    const advanceCountAfterFirstRun = store.advanceCalls.length;

    const again = await runTurn(deps);

    expect(again.status).toBe('COMPLETED');
    expect(store.advanceCalls.length).toBe(advanceCountAfterFirstRun);
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(mocks.llm).toHaveBeenCalledTimes(1);
    expect(mocks.sendText).toHaveBeenCalledTimes(1);
    expect(mocks.sendVoice).toHaveBeenCalledTimes(1);
  });

  it('marks FAILED with the failing step recorded and rethrows', async () => {
    const store = new FakeTurnStore(makeTurn());
    const { steps, mocks } = buildPipeline({ outputDir });
    mocks.llm.mockRejectedValueOnce(new Error('llm down'));

    const error = await runTurn({
      store,
      steps,
      buildContext,
      logger: fakeLogger(),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TurnStepFailedError);
    expect((error as TurnStepFailedError).failedAt).toBe('LLM_DONE');
    expect(store.turn.status).toBe('FAILED');
    expect(parseTurnFailure(store.turn.error)).toEqual({
      failedAt: 'LLM_DONE',
      message: 'llm down',
    });
  });

  it('failure metadata round-trips through encode/parse', () => {
    const encoded = encodeTurnFailure('VOICE_SENT', new Error('boom'));
    expect(parseTurnFailure(encoded)).toEqual({ failedAt: 'VOICE_SENT', message: 'boom' });
    expect(parseTurnFailure(null)).toBeUndefined();
    expect(parseTurnFailure('not json')).toBeUndefined();
    expect(parseTurnFailure(JSON.stringify({ failedAt: 'NOPE', message: 'x' }))).toBeUndefined();
  });

  it('rejects a FAILED turn whose failure metadata is unreadable instead of re-running everything', async () => {
    const store = new FakeTurnStore(
      makeTurn({ status: 'FAILED', error: 'legacy failure text' }),
    );
    const { steps, mocks } = buildPipeline({ outputDir });

    await expect(
      runTurn({ store, steps, buildContext, logger: fakeLogger() }),
    ).rejects.toThrow(TurnStepFailedError);
    expect(mocks.llm).toHaveBeenCalledTimes(0);
    expect(mocks.download).toHaveBeenCalledTimes(0);
  });

  it('records usage emitted by steps via recordUsage callback', async () => {
    const store = new FakeTurnStore(makeTurn({ status: 'VOICE_SENT', replyText: LLM_REPLY }));
    const recordUsage = vi.fn(async (usage: UsageRecordInput) => {
      void usage;
    });
    const steps: TurnStep<Ctx>[] = [
      {
        status: 'COMPLETED',
        execute: (): Promise<StepOutcome> =>
          Promise.resolve({
            usage: {
              provider: 'minimax',
              model: 'speech-2.8-turbo',
              operation: 'tts',
              ttsCharacters: 10,
              success: true,
            },
          }),
      },
    ];

    await runTurn({ store, steps, buildContext, logger: fakeLogger(), recordUsage });

    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage.mock.calls[0]?.[0]).toMatchObject({ provider: 'minimax' });
  });

  it('skips steps already completed when resuming from FAILED without metadata loss', async () => {
    const failedTurn = makeTurn({
      status: 'FAILED',
      rawTranscript: '映画を見るました',
      replyText: LLM_REPLY,
      error: encodeTurnFailure('PERSISTED' satisfies ChainStatus, new Error('db blip')),
    });
    const store = new FakeTurnStore(failedTurn);
    const { steps, mocks } = buildPipeline({ outputDir });

    const result = await runTurn({
      store,
      steps,
      buildContext,
      logger: fakeLogger(),
    });

    expect(result.status).toBe('COMPLETED');
    expect(mocks.download).toHaveBeenCalledTimes(0);
    expect(mocks.normalize).toHaveBeenCalledTimes(0);
    expect(mocks.llm).toHaveBeenCalledTimes(0);
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(store.advanceCalls.map((call) => call.status)).toEqual([
      'PERSISTED',
      'TEXT_SENT',
      'VOICE_SENT',
      'COMPLETED',
    ]);
  });
});
