import { describe, expect, it, vi } from 'vitest';
import { speak, type VoiceCachePort } from '../../src/speech/voiceCache.js';
import type { TextToSpeechProvider } from '../../src/speech/tts/types.js';

function fakeTts(overrides?: Partial<TextToSpeechProvider>): TextToSpeechProvider {
  return {
    name: 'fake',
    model: 'speech-test',
    outputFormat: 'mp3',
    synthesize: vi.fn().mockResolvedValue({
      bytes: Buffer.from('audio'),
      format: 'mp3',
      provider: 'fake',
      model: 'speech-test',
    }),
    ...overrides,
  } as TextToSpeechProvider;
}

function fakeCache(hit?: string): VoiceCachePort & { remembered: string[] } {
  const remembered: string[] = [];
  return {
    remembered,
    lookup: () => Promise.resolve(hit),
    remember: (text) => {
      remembered.push(text);
      return Promise.resolve();
    },
  };
}

describe('speak', () => {
  it('synthesises the first time', async () => {
    const tts = fakeTts();
    const result = await speak('いま', {
      cache: fakeCache(),
      tts,
      voiceId: 'v1',
    });
    expect(result.cached).toBe(false);
    expect(result.bytes?.toString()).toBe('audio');
    expect(tts.synthesize).toHaveBeenCalledOnce();
  });

  // 復習は同じ項目を何ヶ月も繰り返す。ここが当たるほど費用が下がる。
  it('reuses the file id and does not synthesise again', async () => {
    const tts = fakeTts();
    const result = await speak('いま', {
      cache: fakeCache('AgADBAADq'),
      tts,
      voiceId: 'v1',
    });
    expect(result.cached).toBe(true);
    expect(result.fileId).toBe('AgADBAADq');
    expect(result.bytes).toBeUndefined();
    expect(tts.synthesize).not.toHaveBeenCalled();
  });

  it('returns nothing playable rather than silence when the provider gives no bytes', async () => {
    const tts = fakeTts({
      synthesize: vi.fn().mockResolvedValue({
        path: '/tmp/x.mp3',
        format: 'mp3',
        provider: 'fake',
        model: 'speech-test',
      }),
    });
    const result = await speak('いま', {
      cache: fakeCache(),
      tts,
      voiceId: 'v1',
    });
    expect(result.cached).toBe(false);
    expect(result.bytes).toBeUndefined();
    expect(result.fileId).toBeUndefined();
  });
});

describe('計量の通し（/cost の材料）', () => {
  /**
   * 合成の usage をここで捨てていたせいで、単語カードの読み上げは
   * 一度も記録されていなかった（usage_records 0 行の一因）。
   */
  it('passes the synthesis usage through on a cache miss', async () => {
    const spoken = await speak('ほん', {
      cache: {
        lookup: () => Promise.resolve(undefined),
        remember: () => Promise.resolve(),
      },
      tts: {
        name: 'minimax',
        model: 'speech-2.8-hd',
        outputFormat: 'mp3',
        synthesize: () =>
          Promise.resolve({
            bytes: Buffer.from('mp3'),
            format: 'mp3',
            provider: 'minimax',
            model: 'speech-2.8-hd',
            usage: { characters: 2, requestId: 'req-9' },
          }),
      } as never,
      voiceId: 'v',
    });
    expect(spoken.usage).toEqual({ characters: 2, requestId: 'req-9' });
    expect(spoken.provider).toBe('minimax');
    expect(spoken.model).toBe('speech-2.8-hd');
  });

  it('reports no usage on a cache hit — nothing was synthesized', async () => {
    const spoken = await speak('ほん', {
      cache: {
        lookup: () => Promise.resolve('file-id-1'),
        remember: () => Promise.resolve(),
      },
      tts: {
        synthesize: () => Promise.reject(new Error('must not be called')),
      } as never,
      voiceId: 'v',
    });
    expect(spoken.fileId).toBe('file-id-1');
    expect(spoken.usage).toBeUndefined();
  });
});
