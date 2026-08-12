import { z } from 'zod';
import {
  fetchWithRetry,
  isTimeoutError,
  ProviderHttpError,
} from '../providerFactory.js';
import type {
  AudioResult,
  TextToSpeechProvider,
  VoiceConfig,
} from './types.js';
import { TtsError, TtsTimeoutError } from './types.js';

const DEFAULT_BASE_URL = 'https://api.minimax.io';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_LANGUAGE_BOOST = 'Japanese';
const HEX_PATTERN = /^[0-9a-fA-F]+$/;

export interface MiniMaxTtsProviderOptions {
  apiKey: string;
  model: string;
  maxCharacters: number;
  baseUrl?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class MiniMaxTtsError extends TtsError {
  readonly httpStatus?: number;
  readonly statusCode?: number;
  readonly traceId?: string;

  constructor(
    message: string,
    options?: { httpStatus?: number; statusCode?: number; traceId?: string },
  ) {
    super(message);
    this.name = 'MiniMaxTtsError';
    this.httpStatus = options?.httpStatus;
    this.statusCode = options?.statusCode;
    this.traceId = options?.traceId;
  }
}

const t2aResponseSchema = z.object({
  data: z.object({
    audio: z.string(),
    status: z.number().optional(),
  }),
  extra_info: z.object({
    usage_characters: z.number().int().nonnegative(),
    audio_length: z.number().optional(),
  }),
  base_resp: z.object({
    status_code: z.number(),
    status_msg: z.string(),
  }),
  trace_id: z.string().optional(),
});

export class MiniMaxTtsProvider implements TextToSpeechProvider {
  readonly name = 'minimax';
  readonly model: string;
  readonly outputFormat = 'mp3';

  private readonly apiKey: string;
  private readonly maxCharacters: number;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts?: number;
  private readonly fetchImpl?: typeof fetch;
  private readonly sleep?: (ms: number) => Promise<void>;

  constructor(options: MiniMaxTtsProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.maxCharacters = options.maxCharacters;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = options.maxAttempts;
    this.fetchImpl = options.fetchImpl;
    this.sleep = options.sleep;
  }

  async synthesize(text: string, voice: VoiceConfig): Promise<AudioResult> {
    if (text.length > this.maxCharacters) {
      throw new MiniMaxTtsError(
        `tts text length ${String(text.length)} exceeds the ${String(this.maxCharacters)} character limit; refusing to send`,
      );
    }

    const payload = {
      model: this.model,
      text,
      stream: false,
      language_boost: voice.languageBoost ?? DEFAULT_LANGUAGE_BOOST,
      voice_setting: {
        voice_id: voice.voiceId,
        speed: voice.speed ?? 1,
        vol: 1,
        pitch: voice.pitch ?? 0,
      },
      audio_setting: {
        format: 'mp3',
        sample_rate: 32_000,
        bitrate: 128_000,
        channel: 1,
      },
    };

    let response: Response;
    try {
      response = await fetchWithRetry(
        `${this.baseUrl}/v1/t2a_v2`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        },
        {
          fetchImpl: this.fetchImpl,
          timeoutMs: this.timeoutMs,
          maxAttempts: this.maxAttempts,
          sleep: this.sleep,
        },
      );
    } catch (error) {
      if (error instanceof ProviderHttpError) {
        throw new MiniMaxTtsError(error.message, { httpStatus: error.status });
      }
      if (isTimeoutError(error)) {
        throw new TtsTimeoutError(this.timeoutMs);
      }
      throw new MiniMaxTtsError('minimax tts request failed');
    }

    const body: unknown = await response.json().catch(() => undefined);
    const parsed = t2aResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new MiniMaxTtsError(
        'minimax tts response did not match the expected shape',
      );
    }

    const { data, extra_info, base_resp, trace_id } = parsed.data;
    if (base_resp.status_code !== 0) {
      throw new MiniMaxTtsError(
        `minimax tts failed (status_code ${String(base_resp.status_code)}): ${base_resp.status_msg} (trace_id: ${trace_id ?? 'n/a'})`,
        { statusCode: base_resp.status_code, traceId: trace_id },
      );
    }

    if (data.audio.length % 2 !== 0 || !HEX_PATTERN.test(data.audio)) {
      throw new MiniMaxTtsError(
        'minimax tts returned audio that is not valid hex',
        { traceId: trace_id },
      );
    }
    const bytes = Buffer.from(data.audio, 'hex');

    return {
      bytes,
      format: this.outputFormat,
      durationMs: extra_info.audio_length,
      provider: this.name,
      model: this.model,
      usage: {
        characters: extra_info.usage_characters,
        requestId: trace_id,
      },
    };
  }
}
