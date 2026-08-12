import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MOCK_STT_DEFAULT_TRANSCRIPT,
  MockSttProvider,
} from '../../src/speech/stt/mock.js';
import { SttTimeoutError, SttUnsupportedFormatError } from '../../src/speech/stt/types.js';
import { MockTtsProvider } from '../../src/speech/tts/mock.js';
import { TtsTimeoutError } from '../../src/speech/tts/types.js';

describe('MockSttProvider', () => {
  it('declares OpenAI-compatible formats without ogg', () => {
    const provider = new MockSttProvider();
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
  });

  it('returns a transcript containing learner errors by default', async () => {
    const provider = new MockSttProvider();
    const transcript = await provider.transcribe({
      path: '/tmp/ws/input.webm',
      container: 'webm',
    });
    expect(transcript.rawText).toBe(MOCK_STT_DEFAULT_TRANSCRIPT);
    expect(transcript.rawText).toBe('映画を見るました');
    expect(transcript.provider).toBe('mock-stt');
    expect(transcript.model).toBe(provider.model);
    expect(transcript.usage.audioSeconds).toBeGreaterThan(0);
  });

  it('never corrects the injected transcript', async () => {
    const broken = '昨日友達と映画を見るました、そして食べるました';
    const provider = new MockSttProvider({ transcript: broken });
    const transcript = await provider.transcribe({
      path: '/tmp/ws/input.webm',
      container: 'webm',
    });
    expect(transcript.rawText).toBe(broken);
  });

  it('rejects containers outside supportedInputFormats', async () => {
    const provider = new MockSttProvider();
    await expect(
      provider.transcribe({ path: '/tmp/ws/input.oga', container: 'ogg' }),
    ).rejects.toBeInstanceOf(SttUnsupportedFormatError);
  });

  it('can simulate failure', async () => {
    const provider = new MockSttProvider({ failure: new Error('provider down') });
    await expect(
      provider.transcribe({ path: '/tmp/ws/input.webm', container: 'webm' }),
    ).rejects.toThrow('provider down');
  });

  it('can simulate timeout', async () => {
    const provider = new MockSttProvider({ delayMs: 5_000 });
    await expect(
      provider.transcribe(
        { path: '/tmp/ws/input.webm', container: 'webm' },
        { timeoutMs: 50 },
      ),
    ).rejects.toBeInstanceOf(SttTimeoutError);
  });

  it('succeeds when the delay fits within the timeout', async () => {
    const provider = new MockSttProvider({ delayMs: 10, durationMs: 2_500 });
    const transcript = await provider.transcribe(
      { path: '/tmp/ws/input.webm', container: 'webm' },
      { timeoutMs: 5_000 },
    );
    expect(transcript.usage.audioSeconds).toBe(2.5);
  });
});

describe('MockTtsProvider', () => {
  it('declares mp3 output like MiniMax', () => {
    const provider = new MockTtsProvider();
    expect(provider.outputFormat).toBe('mp3');
  });

  it('writes a placeholder audio file with mode 0600 and reports usage', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'speech-tts-test-'));
    const provider = new MockTtsProvider({ outputDir });
    const text = 'こんにちは、元気ですか？';
    const result = await provider.synthesize(text, { voiceId: 'ja-default' });
    expect(result.format).toBe('mp3');
    expect(result.provider).toBe('mock-tts');
    expect(result.usage.characters).toBe(text.length);
    expect(result.path).toBeDefined();
    const info = await stat(result.path as string);
    expect(info.mode & 0o777).toBe(0o600);
    expect(info.size).toBeGreaterThan(0);
  });

  it('can simulate failure', async () => {
    const provider = new MockTtsProvider({ failure: new Error('tts down') });
    await expect(
      provider.synthesize('テスト', { voiceId: 'ja-default' }),
    ).rejects.toThrow('tts down');
  });

  it('can simulate timeout', async () => {
    const provider = new MockTtsProvider({ delayMs: 5_000, timeoutMs: 50 });
    await expect(
      provider.synthesize('テスト', { voiceId: 'ja-default' }),
    ).rejects.toBeInstanceOf(TtsTimeoutError);
  });
});
