import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OPENAI_STT_SUPPORTED_INPUT_FORMATS,
  OpenAiSttError,
  OpenAiSttProvider,
  type OpenAiTranscribeOptions,
} from '../../src/speech/stt/openai.js';
import {
  SttTimeoutError,
  SttUnsupportedFormatError,
} from '../../src/speech/stt/types.js';

const API_KEY = 'sk-test-secret-key-12345';
const MODEL = 'gpt-transcribe';
const RAW_TRANSCRIPT = '  昨日友達と映画を見るました、そして食べるました。  ';

type FetchStub = ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  });
}

function okTranscription(headers?: Record<string, string>): Response {
  return jsonResponse({ text: RAW_TRANSCRIPT }, { headers });
}

function lastInit(fetchImpl: FetchStub): RequestInit {
  const call = fetchImpl.mock.calls.at(-1);
  expect(call).toBeDefined();
  return call?.[1] as RequestInit;
}

function lastForm(fetchImpl: FetchStub): FormData {
  const body = lastInit(fetchImpl).body;
  expect(body).toBeInstanceOf(FormData);
  return body as FormData;
}

function makeProvider(
  fetchImpl: FetchStub,
  overrides?: Partial<ConstructorParameters<typeof OpenAiSttProvider>[0]>,
): OpenAiSttProvider {
  return new OpenAiSttProvider({
    apiKey: API_KEY,
    model: MODEL,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep: () => Promise.resolve(),
    ...overrides,
  });
}

