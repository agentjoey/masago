import type { AppConfig } from '../config/index.js';
import { MockSttProvider } from './stt/mock.js';
import { OpenAiSttProvider } from './stt/openai.js';
import type { SpeechToTextProvider } from './stt/types.js';
import { MiniMaxTtsProvider } from './tts/minimax.js';
import { MockTtsProvider } from './tts/mock.js';
import type { TextToSpeechProvider } from './tts/types.js';

export const SUPPORTED_STT_PROVIDERS = ['openai', 'mock'] as const;
export const SUPPORTED_TTS_PROVIDERS = ['minimax', 'mock'] as const;

const RETRYABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([
  429, 500, 502, 503, 504,
]);

export function isRetryableHttpStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUSES.has(status);
}

export function isTimeoutError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: string }).name === 'TimeoutError'
  );
}

export class ProviderHttpError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(
      detail === ''
        ? `provider request failed (HTTP ${String(status)})`
        : `provider request failed (HTTP ${String(status)}): ${detail}`,
    );
    this.name = 'ProviderHttpError';
    this.status = status;
  }
}

const ERROR_BODY_MAX_LENGTH = 200;

function describeErrorBody(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null) {
      const message = (parsed as { error?: { message?: unknown } }).error
        ?.message;
      if (typeof message === 'string' && message !== '') {
        return message.slice(0, ERROR_BODY_MAX_LENGTH);
      }
    }
  } catch {
    // fall through to raw body
  }
  const collapsed = body.replace(/\s+/g, ' ').trim();
  return collapsed.slice(0, ERROR_BODY_MAX_LENGTH);
}

export interface FetchRetryOptions {
  fetchImpl?: typeof fetch;
  timeoutMs: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 8_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: FetchRetryOptions,
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let retryable = false;
    try {
      const response = await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      if (response.ok) {
        return response;
      }
      retryable = isRetryableHttpStatus(response.status);
      if (!retryable || attempt === maxAttempts) {
        const body = await response.text().catch(() => '');
        throw new ProviderHttpError(response.status, describeErrorBody(body));
      }
    } catch (error) {
      if (error instanceof ProviderHttpError) {
        throw error;
      }
      retryable = true;
      lastError = error;
      if (attempt === maxAttempts) {
        throw error;
      }
    }
    if (retryable) {
      const backoff = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const jitter = Math.floor(random() * baseDelayMs);
      await sleep(backoff + jitter);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('provider request failed');
}

export interface SpeechProviderFactoryDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function createSttProvider(
  config: AppConfig,
  deps?: SpeechProviderFactoryDeps,
): SpeechToTextProvider {
  switch (config.stt.provider) {
    case 'openai':
      return new OpenAiSttProvider({
        apiKey: config.stt.openaiApiKey,
        model: config.stt.model,
        contextHintsEnabled: config.stt.contextHintsEnabled,
        fetchImpl: deps?.fetchImpl,
        sleep: deps?.sleep,
      });
    case 'mock':
      return new MockSttProvider();
    default:
      throw new Error(
        `unknown stt provider "${config.stt.provider}"; supported values: ${SUPPORTED_STT_PROVIDERS.join(', ')}`,
      );
  }
}

export function createTtsProvider(
  config: AppConfig,
  deps?: SpeechProviderFactoryDeps,
): TextToSpeechProvider {
  switch (config.tts.provider) {
    case 'minimax':
      return new MiniMaxTtsProvider({
        apiKey: config.tts.minimaxApiKey,
        model: config.tts.modelConversation,
        maxCharacters: config.tts.maxCharacters,
        fetchImpl: deps?.fetchImpl,
        sleep: deps?.sleep,
      });
    case 'mock':
      return new MockTtsProvider();
    default:
      throw new Error(
        `unknown tts provider "${config.tts.provider}"; supported values: ${SUPPORTED_TTS_PROVIDERS.join(', ')}`,
      );
  }
}

export interface SpeechProviders {
  stt: SpeechToTextProvider;
  tts: TextToSpeechProvider;
}

export interface SpeechProvidersDeps {
  sttFetch?: typeof fetch;
  ttsFetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function createSpeechProviders(
  config: AppConfig,
  deps?: SpeechProvidersDeps,
): SpeechProviders {
  return {
    stt: createSttProvider(config, {
      fetchImpl: deps?.sttFetch,
      sleep: deps?.sleep,
    }),
    tts: createTtsProvider(config, {
      fetchImpl: deps?.ttsFetch,
      sleep: deps?.sleep,
    }),
  };
}
