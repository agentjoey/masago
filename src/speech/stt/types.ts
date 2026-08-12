import type { AudioFileRef } from '../types.js';

export interface SttUsage {
  audioSeconds: number;
  requestId?: string;
}

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface Transcript {
  rawText: string;
  language?: string;
  durationMs?: number;
  confidence?: number;
  segments?: TranscriptSegment[];
  provider: string;
  model: string;
  usage: SttUsage;
}

export interface SttOptions {
  language?: string;
  timeoutMs?: number;
  durationSeconds?: number;
}

export interface SpeechToTextProvider {
  readonly name: string;
  readonly model: string;
  readonly supportedInputFormats: readonly string[];
  transcribe(audio: AudioFileRef, options?: SttOptions): Promise<Transcript>;
}

export class SttError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SttError';
  }
}

export class SttUnsupportedFormatError extends SttError {
  readonly container: string;

  constructor(container: string, supported: readonly string[]) {
    super(
      `container "${container}" is not in supportedInputFormats [${supported.join(', ')}]`,
    );
    this.name = 'SttUnsupportedFormatError';
    this.container = container;
  }
}

export class SttTimeoutError extends SttError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`stt timed out after ${timeoutMs}ms`);
    this.name = 'SttTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}
