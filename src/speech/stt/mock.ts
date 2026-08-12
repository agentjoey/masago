import { canonicalContainer } from '../types.js';
import type { AudioFileRef } from '../types.js';
import type {
  SpeechToTextProvider,
  SttOptions,
  Transcript,
} from './types.js';
import { SttTimeoutError, SttUnsupportedFormatError } from './types.js';

export const MOCK_STT_SUPPORTED_INPUT_FORMATS = [
  'mp3',
  'mp4',
  'mpeg',
  'mpga',
  'm4a',
  'wav',
  'webm',
] as const;

export const MOCK_STT_DEFAULT_TRANSCRIPT = '映画を見るました';

export interface MockSttOptions {
  transcript?: string;
  language?: string;
  durationMs?: number;
  model?: string;
  failure?: Error;
  delayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MockSttProvider implements SpeechToTextProvider {
  readonly name = 'mock-stt';
  readonly model: string;
  readonly supportedInputFormats: readonly string[] =
    MOCK_STT_SUPPORTED_INPUT_FORMATS;

  private readonly transcript: string;
  private readonly language?: string;
  private readonly durationMs?: number;
  private readonly failure?: Error;
  private readonly delayMs?: number;

  constructor(options?: MockSttOptions) {
    this.transcript = options?.transcript ?? MOCK_STT_DEFAULT_TRANSCRIPT;
    this.language = options?.language ?? 'ja';
    this.durationMs = options?.durationMs;
    this.model = options?.model ?? 'mock-transcribe-1';
    this.failure = options?.failure;
    this.delayMs = options?.delayMs;
  }

  async transcribe(audio: AudioFileRef, options?: SttOptions): Promise<Transcript> {
    const container = canonicalContainer(audio.container);
    if (!this.supportedInputFormats.includes(container)) {
      throw new SttUnsupportedFormatError(container, this.supportedInputFormats);
    }
    const timeoutMs = options?.timeoutMs;
    if (this.delayMs !== undefined) {
      if (timeoutMs !== undefined && this.delayMs > timeoutMs) {
        throw new SttTimeoutError(timeoutMs);
      }
      await sleep(this.delayMs);
    }
    if (this.failure !== undefined) {
      throw this.failure;
    }
    return {
      rawText: this.transcript,
      language: this.language,
      durationMs: this.durationMs,
      provider: this.name,
      model: this.model,
      usage: {
        audioSeconds: this.durationMs !== undefined ? this.durationMs / 1000 : 5,
      },
    };
  }
}
