import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../src/config/index.js';
import {
  createSpeechProviders,
  createSttProvider,
  createTtsProvider,
  fetchWithRetry,
  ProviderHttpError,
  SUPPORTED_STT_PROVIDERS,
  SUPPORTED_TTS_PROVIDERS,
} from '../../src/speech/providerFactory.js';
import { MockSttProvider } from '../../src/speech/stt/mock.js';
import { OpenAiSttProvider } from '../../src/speech/stt/openai.js';
import { MiniMaxTtsProvider } from '../../src/speech/tts/minimax.js';
import { MockTtsProvider } from '../../src/speech/tts/mock.js';

function makeConfig(overrides?: {
  sttProvider?: string;
  ttsProvider?: string;
}): AppConfig {
  return {
    telegram: { botToken: 'token', allowedUserId: 1 },
    db: {
      url: 'postgres://example',
      urlDirect: 'postgres://example',
      poolMax: 2,
      poolIdleTimeoutMs: 15_000,
      connectionTimeoutMs: 10_000,
    },
    llm: {
      provider: 'minimax',
      baseUrl: 'https://api.minimax.io/anthropic',
      model: 'MiniMax-M3',
      apiKey: 'llm-key',
      maxContextTurns: 12,
      promptCacheEnabled: true,
    },
    stt: {
      inputEnabled: false,
      provider: overrides?.sttProvider ?? 'openai',
      model: 'gpt-transcribe',
      contextHintsEnabled: false,
      openaiApiKey: 'sk-test',
    },
    audio: {
      targetContainer: 'webm',
      remuxCopyCodec: true,
      maxDurationSeconds: 120,
      maxSizeMb: 20,
    },
    tts: {
      provider: overrides?.ttsProvider ?? 'minimax',
      modelConversation: 'speech-2.8-turbo',
      modelTeaching: 'speech-2.8-hd',
      maxCharacters: 400,
      minimaxApiKey: 'minimax-key',
      minimaxVoiceId: 'ja-voice-1',
    },
    review: {
      requestRetention: 0.9,
    },
    kana: {
      audioDir: 'assets/kana-audio',
      optionCount: 4,
      newPerDay: 5,
      maxReviews: 20,
      backlogThreshold: 20,
    },
    correction: {
      surfaceAfterTurnsConversation: 4,
      surfaceAfterTurnsCoach: 1,
      surfaceMaxItems: 3,
      highImportanceThreshold: 2,
    },
    session: {
      userTimezone: 'Asia/Singapore',
      idleMinutes: 30,
      dailyReminderLocalTime: '20:30',
    weeklyReportLocalTime: '20:00',
    weeklyReportWeekday: 0,
      nightlyBackupLocalTime: '03:00',
    },
    budget: { dailyCostSoftLimitUsd: 1, monthlyCostSoftLimitUsd: 10 },
    mcp: { accessToken: undefined, ratePerMinute: 30 },
    server: {
      port: 3000,
      miniAppUrl: undefined,
    },
    logging: { level: 'info' },
  };
}

describe('provider factory', () => {
  it('creates the OpenAI STT adapter from config', () => {
    const stt = createSttProvider(makeConfig());
    expect(stt).toBeInstanceOf(OpenAiSttProvider);
    expect(stt.name).toBe('openai');
    expect(stt.model).toBe('gpt-transcribe');
  });

  it('creates the MiniMax TTS adapter from config with the conversation model', () => {
    const tts = createTtsProvider(makeConfig());
    expect(tts).toBeInstanceOf(MiniMaxTtsProvider);
    expect(tts.name).toBe('minimax');
    expect(tts.model).toBe('speech-2.8-turbo');
    expect(tts.outputFormat).toBe('mp3');
  });

  it('keeps the mock providers selectable for local development', () => {
    expect(createSttProvider(makeConfig({ sttProvider: 'mock' }))).toBeInstanceOf(
      MockSttProvider,
    );
    expect(createTtsProvider(makeConfig({ ttsProvider: 'mock' }))).toBeInstanceOf(
      MockTtsProvider,
    );
  });

  it('fails fast on unknown provider names and lists supported values', () => {
    expect(() =>
      createSttProvider(makeConfig({ sttProvider: 'deepgram' })),
    ).toThrow(SUPPORTED_STT_PROVIDERS.join(', '));
    expect(() =>
      createTtsProvider(makeConfig({ ttsProvider: 'elevenlabs' })),
    ).toThrow(SUPPORTED_TTS_PROVIDERS.join(', '));
  });

  it('creates both providers in one call', () => {
    const providers = createSpeechProviders(makeConfig());
    expect(providers.stt).toBeInstanceOf(OpenAiSttProvider);
    expect(providers.tts).toBeInstanceOf(MiniMaxTtsProvider);
  });
});

describe('fetchWithRetry', () => {
  const noSleep = () => Promise.resolve();

  it('applies exponential backoff with jitter between attempts', async () => {
    const delays: number[] = [];
    const fetchImpl = vi.fn(
      async () => new Response('rate limited', { status: 429 }),
    );
    await expect(
      fetchWithRetry(
        'https://example.com',
        { method: 'POST' },
        {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          timeoutMs: 1_000,
          maxAttempts: 3,
          baseDelayMs: 100,
          sleep: (ms) => {
            delays.push(ms);
            return Promise.resolve();
          },
          random: () => 0,
        },
      ),
    ).rejects.toBeInstanceOf(ProviderHttpError);
    expect(delays).toEqual([100, 200]);
  });

  it('does not sleep between the request and a non-retryable failure', async () => {
    const sleep = vi.fn(noSleep);
    const fetchImpl = vi.fn(
      async () => new Response('bad request', { status: 400 }),
    );
    await expect(
      fetchWithRetry(
        'https://example.com',
        { method: 'POST' },
        {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          timeoutMs: 1_000,
          sleep,
        },
      ),
    ).rejects.toBeInstanceOf(ProviderHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries network errors and returns the first successful response', async () => {
    const sequence: Array<() => Promise<Response>> = [
      () => Promise.reject(new TypeError('fetch failed')),
      () => Promise.resolve(new Response('ok', { status: 200 })),
    ];
    const fetchImpl = vi.fn(() => {
      const next = sequence.shift();
      if (next === undefined) throw new Error('unexpected extra call');
      return next();
    });
    const response = await fetchWithRetry(
      'https://example.com',
      { method: 'POST' },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 1_000,
        sleep: noSleep,
      },
    );
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rethrows the original network error after exhausting attempts', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(
      fetchWithRetry(
        'https://example.com',
        { method: 'POST' },
        {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          timeoutMs: 1_000,
          maxAttempts: 2,
          sleep: noSleep,
        },
      ),
    ).rejects.toBeInstanceOf(TypeError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
