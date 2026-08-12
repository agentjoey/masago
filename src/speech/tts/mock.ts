import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AudioResult, TextToSpeechProvider, VoiceConfig } from './types.js';
import { TtsTimeoutError } from './types.js';

export interface MockTtsOptions {
  outputDir?: string;
  model?: string;
  timeoutMs?: number;
  failure?: Error;
  delayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MockTtsProvider implements TextToSpeechProvider {
  readonly name = 'mock-tts';
  readonly model: string;
  readonly outputFormat = 'mp3';

  private readonly outputDir: string;
  private readonly timeoutMs?: number;
  private readonly failure?: Error;
  private readonly delayMs?: number;

  constructor(options?: MockTtsOptions) {
    this.outputDir = options?.outputDir ?? tmpdir();
    this.model = options?.model ?? 'mock-speech-1';
    this.timeoutMs = options?.timeoutMs;
    this.failure = options?.failure;
    this.delayMs = options?.delayMs;
  }

  async synthesize(text: string, voice: VoiceConfig): Promise<AudioResult> {
    if (this.delayMs !== undefined) {
      if (this.timeoutMs !== undefined && this.delayMs > this.timeoutMs) {
        throw new TtsTimeoutError(this.timeoutMs);
      }
      await sleep(this.delayMs);
    }
    if (this.failure !== undefined) {
      throw this.failure;
    }
    await mkdir(this.outputDir, { recursive: true, mode: 0o700 });
    const path = join(this.outputDir, `reply-${randomUUID()}.mp3`);
    const placeholder = Buffer.from(
      `MOCK-TTS PLACEHOLDER\nmodel=${this.model}\nvoice=${voice.voiceId}\ntext=${text}\n`,
      'utf8',
    );
    await writeFile(path, placeholder, { mode: 0o600 });
    return {
      path,
      format: this.outputFormat,
      provider: this.name,
      model: this.model,
      usage: { characters: text.length },
    };
  }
}
