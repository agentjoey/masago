import { describe, expect, it, vi } from 'vitest';
import {
  MiniMaxTtsError,
  MiniMaxTtsProvider,
} from '../../src/speech/tts/minimax.js';
import { TtsTimeoutError } from '../../src/speech/tts/types.js';

const API_KEY = 'minimax-test-secret-key-67890';
const MODEL = 'speech-2.8-turbo';
const MAX_CHARACTERS = 400;
const KNOWN_BYTES = [0xde, 0xad, 0xbe, 0xef, 0x00, 0xff];
const KNOWN_HEX = 'deadbeef00ff';

type FetchStub = ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  });
}

function okTts(overrides?: {
  audio?: string;
  usageCharacters?: number;
  audioLength?: number;
  traceId?: string;
}): Response {
  return jsonResponse({
    data: { audio: overrides?.audio ?? KNOWN_HEX, status: 2 },
    extra_info: {
      usage_characters: overrides?.usageCharacters ?? 42,
      audio_length: overrides?.audioLength ?? 1_234,
      audio_size: KNOWN_BYTES.length,
    },
    base_resp: { status_code: 0, status_msg: 'success' },
    trace_id: overrides?.traceId ?? 'trace-abc',
  });
}

function makeProvider(
  fetchImpl: FetchStub,
  overrides?: Partial<ConstructorParameters<typeof MiniMaxTtsProvider>[0]>,
): MiniMaxTtsProvider {
  return new MiniMaxTtsProvider({
    apiKey: API_KEY,
    model: MODEL,
    maxCharacters: MAX_CHARACTERS,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep: () => Promise.resolve(),
    ...overrides,
  });
}

function lastInit(fetchImpl: FetchStub): RequestInit {
  const call = fetchImpl.mock.calls.at(-1);
  expect(call).toBeDefined();
  return call?.[1] as RequestInit;
}

