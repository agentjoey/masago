import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import { canonicalContainer } from '../types.js';
import type { AudioFileRef } from '../types.js';
import {
  fetchWithRetry,
  isTimeoutError,
  ProviderHttpError,
} from '../providerFactory.js';
import type {
  SpeechToTextProvider,
  SttOptions,
  Transcript,
} from './types.js';
import {
  SttError,
  SttTimeoutError,
  SttUnsupportedFormatError,
} from './types.js';

export const OPENAI_STT_SUPPORTED_INPUT_FORMATS = [
  'mp3',
  'mp4',
  'mpeg',
  'mpga',
  'm4a',
  'wav',
  'webm',
] as const;

export const OPENAI_STT_MAX_FILE_BYTES = 25 * 1024 * 1024;

const DEFAULT_BASE_URL = 'https://api.openai.com';
const DEFAULT_TIMEOUT_MS = 120_000;

export interface OpenAiSttProviderOptions {
  apiKey: string;
  model: string;
  contextHintsEnabled?: boolean;
  contextPrompt?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  maxFileBytes?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface OpenAiTranscribeOptions extends SttOptions {
  durationSeconds?: number;
}

export class OpenAiSttError extends SttError {
  readonly status?: number;
  readonly requestId?: string;

  constructor(
    message: string,
    options?: { status?: number; requestId?: string },
  ) {
    super(message);
    this.name = 'OpenAiSttError';
    this.status = options?.status;
    this.requestId = options?.requestId;
  }
}

const transcriptionResponseSchema = z.object({
  text: z.string(),
});

export class OpenAiSttProvider implements SpeechToTextProvider {
  readonly name = 'openai';
  readonly model: string;
  readonly supportedInputFormats: readonly string[] =
    OPENAI_STT_SUPPORTED_INPUT_FORMATS;

  private readonly apiKey: string;
  private readonly contextHintsEnabled: boolean;
  private readonly contextPrompt?: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts?: number;
  private readonly maxFileBytes: number;
  private readonly fetchImpl?: typeof fetch;
  private readonly sleep?: (ms: number) => Promise<void>;

  constructor(options: OpenAiSttProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.contextHintsEnabled = options.contextHintsEnabled ?? false;
    this.contextPrompt = options.contextPrompt;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = options.maxAttempts;
    this.maxFileBytes = options.maxFileBytes ?? OPENAI_STT_MAX_FILE_BYTES;
    this.fetchImpl = options.fetchImpl;
    this.sleep = options.sleep;
  }

  async transcribe(
    audio: AudioFileRef,
    options?: SttOptions,
  ): Promise<Transcript> {
    const container = canonicalContainer(audio.container);
    if (!this.supportedInputFormats.includes(container)) {
      throw new SttUnsupportedFormatError(container, this.supportedInputFormats);
    }

    const info = await stat(audio.path);
    if (info.size > this.maxFileBytes) {
      throw new OpenAiSttError(
        `audio file exceeds the ${String(this.maxFileBytes)} byte limit`,
      );
    }
    const bytes = await readFile(audio.path);

    const form = new FormData();
    form.append('file', new Blob([bytes]), basename(audio.path));
    form.append('model', this.model);
    if (this.contextHintsEnabled && this.contextPrompt !== undefined) {
      form.append('prompt', this.contextPrompt);
    }

    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    let response: Response;
    try {
      response = await fetchWithRetry(
        `${this.baseUrl}/v1/audio/transcriptions`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.apiKey}` },
          body: form,
        },
        {
          fetchImpl: this.fetchImpl,
          timeoutMs,
          maxAttempts: this.maxAttempts,
          sleep: this.sleep,
        },
      );
    } catch (error) {
      if (error instanceof ProviderHttpError) {
        throw new OpenAiSttError(error.message, { status: error.status });
      }
      if (isTimeoutError(error)) {
        throw new SttTimeoutError(timeoutMs);
      }
      throw new OpenAiSttError('openai transcription request failed');
    }

    const requestId = response.headers.get('x-request-id') ?? undefined;
    const body: unknown = await response.json().catch(() => undefined);
    const parsed = transcriptionResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new OpenAiSttError(
        'openai transcription response did not match the expected shape',
        { requestId },
      );
    }

    const extended = options as OpenAiTranscribeOptions | undefined;
    return {
      rawText: parsed.data.text,
      language: options?.language,
      provider: this.name,
      model: this.model,
      usage: {
        audioSeconds: extended?.durationSeconds ?? 0,
        requestId,
      },
    };
  }
}
