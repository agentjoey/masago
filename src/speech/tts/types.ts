export interface TtsUsage {
  characters: number;
  requestId?: string;
}

export interface VoiceConfig {
  voiceId: string;
  speed?: number;
  pitch?: number;
  languageBoost?: string;
}

export interface AudioResult {
  path?: string;
  bytes?: Buffer;
  format: string;
  durationMs?: number;
  provider: string;
  model: string;
  usage: TtsUsage;
}

export interface TextToSpeechProvider {
  readonly name: string;
  readonly model: string;
  readonly outputFormat: string;
  synthesize(text: string, voice: VoiceConfig): Promise<AudioResult>;
}

export class TtsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TtsError';
  }
}

export class TtsTimeoutError extends TtsError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`tts timed out after ${timeoutMs}ms`);
    this.name = 'TtsTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}