describe('MiniMaxTtsProvider', () => {
  it('declares mp3 output', () => {
    expect(makeProvider(vi.fn()).outputFormat).toBe('mp3');
  });

  it('sends the exact t2a_v2 request contract', async () => {
    const fetchImpl = vi.fn(async () => okTts());
    const provider = makeProvider(fetchImpl);
    await provider.synthesize('こんにちは', { voiceId: 'ja-voice-1' });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.minimax.io/v1/t2a_v2');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${API_KEY}`);
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      model: MODEL,
      text: 'こんにちは',
      stream: false,
      language_boost: 'Japanese',
      voice_setting: { voice_id: 'ja-voice-1', speed: 1, vol: 1, pitch: 0 },
      audio_setting: {
        format: 'mp3',
        sample_rate: 32_000,
        bitrate: 128_000,
        channel: 1,
      },
    });
  });

  it('honours voice overrides for speed, pitch and language boost', async () => {
    const fetchImpl = vi.fn(async () => okTts());
    const provider = makeProvider(fetchImpl);
    await provider.synthesize('ゆっくり話します', {
      voiceId: 'ja-voice-2',
      speed: 0.8,
      pitch: -2,
      languageBoost: 'Korean',
    });
    const body = JSON.parse(lastInit(fetchImpl).body as string) as {
      language_boost: string;
      voice_setting: { speed: number; pitch: number; voice_id: string };
    };
    expect(body.language_boost).toBe('Korean');
    expect(body.voice_setting).toEqual({
      voice_id: 'ja-voice-2',
      speed: 0.8,
      vol: 1,
      pitch: -2,
    });
  });

  it('throws on base_resp.status_code != 0 even when HTTP is 200, including status_msg and trace_id', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: { audio: '', status: 0 },
        extra_info: { usage_characters: 0, audio_length: 0, audio_size: 0 },
        base_resp: { status_code: 2013, status_msg: 'invalid params' },
        trace_id: 'trace-fail-999',
      }),
    );
    const provider = makeProvider(fetchImpl);
    const error = await provider
      .synthesize('テスト', { voiceId: 'v' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MiniMaxTtsError);
    expect((error as Error).message).toContain('2013');
    expect((error as Error).message).toContain('invalid params');
    expect((error as Error).message).toContain('trace-fail-999');
    expect((error as MiniMaxTtsError).statusCode).toBe(2013);
    expect((error as MiniMaxTtsError).traceId).toBe('trace-fail-999');
  });

  it('decodes the hex-encoded audio to the exact original bytes', async () => {
    const fetchImpl = vi.fn(async () => okTts());
    const provider = makeProvider(fetchImpl);
    const result = await provider.synthesize('テスト', { voiceId: 'v' });
    expect(result.bytes).toEqual(Buffer.from(KNOWN_BYTES));
    expect(result.format).toBe('mp3');
    expect(result.durationMs).toBe(1_234);
    expect(result.provider).toBe('minimax');
    expect(result.model).toBe(MODEL);
    expect(result.usage.requestId).toBe('trace-abc');
  });

  it('bills by extra_info.usage_characters, not text.length', async () => {
    const text = 'こんにちは';
    const fetchImpl = vi.fn(async () => okTts({ usageCharacters: 42 }));
    const provider = makeProvider(fetchImpl);
    const result = await provider.synthesize(text, { voiceId: 'v' });
    expect(text.length).not.toBe(42);
    expect(result.usage.characters).toBe(42);
  });

  it('refuses texts over maxCharacters before any request', async () => {
    const fetchImpl = vi.fn(async () => okTts());
    const provider = makeProvider(fetchImpl, { maxCharacters: 3 });
    await expect(
      provider.synthesize('よんもじ', { voiceId: 'v' }),
    ).rejects.toBeInstanceOf(MiniMaxTtsError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects audio that is not valid hex', async () => {
    const fetchImpl = vi.fn(async () => okTts({ audio: 'zzzz' }));
    const provider = makeProvider(fetchImpl);
    await expect(
      provider.synthesize('テスト', { voiceId: 'v' }),
    ).rejects.toBeInstanceOf(MiniMaxTtsError);
  });

  it('does not retry on 401 or 403', async () => {
    for (const status of [401, 403]) {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({ error: { message: 'unauthorized' } }, { status }),
      );
      const provider = makeProvider(fetchImpl);
      const error = await provider
        .synthesize('テスト', { voiceId: 'v' })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MiniMaxTtsError);
      expect((error as MiniMaxTtsError).httpStatus).toBe(status);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('retries on 429 and succeeds when the provider recovers', async () => {
    const sequence = [
      () => jsonResponse({ error: { message: 'slow down' } }, { status: 429 }),
      () => okTts(),
    ];
    const fetchImpl = vi.fn(async () => {
      const next = sequence.shift();
      if (next === undefined) throw new Error('unexpected extra call');
      return next();
    });
    const provider = makeProvider(fetchImpl);
    const result = await provider.synthesize('テスト', { voiceId: 'v' });
    expect(result.bytes).toEqual(Buffer.from(KNOWN_BYTES));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('caps attempts on persistent 5xx', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: 'server error' } }, { status: 503 }),
    );
    const provider = makeProvider(fetchImpl, { maxAttempts: 3 });
    await expect(
      provider.synthesize('テスト', { voiceId: 'v' }),
    ).rejects.toBeInstanceOf(MiniMaxTtsError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('retries timeouts and surfaces TtsTimeoutError after exhausting attempts', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('The operation timed out', 'TimeoutError');
    });
    const provider = makeProvider(fetchImpl, {
      maxAttempts: 2,
      timeoutMs: 1_000,
    });
    await expect(
      provider.synthesize('テスト', { voiceId: 'v' }),
    ).rejects.toBeInstanceOf(TtsTimeoutError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never includes the API key in error messages on any failure path', async () => {
    const scenarios: Array<() => Promise<unknown>> = [
      () =>
        makeProvider(
          vi.fn(async () =>
            jsonResponse({ error: { message: 'unauthorized' } }, { status: 401 }),
          ),
        ).synthesize('テスト', { voiceId: 'v' }),
      () =>
        makeProvider(
          vi.fn(async () => {
            throw new TypeError('fetch failed');
          }),
        ).synthesize('テスト', { voiceId: 'v' }),
      () =>
        makeProvider(
          vi.fn(async () =>
            jsonResponse({
              data: { audio: '', status: 0 },
              extra_info: { usage_characters: 0 },
              base_resp: { status_code: 1002, status_msg: 'bad key' },
              trace_id: 't-1',
            }),
          ),
        ).synthesize('テスト', { voiceId: 'v' }),
    ];
    for (const run of scenarios) {
      const error = await run().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(API_KEY);
    }
  });
});
