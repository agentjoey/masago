/**
 * ブランド画像を Mini App の頁に焼き込む形へ変換する。手動実行。
 *
 *   pnpm build:brand
 *
 * `assets/brand/masa-144.webp` を base64 の data URI にして
 * `src/miniapp/brandAsset.ts` を書き出す。
 *
 * ## なぜ別要求にせず頁に埋めるのか
 *
 * 38px の顔一つのために往復を一回増やすと、**開いた瞬間に空の四角が見える**。
 * 5.6 KB（base64 で 7.5 KB）なら頁と一緒に届いて最初の描画に間に合う。
 * 経路が増えないぶん、`/audio/kana/` で気を付けたような穿越の口も開かない。
 *
 * ## 144px の根拠
 *
 * 表示は 38px（首頁）と 44px（設定シート）。3 倍の画面で 132px なので
 * 144px が最小限の余裕。元画像（1254px）からの切り抜きは**顔の枠**で、
 * ロゴの「MasaGo」の字は入れない——38px では字は汚れにしか見えず、
 * 字はページ側で本物の書体として組む。
 *
 * 切り抜きと縮小そのものは一度きりの手作業（Pillow、box=(110,30,910,830)、
 * LANCZOS、WebP q86）。ここでやるのは符号化だけなので、画像処理の
 * 依存をこの repo に持ち込まない。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const SOURCE = 'assets/brand/masa-144.webp';
const OUT = 'src/miniapp/brandAsset.ts';

const bytes = readFileSync(SOURCE);
const uri = `data:image/webp;base64,${bytes.toString('base64')}`;

// data URI に引用符やバッククォートは現れない（base64 の字母＋前置きだけ）。
// 頁側のテンプレート文字列にも CSS の url() にもそのまま置ける。
if (/["'`\\]/.test(uri)) {
  throw new Error('unexpected character in data URI');
}

writeFileSync(
  OUT,
  `/**
 * 生成物。手で直さない（\`pnpm build:brand\`）。
 *
 * 元: ${SOURCE}（${String(bytes.length)} バイト、WebP 144×144）。
 */
export const MASA_AVATAR = '${uri}';
`,
);

console.log(
  `written ${OUT} (${String(bytes.length)} bytes → ${String(uri.length)} chars)`,
);
