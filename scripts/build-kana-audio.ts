/**
 * 仮名音声ライブラリの生成（V2 §5.2）。手動実行、CI では走らせない。
 *
 *   pnpm build:kana-audio
 *
 * 一般に仮名を繋いで文を合成するのは誤り——日本語は高低アクセント言語で、
 * 母音の無声化・ん の同化・長音・促音があり、繋ぐと韻律を体系的に教え間違える。
 * だが S0 が教えるのは孤立した単音であり、そもそも文脈も高低の曲線も無い。
 * 一度合成すれば永久に使い回せ、S0 の TTS 費用はゼロになる。
 *
 * 冪等：既にあるファイルは飛ばす。途中で失敗しても再実行で続きから進む。
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KANA } from '../src/curriculum/kana.js';
import { config } from '../src/config/index.js';

const OUT_DIR = join(process.cwd(), 'assets', 'kana-audio');
const ENDPOINT = 'https://api.minimax.io/v1/t2a_v2';

interface T2aResponse {
  data?: { audio?: string; status?: number };
  extra_info?: { usage_characters?: number; audio_length?: number };
  base_resp?: { status_code?: number; status_msg?: string };
  trace_id?: string;
}

async function synthesize(text: string): Promise<Buffer> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.tts.minimaxApiKey}`,
    },
    body: JSON.stringify({
      model: config.tts.modelTeaching,
      text,
      stream: false,
      language_boost: 'Japanese',
      voice_setting: {
        voice_id: config.tts.minimaxVoiceId,
        speed: 1,
        vol: 1,
        pitch: 0,
      },
      audio_setting: {
        format: 'mp3',
        sample_rate: 32000,
        bitrate: 128000,
        channel: 1,
      },
    }),
    signal: AbortSignal.timeout(60_000),
  });

  const json = (await res.json()) as T2aResponse;
  // HTTP 200 でも失敗している場合がある。status_code を見ないと
  // 空の音声を掴んだまま先へ進んでしまう（W7 で記録済み）。
  if (json.base_resp?.status_code !== 0) {
    throw new Error(
      `t2a failed: status_code=${String(json.base_resp?.status_code)} msg=${String(json.base_resp?.status_msg)} trace=${String(json.trace_id)}`,
    );
  }
  const hex = json.data?.audio;
  if (hex === undefined || hex.length === 0) {
    throw new Error('t2a returned no audio');
  }
  // 音声は hex エンコード。base64 として復号すると無言のまま壊れる。
  return Buffer.from(hex, 'hex');
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  console.log(
    `仮名音声を生成します: ${String(KANA.length)} 音 / voice=${config.tts.minimaxVoiceId} / model=${config.tts.modelTeaching}`,
  );

  let created = 0;
  let skipped = 0;
  const failures: string[] = [];
  const manifest: Record<string, { bytes: number; sha256: string }> = {};

  for (const kana of KANA) {
    const path = join(OUT_DIR, `${kana.id}.mp3`);
    if (existsSync(path)) {
      skipped += 1;
      continue;
    }
    try {
      // 平仮名で合成する。同じ音なので片仮名と分ける必要はない。
      const audio = await synthesize(kana.hiragana);
      await writeFile(path, audio);
      manifest[kana.id] = {
        bytes: audio.byteLength,
        sha256: createHash('sha256').update(audio).digest('hex').slice(0, 16),
      };
      created += 1;
      if (created % 20 === 0) {
        console.log(`  ${String(created)} 音 生成済み…`);
      }
    } catch (error) {
      failures.push(`${kana.id}(${kana.hiragana}): ${String(error)}`);
    }
  }

  console.log(
    `\n生成 ${String(created)} / 既存 ${String(skipped)} / 失敗 ${String(failures.length)}`,
  );
  for (const failure of failures) {
    console.log(`  ✗ ${failure}`);
  }
  if (failures.length > 0) {
    console.log('\n再実行すれば失敗分だけ生成されます。');
    process.exitCode = 1;
  }
}

await main();