describe('OpenAiSttProvider', () => {
  let dir: string;
  let audioPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openai-stt-test-'));
    audioPath = join(dir, 'input.webm');
    await writeFile(audioPath, Buffer.from([1, 2, 3, 4, 5]));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('declares exactly the seven OpenAI formats, without ogg', () => {
    const provider = makeProvider(vi.fn());
    expect(provider.supportedInputFormats).toEqual([
      'mp3',
      'mp4',
      'mpeg',
      'mpga',
      'm4a',
      'wav',
      'webm',
    ]);
    expect(provider.supportedInputFormats).not.toContain('ogg');
    expect(OPENAI_STT_SUPPORTED_INPUT_FORMATS).toHaveLength(7);
  });

  it('sends multipart form with exactly file and model fields and a bearer token', async () => {
    const fetchImpl = vi.fn(async () => okTranscription());
    const provider = makeProvider(fetchImpl);
    await provider.transcribe({ path: audioPath, container: 'webm' });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    expect(
      (init.headers as Record<string, string>)['Authorization'],
    ).toBe(`Bearer ${API_KEY}`);

    const form = lastForm(fetchImpl);
    const keys = [...form.keys()].sort();
    expect(keys).toEqual(['file', 'model']);
    expect(form.get('model')).toBe(MODEL);
    const file = form.get('file');
    expect(file).toBeInstanceOf(Blob);
    expect((file as Blob).size).toBe(5);
    expect((file as File).name).toBe('input.webm');
  });

  it('never sends prompt/context/keyword fields when hints are disabled, even if a prompt is configured', async () => {
    const fetchImpl = vi.fn(async () => okTranscription());
    const provider = makeProvider(fetchImpl, {
      contextHintsEnabled: false,
      contextPrompt: '日本語学習者',
    });
    await provider.transcribe({ path: audioPath, container: 'webm' });

    const form = lastForm(fetchImpl);
    expect(form.has('prompt')).toBe(false);
    expect(form.has('context')).toBe(false);
    expect(form.has('keywords')).toBe(false);
    expect([...form.keys()].sort()).toEqual(['file', 'model']);
  });

  it('sends the prompt field only when hints are enabled', async () => {
    const fetchImpl = vi.fn(async () => okTranscription());
    const provider = makeProvider(fetchImpl, {
      contextHintsEnabled: true,
      contextPrompt: '日本語学習者',
    });
    await provider.transcribe({ path: audioPath, container: 'webm' });
    expect(lastForm(fetchImpl).get('prompt')).toBe('日本語学習者');
  });

  it('returns the provider text verbatim in rawText, without any cleanup', async () => {
    const fetchImpl = vi.fn(async () => okTranscription());
    const provider = makeProvider(fetchImpl);
    const transcript = await provider.transcribe(
      { path: audioPath, container: 'webm' },
      { language: 'ja' },
    );
    expect(transcript.rawText).toBe(RAW_TRANSCRIPT);
    expect(transcript.language).toBe('ja');
    expect(transcript.provider).toBe('openai');
    expect(transcript.model).toBe(MODEL);
  });

  it('fills usage from the caller-provided duration and the x-request-id header', async () => {
    const fetchImpl = vi.fn(async () =>
      okTranscription({ 'x-request-id': 'req-abc-123' }),
    );
    const provider = makeProvider(fetchImpl);
    const options: OpenAiTranscribeOptions = {
      language: 'ja',
      durationSeconds: 12.5,
    };
    const transcript = await provider.transcribe(
      { path: audioPath, container: 'webm' },
      options,
    );
    expect(transcript.usage.audioSeconds).toBe(12.5);
    expect(transcript.usage.requestId).toBe('req-abc-123');
  });

  it('rejects containers outside supportedInputFormats before any request', async () => {
    const fetchImpl = vi.fn(async () => okTranscription());
    const provider = makeProvider(fetchImpl);
    await expect(
      provider.transcribe({ path: audioPath, container: 'ogg' }),
    ).rejects.toBeInstanceOf(SttUnsupportedFormatError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects files over the 25MB limit before any request', async () => {
    const fetchImpl = vi.fn(async () => okTranscription());
    const provider = makeProvider(fetchImpl, { maxFileBytes: 4 });
    await expect(
      provider.transcribe({ path: audioPath, container: 'webm' }),
    ).rejects.toBeInstanceOf(OpenAiSttError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not retry on 401 or 403', async () => {
    for (const status of [401, 403]) {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({ error: { message: 'invalid authentication' } }, { status }),
      );
      const provider = makeProvider(fetchImpl);
      const error = await provider
        .transcribe({ path: audioPath, container: 'webm' })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(OpenAiSttError);
      expect((error as OpenAiSttError).status).toBe(status);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('retries on 429 with backoff and succeeds when the provider recovers', async () => {
    const delays: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('unused'), { skip: true }),
      ) as FetchStub;
    void fetchImpl;
    const sequence = [
      () => jsonResponse({ error: { message: 'rate limited' } }, { status: 429 }),
      () => jsonResponse({ error: { message: 'rate limited' } }, { status: 429 }),
      () => okTranscription(),
    ];
    const retryingFetch = vi.fn(async () => {
      const next = sequence.shift();
      if (next === undefined) throw new Error('unexpected extra call');
      return next();
    });
    const provider = makeProvider(retryingFetch, {
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });
    const transcript = await provider.transcribe({
      path: audioPath,
      container: 'webm',
    });
    expect(transcript.rawText).toBe(RAW_TRANSCRIPT);
    expect(retryingFetch).toHaveBeenCalledTimes(3);
    expect(delays).toHaveLength(2);
    expect(delays[1]).toBeGreaterThanOrEqual(delays[0] ?? 0);
  });

  it('caps the number of attempts on persistent 5xx', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: 'server error' } }, { status: 500 }),
    );
    const provider = makeProvider(fetchImpl, { maxAttempts: 3 });
    await expect(
      provider.transcribe({ path: audioPath, container: 'webm' }),
    ).rejects.toBeInstanceOf(OpenAiSttError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('retries timeouts and surfaces SttTimeoutError after exhausting attempts', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('The operation timed out', 'TimeoutError');
    });
    const provider = makeProvider(fetchImpl, {
      maxAttempts: 2,
      timeoutMs: 1_000,
    });
    await expect(
      provider.transcribe({ path: audioPath, container: 'webm' }),
    ).rejects.toBeInstanceOf(SttTimeoutError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed success responses instead of guessing', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ nope: true }));
    const provider = makeProvider(fetchImpl);
    await expect(
      provider.transcribe({ path: audioPath, container: 'webm' }),
    ).rejects.toBeInstanceOf(OpenAiSttError);
  });

  it('never includes the API key in error messages on any failure path', async () => {
    const scenarios: Array<() => Promise<unknown>> = [
      () =>
        makeProvider(
          vi.fn(async () =>
            jsonResponse(
              { error: { message: 'invalid authentication' } },
              { status: 401 },
            ),
          ),
        ).transcribe({ path: audioPath, container: 'webm' }),
      () =>
        makeProvider(
          vi.fn(async () => {
            throw new TypeError('fetch failed');
          }),
        ).transcribe({ path: audioPath, container: 'webm' }),
      () =>
        makeProvider(vi.fn(async () => jsonResponse({ nope: true }))).transcribe({
          path: audioPath,
          container: 'webm',
        }),
    ];
    for (const run of scenarios) {
      const error = await run().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(API_KEY);
    }
  });
});
