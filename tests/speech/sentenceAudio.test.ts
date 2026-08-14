import { describe, expect, it, vi } from 'vitest';
import { createSentenceAudioCache } from '../../src/speech/sentenceAudio.js';
import type { TextToSpeechProvider } from '../../src/speech/tts/types.js';

function provider(
  synthesize = vi.fn(async (text: string) => ({
    bytes: Buffer.from(`audio:${text}`),
    format: 'mp3' as const,
  })),
): { tts: TextToSpeechProvider; synthesize: typeof synthesize } {
  return { tts: { synthesize } as unknown as TextToSpeechProvider, synthesize };
}

describe('例文の読み上げキャッシュ', () => {
  it('synthesizes once and serves the rest from memory', async () => {
    const { tts, synthesize } = provider();
    const cache = createSentenceAudioCache({ tts, voiceId: 'v' });

    const first = await cache.get('1', 'これはテストです。');
    const second = await cache.get('1', 'これはテストです。');

    expect(first?.toString()).toBe('audio:これはテストです。');
    expect(second).toEqual(first);
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  /**
   * 押し込み連打で二度合成しない。合成は有料の呼び出しに繋がる。
   */
  it('collapses concurrent requests for the same sentence', async () => {
    let resolveIt: ((value: { bytes: Buffer; format: 'mp3' }) => void) | undefined;
    const synthesize = vi.fn(
      () =>
        new Promise<{ bytes: Buffer; format: 'mp3' }>((resolve) => {
          resolveIt = resolve;
        }),
    );
    const { tts } = provider(synthesize as never);
    const cache = createSentenceAudioCache({ tts, voiceId: 'v' });

    const all = Promise.all([
      cache.get('1', 'テスト'),
      cache.get('1', 'テスト'),
      cache.get('1', 'テスト'),
    ]);
    resolveIt?.({ bytes: Buffer.from('once'), format: 'mp3' });
    const results = await all;

    expect(synthesize).toHaveBeenCalledTimes(1);
    for (const result of results) expect(result?.toString()).toBe('once');
  });

  it('evicts the least recently used entry', async () => {
    const { tts, synthesize } = provider();
    const cache = createSentenceAudioCache({ tts, voiceId: 'v', maxEntries: 2 });

    await cache.get('1', 'a');
    await cache.get('2', 'b');
    await cache.get('3', 'c'); // 1 が落ちる
    expect(cache.size).toBe(2);

    await cache.get('1', 'a'); // 落ちているので再合成
    expect(synthesize).toHaveBeenCalledTimes(4);
  });

  it('keeps an entry alive when it is used again', async () => {
    const { tts, synthesize } = provider();
    const cache = createSentenceAudioCache({ tts, voiceId: 'v', maxEntries: 2 });

    await cache.get('1', 'a');
    await cache.get('2', 'b');
    await cache.get('1', 'a'); // 1 を末尾へ動かす
    await cache.get('3', 'c'); // 落ちるのは 2
    await cache.get('1', 'a'); // まだ在る＝再合成しない

    expect(synthesize).toHaveBeenCalledTimes(3);
  });

  /** 音が出せなくても読む練習は続く。文字は画面にある。 */
  it('gives back nothing when the provider returns no bytes', async () => {
    const synthesize = vi.fn(() => Promise.resolve({ format: 'mp3' as const }));
    const { tts } = provider(synthesize as never);
    const cache = createSentenceAudioCache({ tts, voiceId: 'v' });
    expect(await cache.get('1', 'テスト')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('lets a failure through so the caller can answer 503', async () => {
    const synthesize = vi.fn(() => Promise.reject(new Error('tts down')));
    const { tts } = provider(synthesize as never);
    const cache = createSentenceAudioCache({ tts, voiceId: 'v' });
    await expect(cache.get('1', 'テスト')).rejects.toThrow('tts down');
  });

  /** 失敗した回を掴んだままにしない。次の要求で再試行できること。 */
  it('retries after a failure instead of caching the rejection', async () => {
    let attempt = 0;
    const synthesize = vi.fn(() => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error('flaky'))
        : Promise.resolve({ bytes: Buffer.from('ok'), format: 'mp3' as const });
    });
    const { tts } = provider(synthesize as never);
    const cache = createSentenceAudioCache({ tts, voiceId: 'v' });

    await expect(cache.get('1', 'テスト')).rejects.toThrow('flaky');
    expect((await cache.get('1', 'テスト'))?.toString()).toBe('ok');
  });

  it('passes the configured voice through', async () => {
    const { tts, synthesize } = provider();
    const cache = createSentenceAudioCache({ tts, voiceId: 'Japanese_CalmLady' });
    await cache.get('1', 'テスト');
    expect(synthesize).toHaveBeenCalledWith('テスト', {
      voiceId: 'Japanese_CalmLady',
    });
  });
});

describe('計量の通知', () => {
  it('reports each synthesis exactly once, never for cache hits', async () => {
    const seen: number[] = [];
    const synthesize = vi.fn(async (text: string) => ({
      bytes: Buffer.from(`audio:${text}`),
      format: 'mp3' as const,
      provider: 'minimax',
      model: 'speech-2.8-hd',
      usage: { characters: text.length },
    }));
    const cache = createSentenceAudioCache({
      tts: { synthesize } as never,
      voiceId: 'v',
      onSynthesized: (result) => seen.push(result.usage.characters),
    });

    await cache.get('1', 'これはテストです。');
    await cache.get('1', 'これはテストです。');
    await cache.get('1', 'これはテストです。');

    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['これはテストです。'.length]);
  });
});
