import type { TextToSpeechProvider } from './tts/types.js';

/**
 * 「この文を音にして送る」ための最小の窓口（V2 §5.3）。
 *
 * telegram 層は DB を触れない（INTERFACES.md §1）ので、必要な操作だけを
 * この形で受け取る。実装は app.ts が繋ぐ。
 */
export interface VoiceCachePort {
  /** 送信済みなら Telegram の file_id。 */
  lookup(text: string): Promise<string | undefined>;
  /** 送信して得た file_id を覚える。 */
  remember(text: string, telegramFileId: string): Promise<void>;
}

export interface SpokenAudio {
  /** 既に送ったことがある場合。再合成も再アップロードも要らない。 */
  readonly fileId?: string;
  /** 初めての場合の音声本体。 */
  readonly bytes?: Buffer;
  readonly cached: boolean;
}

export interface SpeakOptions {
  readonly cache: VoiceCachePort;
  readonly tts: TextToSpeechProvider;
  readonly voiceId: string;
}

/**
 * 文を音にする。二度目からは合成せず file_id を返す。
 *
 * 復習は同じ項目を何ヶ月も繰り返すので、当たるほど費用が下がる——しかも
 * 音質は落ちない。保存しているのは合成結果そのものへの参照であって、
 * 音を継ぎ接ぎしているわけではない（§5.2 で仮名を繋がない理由と同じ）。
 */
export async function speak(
  text: string,
  options: SpeakOptions,
): Promise<SpokenAudio> {
  const hit = await options.cache.lookup(text);
  if (hit !== undefined) {
    return { fileId: hit, cached: true };
  }
  const result = await options.tts.synthesize(text, {
    voiceId: options.voiceId,
  });
  const bytes = result.bytes;
  if (bytes === undefined) {
    // path しか返さない実装は今のところ無いが、黙って無音を送るよりは
    // 「音は出せなかった」と分かるほうがよい。
    return { cached: false };
  }
  return { bytes, cached: false };
}
