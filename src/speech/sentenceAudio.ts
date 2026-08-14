import type { AudioResult, TextToSpeechProvider } from './tts/types.js';

/**
 * 例文の読み上げ（Mini App の阅读タブ）。
 *
 * Telegram のメッセージには `file_id` の仕組みがあるが（§5.3）、あれは
 * **Telegram の中でしか使えない**。Mini App は普通の Web ページなので、
 * 音声の実体を HTTP で返す必要がある。
 *
 * ## 二段で当てる
 *
 * 1. **ブラウザのキャッシュ**。URL は文 id で決まり中身は変わらないので、
 *    `immutable` を付けて一年持たせる。二度目以降はサーバに来ない
 *    ——仮名の音声が既にやっているのと同じ手（`/audio/kana/*`）
 * 2. **プロセス内の LRU**。1 で外れた分だけ合成する
 *
 * DB には置かない。実測で一文 36.8 KB なので、全 3,500 文を貯めると
 * 126 MB——Neon の無料枠 0.5 GB の四分の一を音声で埋めることになる。
 * しかも読むたびに DB を起こすことになり §9.1 に反する。
 *
 * 再起動で消えるが、消えて困るものでもない：一度の合成は 1.3〜2.4 秒で、
 * 費用は MiniMax の枠に含まれている。
 */

export interface SentenceAudioOptions {
  readonly tts: TextToSpeechProvider;
  readonly voiceId: string;
  /** 保持する件数。既定 150（実測 36.8 KB/件 なので約 5.5 MB）。 */
  readonly maxEntries?: number;
  /**
   * 合成が走ったときの通知。呼び出し側が usage_records に落とす。
   * キャッシュ命中では呼ばれない——合成していないので費用も無い。
   */
  readonly onSynthesized?: (result: AudioResult) => void;
}

export interface SentenceAudioCache {
  /** 合成済みの mp3。無ければ合成して覚える。 */
  get(id: string, text: string): Promise<Buffer | undefined>;
  readonly size: number;
}

export function createSentenceAudioCache(
  options: SentenceAudioOptions,
): SentenceAudioCache {
  const max = options.maxEntries ?? 150;
  // Map は挿入順を保つので、delete して set し直せば末尾へ動く＝LRU になる。
  const entries = new Map<string, Buffer>();
  // 同じ文への同時要求で二度合成しない。押し込み連打で費用が倍になる。
  const inFlight = new Map<string, Promise<Buffer | undefined>>();

  async function synthesize(
    id: string,
    text: string,
  ): Promise<Buffer | undefined> {
    const result = await options.tts.synthesize(text, {
      voiceId: options.voiceId,
    });
    const bytes = result.bytes;
    if (bytes === undefined) return undefined;
    options.onSynthesized?.(result);
    entries.set(id, bytes);
    // 古いほうから落とす。
    while (entries.size > max) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    return bytes;
  }

  return {
    async get(id, text) {
      const hit = entries.get(id);
      if (hit !== undefined) {
        // 使ったものを末尾へ動かす。
        entries.delete(id);
        entries.set(id, hit);
        return hit;
      }
      const pending = inFlight.get(id);
      if (pending !== undefined) return pending;

      const task = synthesize(id, text).finally(() => {
        inFlight.delete(id);
      });
      inFlight.set(id, task);
      return task;
    },
    get size() {
      return entries.size;
    },
  };
}
