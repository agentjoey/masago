import { describe, expect, it } from 'vitest';
import { send, type KanaHandlerDeps } from '../../src/telegram/commands/kana.js';
import type { AppContext } from '../../src/telegram/index.js';
import { fakeLogger } from './helpers.js';

/**
 * 返事の吹き出しをいくつ出すか。
 *
 * 音のある返事は**一つ**にまとめる——字と音が割れていると、読み方を
 * 確かめるのに二つを往復することになる。ただし文字は何があっても届ける。
 */

interface Call {
  readonly method: 'text' | 'voice' | 'audio';
  readonly body: string;
  readonly caption?: string;
  readonly hasMarkup: boolean;
}

function fakeCtx(options?: {
  voiceFails?: boolean;
  audioFails?: boolean;
}): { ctx: AppContext; calls: Call[] } {
  const calls: Call[] = [];
  const describeFile = (file: unknown): string =>
    typeof file === 'string' ? file : 'file';
  const ctx = {
    logger: fakeLogger(),
    reply: (text: string, extra?: Record<string, unknown>) => {
      calls.push({
        method: 'text',
        body: text,
        hasMarkup: extra?.['reply_markup'] !== undefined,
      });
      return Promise.resolve({});
    },
    replyWithVoice: (file: unknown, extra?: Record<string, unknown>) => {
      if (options?.voiceFails === true) throw new Error('voice rejected');
      calls.push({
        method: 'voice',
        body: describeFile(file),
        ...(typeof extra?.['caption'] === 'string'
          ? { caption: extra['caption'] }
          : {}),
        hasMarkup: extra?.['reply_markup'] !== undefined,
      });
      return Promise.resolve({ voice: { file_id: 'fid' } });
    },
    replyWithAudio: (file: unknown, extra?: Record<string, unknown>) => {
      if (options?.audioFails === true) throw new Error('audio rejected');
      calls.push({
        method: 'audio',
        body: describeFile(file),
        ...(typeof extra?.['caption'] === 'string'
          ? { caption: extra['caption'] }
          : {}),
        hasMarkup: extra?.['reply_markup'] !== undefined,
      });
      return Promise.resolve({});
    },
  } as unknown as AppContext;
  return { ctx, calls };
}

const deps = (extra?: Partial<KanaHandlerDeps>): KanaHandlerDeps =>
  ({
    audioDir: 'assets/kana-audio',
    ...extra,
  }) as KanaHandlerDeps;

describe('仮名の返事を送る', () => {
  it('puts the text on the audio itself, not in a second bubble', async () => {
    const { ctx, calls } = fakeCtx();
    await send(ctx, [{ text: 'あ(a)', audioKanaId: 'a' }], deps());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('voice');
    expect(calls[0]?.caption).toBe('あ(a)');
  });

  it('keeps the buttons on that same bubble', async () => {
    const { ctx, calls } = fakeCtx();
    await send(
      ctx,
      [
        {
          text: '❌ 正确答案是 キ（ki）',
          audioKanaId: 'ki',
          buttons: [{ label: 'キ', data: 'kq:g:k:ki:ki' }],
        },
      ],
      deps(),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.hasMarkup).toBe(true);
    expect(calls[0]?.caption).toBe('❌ 正确答案是 キ（ki）');
  });

  /**
   * 元は「先に文字、後から音」で音の失敗から本文を守っていた。順序を
   * 逆にしたぶん、ここが抜けると音库の欠けや形式の相性で**講評ごと消える**。
   */
  it('still delivers the text when the audio cannot be sent at all', async () => {
    const { ctx, calls } = fakeCtx({ voiceFails: true, audioFails: true });
    await send(ctx, [{ text: '❌ 正确答案是 キ（ki）', audioKanaId: 'ki' }], deps());

    const texts = calls.filter((c) => c.method === 'text');
    expect(texts).toHaveLength(1);
    expect(texts[0]?.body).toBe('❌ 正确答案是 キ（ki）');
  });

  it('delivers the text when the kana has no audio file', async () => {
    const { ctx, calls } = fakeCtx();
    await send(ctx, [{ text: 'ん(n)', audioKanaId: 'nope' }], deps());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('text');
  });

  // mp3 を sendVoice が蹴ったら sendAudio に落ちる。説明文はそのまま乗せる。
  it('carries the caption over when it falls back to sendAudio', async () => {
    const { ctx, calls } = fakeCtx({ voiceFails: true });
    await send(ctx, [{ text: 'か(ka)', audioKanaId: 'ka' }], deps());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('audio');
    expect(calls[0]?.caption).toBe('か(ka)');
  });

  it('merges the synthesised reading into the vocabulary card', async () => {
    const { ctx, calls } = fakeCtx();
    await send(
      ctx,
      [{ text: '⭕ 学生（がくせい）— 学生', speakText: 'がくせい' }],
      deps({
        speak: () => Promise.resolve({ fileId: 'cached-voice', cached: true }),
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('voice');
    expect(calls[0]?.body).toBe('cached-voice');
    expect(calls[0]?.caption).toBe('⭕ 学生（がくせい）— 学生');
  });

  it('falls back to a plain message when synthesis fails', async () => {
    const { ctx, calls } = fakeCtx();
    await send(
      ctx,
      [{ text: '⭕ 学生（がくせい）', speakText: 'がくせい' }],
      deps({ speak: () => Promise.reject(new Error('tts down')) }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('text');
    expect(calls[0]?.body).toBe('⭕ 学生（がくせい）');
  });

  /**
   * 説明文は 1024 字まで。超える本文は吹き出しに載せられないので、
   * その時だけ元の「文字＋音」の二つ出しに戻る。
   */
  it('splits again when the text is too long to be a caption', async () => {
    const { ctx, calls } = fakeCtx();
    await send(ctx, [{ text: 'あ'.repeat(1025), audioKanaId: 'a' }], deps());

    expect(calls.map((c) => c.method)).toEqual(['text', 'voice']);
    expect(calls[1]?.caption).toBeUndefined();
  });

  it('sends a plain reply when there is no audio at all', async () => {
    const { ctx, calls } = fakeCtx();
    await send(ctx, [{ text: '今天没有到期的复习。' }], deps());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('text');
  });
});
