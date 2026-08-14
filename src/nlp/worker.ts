/**
 * 形態素解析の子プロセス（V2 §8）。
 *
 * **なぜ別プロセスなのか。** kuromoji の辞書は常駐で約 400MB 積む。
 * 本体は 118MB で動いているので、同居させると 4 倍になり、Railway の
 * 月 $5 枠（= 512MB 相当）をほぼ使い切る。参照を捨てて GC を促しても
 * 実測で 402MB → 298MB までしか戻らなかった（V8 が抱えたまま）。
 * 子プロセスなら終了時に全部返る（実測：親は 43MB のまま）。
 *
 * Railway は平均メモリで課金するので、使う数秒だけ膨らむ形なら
 * 費用はほぼ増えない。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface KuromojiToken {
  surface_form: string;
  pos: string;
  pos_detail_1: string;
  conjugated_type: string;
  conjugated_form: string;
  basic_form: string;
  reading?: string;
  pronunciation?: string;
}

interface Tokenizer {
  tokenize(text: string): KuromojiToken[];
}

export interface WorkerRequest {
  readonly id: number;
  readonly text: string;
}

export interface WorkerResponse {
  readonly id: number;
  readonly tokens?: KuromojiToken[];
  readonly error?: string;
}

async function build(): Promise<Tokenizer> {
  const kuromoji = require('@sglkc/kuromoji') as {
    builder(options: { dicPath: string }): {
      build(callback: (error: Error | null, tokenizer: Tokenizer) => void): void;
    };
  };
  // 辞書はパッケージ同梱。パスは package.json から引く——ビルド後の
  // dist から見ても node_modules の位置は変わらない。
  const dicPath = require
    .resolve('@sglkc/kuromoji/package.json')
    .replace('package.json', 'dict');

  return new Promise((resolve, reject) => {
    kuromoji.builder({ dicPath }).build((error, tokenizer) => {
      if (error !== null) reject(error);
      else resolve(tokenizer);
    });
  });
}

const tokenizer = await build();
process.send?.({ id: 0, tokens: [] } satisfies WorkerResponse);

process.on('message', (message: WorkerRequest) => {
  try {
    process.send?.({
      id: message.id,
      tokens: tokenizer.tokenize(message.text),
    } satisfies WorkerResponse);
  } catch (error) {
    process.send?.({
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies WorkerResponse);
  }
});
