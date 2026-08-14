/**
 * Mini App の画面（V3）。
 *
 * 単一の HTML を返すだけ。ビルド工程を増やしたくないので依存も無し。
 * ここでしかできないのは **本物の ruby** と **一覧の可視化**——Telegram の
 * メッセージでは括弧で添えるしかなく（§4.2）、五十音を表として見せることも
 * できない。学習者は表の位置で覚えるので、この一枚には意味がある。
 *
 * ## 「原生らしさ」の作り方
 *
 * 独自の配色を発明しない。**Telegram のテーマ変数をそのまま着る**——
 * 地色・カード・強調色が親アプリと揃っていることが、Web ページを
 * アプリに見せる一番の要素。変数が無い環境（ブラウザで直接開いた場合）は
 * iOS のグループ化リストの配色に落ちる。
 *
 * それ以外の原生の語彙：
 * - 下端のタブ栏（毛玻璃 + 安全域 + ハプティクス）
 * - 画面ごとの大見出し（スクロールで流れる）
 * - 詳細は下から出るシート（つまみ付き、背景タップで閉じる）
 * - 押せるものは押した瞬間に沈む（transform、100ms 台）
 * - 読み込みは骨組みで待たせる（文字の「加载中…」を出さない）
 *
 * 動きは prefers-reduced-motion で全部消える。
 *
 * ## bot への「続きから」
 *
 * Mini App から bot のコマンドは直接呼べない（menu button 起動の WebApp に
 * sendData は無い）。`t.me/<bot>?start=<cmd>` の深リンクに逃がし、
 * bot 側の /start が payload を既存コマンドへ振り分ける。
 */
import { MASA_AVATAR } from './brandAsset.js';

export function renderPage(options?: {
  /** @ なしの bot username。無ければ「続きから」はただ閉じる。 */
  botUsername?: string;
  /** 設定画面の「关于」に出す。 */
  version?: string;
}): string {
  const botUsername = options?.botUsername ?? '';
  const version = options?.version ?? '';
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<title>MasaGo</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
/* ── テーマ。Telegram の変数を優先し、無ければ iOS の配色に落ちる ── */
:root {
  --ground-fb: #eff0f4; --card-fb: #ffffff; --fg-fb: #0b0b0d;
  --muted-fb: #85858b; --accent-fb: #2f7df6;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ground-fb: #000000; --card-fb: #1c1c1e; --fg-fb: #f2f2f6;
    --muted-fb: #9a9aa1; --accent-fb: #4592ff;
  }
}
:root {
  --ground: var(--tg-theme-secondary-bg-color, var(--ground-fb));
  --card: var(--tg-theme-section-bg-color, var(--tg-theme-bg-color, var(--card-fb)));
  --fg: var(--tg-theme-text-color, var(--fg-fb));
  --muted: var(--tg-theme-subtitle-text-color, var(--tg-theme-hint-color, var(--muted-fb)));
  --accent: var(--tg-theme-button-color, var(--tg-theme-link-color, var(--accent-fb)));
  --accent-fg: var(--tg-theme-button-text-color, #fff);
  --ok: #2fa45c; --warn: #f0a41f; --bad: #e5484d;
  /* 罫線と面。color-mix が無い環境のために素の値を先に置く */
  --hair: rgba(128,128,128,.26);
  --hair: color-mix(in srgb, var(--fg) 13%, transparent);
  --fill: rgba(128,128,128,.12);
  --fill: color-mix(in srgb, var(--fg) 6%, transparent);
  --fill-2: rgba(128,128,128,.2);
  --fill-2: color-mix(in srgb, var(--fg) 11%, transparent);
  --accent-soft: rgba(60,130,246,.14);
  --accent-soft: color-mix(in srgb, var(--accent) 13%, transparent);
  /* ロゴの葡萄酒色（元画像から採取）。主題変数ではなく銘柄の定数。 */
  --brand: #935152;
  --jp: "Hiragino Sans", "Noto Sans CJK JP", sans-serif;
}

* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  padding: 6px 16px calc(88px + env(safe-area-inset-bottom));
  background: var(--ground); color: var(--fg);
  font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Noto Sans CJK SC", sans-serif;
  -webkit-font-smoothing: antialiased;
  touch-action: manipulation;
}
button { font: inherit; color: inherit; border: 0; background: none; padding: 0; cursor: pointer; }

/* ── 画面の骨格 ── */
.lt {
  font-size: 29px; font-weight: 800; letter-spacing: -.02em;
  margin: 10px 2px 4px;
}

/* ── 首页のブランド行。MasaGo の「顔」はここだけに置く ── */
.brand {
  display: flex; align-items: center; gap: 10px; margin: 10px 2px 4px;
  /* 銘柄の赤は主題から来ない定数。地色に合わせて前景と混ぜ、
     明暗どちらでも読める濃さにする（color-mix が無ければ素の赤）。 */
  --bink: var(--brand);
  --bink: color-mix(in srgb, var(--brand) 70%, var(--fg));
}
.ava {
  display: block; width: 38px; height: 38px; border-radius: 12px; flex: none;
  background-image: url("${MASA_AVATAR}");
  background-size: cover; background-position: 50% 50%;
  background-color: var(--fill);
  box-shadow: 0 1px 4px rgba(0,0,0,.16);
}
/* 顔が地に溶けないよう内側に髪の毛一本の枠。影だけだと明色の地で消える。 */
.ava::after {
  content: ''; display: block; height: 100%; border-radius: inherit;
  box-shadow: inset 0 0 0 .5px var(--hair);
}
.bname {
  /* 「日式英文」＝明朝体のラテン。webfont は外部要求になるので、
     手元にある明朝を順に当てる（iOS/macOS → Windows → Android → 中文明朝）。 */
  font-family: "Hiragino Mincho ProN", "Hiragino Mincho Pro", "Yu Mincho",
    YuMincho, "Noto Serif JP", "Noto Serif CJK JP", "Songti SC", serif;
  font-size: 28px; font-weight: 600; letter-spacing: .012em;
  color: var(--bink);
  position: relative; padding-bottom: 4px;
}
/* ロゴの下線。両端が細る筆の運びを勾配で真似る。 */
.bname::after {
  content: ''; position: absolute; left: 1px; right: 1px; bottom: 0; height: 1px;
  background: linear-gradient(90deg, transparent, var(--bink) 16%, var(--bink) 84%, transparent);
  opacity: .55;
}
.iconbtn {
  margin-left: auto; width: 34px; height: 34px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: var(--fill); color: var(--muted);
  transition: transform .1s, background .15s;
}
.iconbtn:active { transform: scale(.9); background: var(--fill-2); }
.iconbtn svg { width: 20px; height: 20px; }
.lsub { color: var(--muted); font-size: 14px; margin: 0 2px 14px; }
.sec {
  font-size: 13px; font-weight: 600; color: var(--muted);
  margin: 20px 4px 8px;
}
.card {
  background: var(--card); border-radius: 18px; padding: 16px;
  margin-bottom: 12px;
  box-shadow: 0 1px 1px rgba(0,0,0,.04);
}
.row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.muted { color: var(--muted); font-size: 13px; }
.num { font-variant-numeric: tabular-nums; }

/* 画面の切り替え。下からわずかに浮く */
.vwrap { animation: rise .22s cubic-bezier(.2,.7,.3,1); }
@keyframes rise { from { opacity: 0; transform: translateY(7px); } }

/* 骨組み（読み込み中） */
.sk { border-radius: 18px; margin-bottom: 12px;
  background: linear-gradient(100deg, var(--fill) 35%, var(--fill-2) 50%, var(--fill) 65%);
  background-size: 220% 100%; animation: shimmer 1.1s linear infinite; }
@keyframes shimmer { from { background-position: 130% 0; } to { background-position: -90% 0; } }

/* ── 下端のタブ栏 ── */
#tabbar {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 40;
  display: flex; align-items: stretch;
  padding: 6px 10px calc(4px + env(safe-area-inset-bottom));
  background: var(--card);
  border-top: .5px solid var(--hair);
}
@supports (backdrop-filter: blur(2px)) or (-webkit-backdrop-filter: blur(2px)) {
  #tabbar {
    background: color-mix(in srgb, var(--card) 72%, transparent);
    -webkit-backdrop-filter: blur(18px) saturate(1.7);
    backdrop-filter: blur(18px) saturate(1.7);
  }
}
#tabbar button {
  flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px;
  padding: 4px 0 2px; color: var(--muted);
  font-size: 10px; font-weight: 600; letter-spacing: .01em;
  transition: color .15s, transform .1s;
}
#tabbar button:active { transform: scale(.92); }
#tabbar button:focus { outline: none; }
#tabbar button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 12px; }
#tabbar button[aria-selected="true"] { color: var(--accent); }
#tabbar svg { width: 25px; height: 25px; display: block; }
#tabbar .kglyph {
  font-family: var(--jp); font-size: 19px; line-height: 25px; height: 25px;
  font-weight: 600;
}

/* ── 共通の押し物 ── */
.primary {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  width: 100%; padding: 13px 0; border-radius: 14px;
  background: var(--accent); color: var(--accent-fg);
  font-size: 16px; font-weight: 600;
  transition: transform .1s, filter .15s;
}
.primary:active { transform: scale(.98); filter: brightness(.92); }
.ghost {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  width: 100%; padding: 13px 0; border-radius: 14px;
  background: var(--fill); color: var(--fg); font-size: 16px; font-weight: 500;
  transition: transform .1s, background .15s;
}
.ghost:active { transform: scale(.98); background: var(--fill-2); }

/* ── 进度：輪のゲージ ── */
.rings { display: flex; justify-content: space-around; padding: 4px 0 2px; }
.ringb { display: flex; flex-direction: column; align-items: center; gap: 6px; }
.ring { position: relative; width: 78px; height: 78px; }
.ring svg { width: 78px; height: 78px; transform: rotate(-90deg); }
.ring circle { fill: none; stroke-width: 7; }
.ring .tr { stroke: var(--fill-2); }
.ring .vl { stroke: var(--accent); stroke-linecap: round; }
.ring b {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums;
}
.rl { font-size: 13px; font-weight: 600; }
.rs { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
/* 「今天」卡：到期の要約と「続きから」 */
.today-due {
  font-size: 13.5px; color: var(--muted); margin: 6px 0 13px;
  font-variant-numeric: tabular-nums;
}
.today-due b { color: var(--warn); font-weight: 700; }
.quick { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 10px; }
.quick button {
  display: flex; flex-direction: column; align-items: center; gap: 3px;
  padding: 10px 0 8px; border-radius: 12px;
  background: var(--fill); font-size: 12px; font-weight: 500;
  transition: transform .1s, background .15s;
}
.quick button:active { transform: scale(.94); background: var(--fill-2); }
.quick .qg { font-family: var(--jp); font-size: 17px; line-height: 1.2; color: var(--accent); }

/* 直近 7 日の棒 */
.bars { display: flex; gap: 8px; align-items: flex-end; height: 92px; margin-top: 16px; }
.bcol { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; height: 100%; justify-content: flex-end; }
.b { width: 100%; max-width: 26px; border-radius: 6px; background: var(--accent); min-height: 5px; }
.b[data-zero] { background: var(--fill-2); height: 5px !important; }
.bl { font-size: 10px; color: var(--muted); }
.chip {
  font-size: 12px; font-weight: 600; color: var(--accent);
  background: var(--accent-soft); border-radius: 999px; padding: 3px 10px;
}

/* ── 五十音表。タイルを地に直接置く——この表がこの画面の主役 ── */
.grid { display: grid; gap: 6px; }
.cell {
  aspect-ratio: 1; border-radius: 14px; padding: 0; position: relative;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  background: var(--fill); color: var(--muted);
  font-family: var(--jp); font-size: 18px;
  transition: transform .1s;
  overflow: hidden;
}
.cell:active { transform: scale(.9); }
.cell[data-blank="y"] { background: transparent; pointer-events: none; }
.cell[data-known="y"] {
  background: var(--card); color: var(--fg);
  box-shadow: 0 1px 1px rgba(0,0,0,.05);
}
.cell small { font-size: 9px; line-height: 1; opacity: .6; margin-top: 2px; font-family: inherit; }
.cell i {
  position: absolute; left: 8px; bottom: 0; height: 3px;
  border-radius: 2px 2px 0 0; background: var(--accent);
}
.cell[data-due="y"]::after {
  content: ''; position: absolute; top: 6px; right: 6px;
  width: 6px; height: 6px; border-radius: 50%; background: var(--warn);
}
.legend { display: flex; gap: 14px; flex-wrap: wrap; margin: 14px 2px 0; }
.legend span { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 5px; }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }

/* ── 詳細シート。下から出て、つまみが付く ── */
dialog {
  border: 0; width: 100%; max-width: 560px;
  margin: auto auto 0; position: fixed; inset: auto 0 0;
  padding: 8px 20px calc(24px + env(safe-area-inset-bottom));
  background: var(--card); color: var(--fg);
  border-radius: 22px 22px 0 0;
  max-height: 86vh; overflow-y: auto;
}
dialog::backdrop { background: rgba(0,0,0,.45); }
dialog[open] { animation: sheetup .32s cubic-bezier(.32,.72,0,1); }
dialog.closing { animation: sheetdown .18s ease-in forwards; }
@keyframes sheetup { from { transform: translateY(100%); } }
@keyframes sheetdown { to { transform: translateY(100%); } }
.grab { width: 36px; height: 5px; border-radius: 3px; background: var(--fill-2); margin: 4px auto 16px; }
.big { font-size: 58px; line-height: 1.1; text-align: center; font-family: var(--jp); }
.pair { display: flex; justify-content: center; gap: 28px; align-items: baseline; }
.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 16px; text-align: center; }
.stats div { background: var(--fill); border-radius: 12px; padding: 10px 4px; }
.stats b { display: block; font-size: 17px; font-variant-numeric: tabular-nums; }
.stats span { font-size: 11px; color: var(--muted); }
.actions { display: flex; gap: 8px; margin-top: 18px; }
.actions > * { flex: 1; }

/* 設定シート（账号・用量・关于） */
.setacct { display: flex; align-items: center; gap: 12px; padding: 4px 2px 2px; }
.setacct .ava { width: 44px; height: 44px; border-radius: 14px; }
.setacct b { font-size: 16px; }
.setacct .muted { margin-top: 1px; }
.setrow {
  display: flex; justify-content: space-between; align-items: center; gap: 8px;
  padding: 12px 16px; font-size: 14.5px;
}
.setrow + .setrow { border-top: .5px solid var(--hair); }
.setrow b { font-weight: 600; }
/* シートの中では行の入れ物を面色にする（カードの上に白は乗らない） */
dialog .list { background: var(--fill); box-shadow: none; border-radius: 14px; }

/* ── 阅读 ── */
/* 場面はボタン一つ＋シートで選ぶ。横並びの札は場面が増えると溢れる
   ——分野別（商务/高尔夫/AI…）を足す予定があるので、最初から一覧式。 */
.pickrow { display: flex; gap: 8px; padding: 2px 0 10px; }
.selbtn {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 12px; border-radius: 12px;
  background: var(--card); font-size: 13.5px;
  box-shadow: 0 1px 1px rgba(0,0,0,.04);
  transition: transform .1s;
}
.selbtn:active { transform: scale(.96); }
.selbtn b { font-weight: 600; }
.selbtn svg { width: 12px; height: 12px; color: var(--muted); }
.sheett { font-size: 17px; font-weight: 700; text-align: center; margin: 2px 0 14px; }
.pickgrid {
  display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
  max-height: 52vh; overflow-y: auto;
}
.pickgrid button {
  padding: 12px 8px; border-radius: 12px; background: var(--fill);
  font-size: 14px; font-weight: 500; transition: transform .1s;
}
.pickgrid button:active { transform: scale(.96); }
.pickgrid button[aria-selected="true"] { background: var(--accent); color: var(--accent-fg); font-weight: 600; }

.seg {
  display: flex; gap: 2px; background: var(--fill-2); border-radius: 11px;
  padding: 2px; margin-bottom: 12px;
}
.seg button {
  flex: 1; padding: 6px 0; border-radius: 9px; font-size: 13px; font-weight: 500;
  color: var(--muted); transition: background .18s, color .18s, box-shadow .18s;
}
.seg button[aria-selected="true"] {
  background: var(--card); color: var(--fg); font-weight: 600;
  box-shadow: 0 1px 3px rgba(0,0,0,.12);
}

/* 本文の振り仮名。Telegram のメッセージでは出せない、これが Mini App の主目的。 */
ruby { ruby-position: over; }
rt { font-size: .5em; color: var(--muted); }
.sent {
  font-size: 27px; line-height: 2.5; text-align: center; padding: 6px 0 10px;
  font-family: var(--jp); cursor: pointer;
}
.sent:active { opacity: .55; }
.sent ruby { ruby-position: over; }
/* rt の既定は小さすぎて、読みを覚えるための字として読めない。 */
.sent rt { font-size: 12px; color: var(--muted); letter-spacing: .04em; }
.sentmeta { display: flex; justify-content: center; margin-bottom: 8px; }
.speak {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  width: 100%; padding: 12px 0;
  font-size: 15px; font-weight: 600; border-radius: 12px;
  background: var(--accent-soft); color: var(--accent);
  transition: transform .1s, background .15s;
}
.speak:active { transform: scale(.98); }
.speak[data-state="loading"] { color: var(--muted); background: var(--fill); }
.speak[data-state="error"] { color: var(--bad); background: rgba(229,72,77,.12); }

.list { background: var(--card); border-radius: 16px; padding: 0; overflow: hidden;
  box-shadow: 0 1px 1px rgba(0,0,0,.04); }
.choice {
  display: block; width: 100%; text-align: left; padding: 14px 44px 14px 16px;
  position: relative; font-size: 15.5px; line-height: 1.45;
  transition: background .12s;
}
.choice + .choice { border-top: .5px solid var(--hair); }
.choice:active { background: var(--fill); }
.choice[data-state="right"] { color: var(--ok); font-weight: 600; }
.choice[data-state="wrong"] { color: var(--bad); }
.choice[data-state]::after {
  position: absolute; right: 16px; top: 50%; transform: translateY(-50%);
  font-size: 15px; font-weight: 700;
}
.choice[data-state="right"]::after { content: '✓'; }
.choice[data-state="wrong"]::after { content: '✕'; }
.verdict { border-radius: 16px; padding: 14px 16px; margin-top: 12px;
  animation: rise .2s cubic-bezier(.2,.7,.3,1); }
.verdict.ok { background: rgba(47,164,92,.13); }
.verdict.bad { background: rgba(229,72,77,.11); }
.verdict .vt { font-size: 15px; font-weight: 600; margin-bottom: 12px; }
.verdict.ok .vt { color: var(--ok); }
.verdict.bad .vt { color: var(--bad); }

/* ── 错题本 ── */
.ejp { font-size: 16.5px; line-height: 1.9; font-family: var(--jp); }
.ejp del { color: var(--muted); text-decoration-color: var(--bad); }
.ejp ins { text-decoration: none; font-weight: 600; }
.ejp .arr { color: var(--muted); margin: 0 6px; }
.emeta { display: flex; align-items: center; gap: 8px; margin-top: 8px;
  font-size: 12px; color: var(--muted); }
.pill { font-size: 11px; font-weight: 600; background: var(--fill);
  border-radius: 999px; padding: 2px 8px; }

/* ── 日历 ── */
.cal7 { display: grid; grid-template-columns: repeat(7, 1fr); gap: 5px; margin-top: 12px; }
.wd { text-align: center; font-size: 11px; color: var(--muted); padding-bottom: 2px; }
.cd {
  aspect-ratio: 1; border-radius: 11px; background: var(--fill);
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px;
}
.cd .dn { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.cd .db { font-size: 13px; font-weight: 700; color: var(--accent); font-variant-numeric: tabular-nums; }
.cd[data-due="y"] { background: var(--accent-soft); }
.cd[data-due="y"] .dn { color: var(--accent); opacity: .7; }
.cd[data-today="y"] { box-shadow: inset 0 0 0 1.5px var(--accent); }

.empty { color: var(--muted); text-align: center; padding: 48px 12px; line-height: 1.8; }
.empty .eg { display: block; font-size: 34px; margin-bottom: 8px; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
</style>
</head>
<body>
<main id="view"></main>
<nav id="tabbar" aria-label="主导航">
  <button data-tab="progress" aria-selected="true">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 3a9 9 0 1 1-8.5 6"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/></svg>
    <span>进度</span>
  </button>
  <button data-tab="kana" aria-selected="false">
    <span class="kglyph">あ</span>
    <span>五十音</span>
  </button>
  <button data-tab="reading" aria-selected="false">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M3.5 6.1c2.7-1.3 5.7-1.2 8.5.5 2.8-1.7 5.8-1.8 8.5-.5v11.8c-2.7-1.3-5.7-1.2-8.5.5-2.8-1.7-5.8-1.8-8.5-.5z"/><path d="M12 6.6v11.8"/></svg>
    <span>阅读</span>
  </button>
  <button data-tab="errors" aria-selected="false">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3.5h10a1 1 0 0 1 1 1V20l-6-4.3L6 20V4.5a1 1 0 0 1 1-1z"/><path d="M10 8l4 4M14 8l-4 4"/></svg>
    <span>错题</span>
  </button>
  <button data-tab="calendar" aria-selected="false">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="15" rx="3.5"/><path d="M3.5 9.6h17M8 3v3.4M16 3v3.4"/><circle cx="12" cy="14.8" r="1.7" fill="currentColor" stroke="none"/></svg>
    <span>日历</span>
  </button>
</nav>
<dialog id="sheet"></dialog>
<script>
const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();
// 親アプリの外装（ヘッダ・地色）もページに合わせる。ここが揃わないと
// 「Telegram の中に別サイトが開いた」見た目になる。古い版には無い
// メソッドなので、一つずつ黙って諦める。
try { tg?.setHeaderColor?.('secondary_bg_color'); } catch {}
try { tg?.setBackgroundColor?.('secondary_bg_color'); } catch {}
try { tg?.disableVerticalSwipes?.(); } catch {}

const hap = {
  tap: () => { try { tg?.HapticFeedback?.selectionChanged?.(); } catch {} },
  imp: () => { try { tg?.HapticFeedback?.impactOccurred?.('light'); } catch {} },
  ok: () => { try { tg?.HapticFeedback?.notificationOccurred?.('success'); } catch {} },
  bad: () => { try { tg?.HapticFeedback?.notificationOccurred?.('error'); } catch {} },
};

const view = document.getElementById('view');
const sheet = document.getElementById('sheet');
const initData = tg?.initData ?? '';
// 起動時にサーバ側で焼き込む。BOT が空なら「続きから」はただ閉じる。
const BOT = ${JSON.stringify(botUsername)};
const APPVER = ${JSON.stringify(version)};

/* bot 側のコマンドへ。深リンクを開くと Telegram が Mini App を閉じ、
   bot の対話に着地する——Mini App は「見る」、練習は対話で（§4）。 */
function goBot(cmd) {
  hap.imp();
  if (BOT !== '' && tg?.openTelegramLink) {
    tg.openTelegramLink('https://t.me/' + BOT + '?start=' + encodeURIComponent(cmd));
  }
  try { tg?.close?.(); } catch {}
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, extra) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ initData, ...extra }),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
const TITLES = { progress: '进度', kana: '五十音', reading: '阅读', errors: '错题本', calendar: '日历' };

/* ---------- 进度 ---------- */
const RING_C = 201.1; /* 2πr, r=32 */
function ring(label, sub, p) {
  const dash = Math.max(0, Math.min(1, p)) * RING_C;
  // 0% は値の円弧を描かない。round cap は長さ 0 でも点を打ってしまい、
  // 「少しは進んでいる」ように見える。
  const arc = dash < 0.5 ? '' :
    '<circle class="vl" cx="39" cy="39" r="32" stroke-dasharray="' + dash.toFixed(1) + ' ' + RING_C + '"></circle>';
  return '<div class="ringb"><div class="ring">' +
    '<svg viewBox="0 0 78 78">' +
    '<circle class="tr" cx="39" cy="39" r="32"></circle>' + arc +
    '</svg><b class="num">' + Math.round(p * 100) + '%</b></div>' +
    '<div class="rl">' + esc(label) + '</div>' +
    '<div class="rs num">' + esc(sub) + '</div></div>';
}

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];
function weekdayOf(day) {
  const d = new Date(day + 'T12:00:00Z');
  return WEEKDAY[d.getUTCDay()] ?? '';
}

function progressView(d) {
  const dueTotal = d.kana.due + d.vocab.due + d.grammar.due;
  const dueLine = dueTotal === 0
    ? '今天没有到期的复习 ✓'
    : '待复习 <b>' + dueTotal + '</b> 项　·　假名 ' + d.kana.due + ' · 单词 ' + d.vocab.due + ' · 助词 ' + d.grammar.due;

  // 「続きから」の行き先：到期があれば复习、なければ主線の次の一歩。
  const goTarget = dueTotal > 0 ? 'review'
    : (d.kana.introduced < d.kana.total ? 'kana' : 'vocab');
  const goLabel = dueTotal > 0 ? '继续复习 ' + dueTotal + ' 项'
    : (d.kana.introduced < d.kana.total ? '继续学：五十音' : '继续学：' + esc(d.vocab.level) + ' 单词');
  const quick = [
    ['kana', 'あ', '假名'], ['vocab', '語', '单词'],
    ['write', '文', '写作'], ['domain', '専', '领域'],
  ].map(([cmd, glyph, label]) =>
    '<button data-go="' + cmd + '"><span class="qg">' + glyph + '</span>' + label + '</button>').join('');

  const max = Math.max(1, ...d.activity.map((x) => x.count));
  const bars = d.activity.map((x) => {
    const h = Math.round((x.count / max) * 100);
    return '<div class="bcol">' +
      (x.count === 0
        ? '<div class="b" data-zero style="height:5px"></div>'
        : '<div class="b" style="height:' + Math.max(h, 8) + '%"></div>') +
      '<span class="bl">' + weekdayOf(x.day) + '</span></div>';
  }).join('');
  const total7 = d.activity.reduce((s, x) => s + x.count, 0);

  return '<div class="brand">' +
    '<span class="ava" aria-hidden="true"></span><span class="bname">MasaGo</span>' +
    '<button class="iconbtn" id="gear" aria-label="账号与设置">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="10" r="3.2"/><path d="M5.8 18.6c1.3-2.3 3.5-3.6 6.2-3.6s4.9 1.3 6.2 3.6"/></svg>' +
    '</button></div>' +
    '<div class="lsub">Masa 陪你：五十音 → N5 → N4。</div>' +
    '<div class="card">' +
    '<div class="row"><b>今天</b>' +
    (d.streak > 1 ? '<span class="chip">连续 ' + d.streak + ' 天 🔥</span>' : '') +
    '</div>' +
    '<div class="today-due">' + dueLine + '</div>' +
    '<button class="primary" data-go="' + goTarget + '">' + goLabel + '</button>' +
    '<div class="quick">' + quick + '</div>' +
    '</div>' +
    '<div class="card">' +
    '<div class="rings">' +
    ring('五十音', d.kana.introduced + '/' + d.kana.total, d.kana.total ? d.kana.introduced / d.kana.total : 0) +
    ring(esc(d.vocab.level) + ' 单词', d.vocab.levelIntroduced + '/' + d.vocab.levelTotal, d.vocab.levelTotal ? d.vocab.levelIntroduced / d.vocab.levelTotal : 0) +
    ring('助词', d.grammar.introduced + '/' + d.grammar.total, d.grammar.total ? d.grammar.introduced / d.grammar.total : 0) +
    '</div>' +
    '</div>' +
    '<div class="card">' +
    '<div class="row"><b>最近 7 天</b><span class="muted num">共 ' + total7 + ' 题</span></div>' +
    '<div class="bars">' + bars + '</div>' +
    '</div>' +
    '<div class="muted num" style="text-align:center">单词合计 ' + d.vocab.introduced + '/' + d.vocab.total + '　待复习合计 ' + dueTotal + '</div>';
}

/* ---------- 五十音表 ---------- */
let kanaIndex = {};
function kanaView(sections) {
  kanaIndex = {};
  let html = '<div class="lt">五十音</div>' +
    '<div class="lsub">点一个字听发音、看熟练度。</div>';
  for (const sec of sections) {
    html += '<div class="sec">' + esc(sec.title) + '</div>';
    html += '<div class="grid" style="grid-template-columns:repeat(' + sec.columns.length + ',1fr)">';
    for (const row of sec.rows) {
      for (const cell of row.cells) {
        if (cell === null) { html += '<div class="cell" data-blank="y"></div>'; continue; }
        kanaIndex[cell.id] = cell;
        const known = cell.state !== null;
        // 定着度は下線の長さで見せる。色を増やすより一目で分かる。
        const strength = known ? Math.round(cell.state.strength * 100) : 0;
        html += '<button class="cell" data-id="' + esc(cell.id) + '"' +
          ' data-known="' + (known ? 'y' : 'n') + '"' +
          ' data-due="' + (known && cell.state.due ? 'y' : 'n') + '">' +
          esc(cell.hiragana) + '<small>' + esc(cell.romaji) + '</small>' +
          (known ? '<i style="width:calc(' + Math.max(strength, 8) + '% - 16px)"></i>' : '') +
          '</button>';
      }
    }
    html += '</div>';
  }
  html += '<div class="legend">' +
    '<span><i class="dot" style="background:var(--accent)"></i>下线越长＝记得越牢</span>' +
    '<span><i class="dot" style="background:var(--warn)"></i>待复习</span>' +
    '<span style="opacity:.6">暗色＝还没学到</span>' +
    '</div>';
  return html;
}

function closeSheet() {
  if (!sheet.open) return;
  sheet.classList.add('closing');
  sheet.addEventListener('animationend', () => {
    sheet.classList.remove('closing');
    sheet.close();
  }, { once: true });
}

function openKana(id) {
  const cell = kanaIndex[id];
  if (cell === undefined) return;
  hap.imp();
  const s = cell.state;
  const due = s ? new Date(s.dueAt) : null;
  sheet.innerHTML = '<div class="grab"></div>' +
    '<div class="pair"><div class="big">' + esc(cell.hiragana) + '</div><div class="big">' + esc(cell.katakana) + '</div></div>' +
    '<div class="muted" style="text-align:center;font-size:15px;margin-top:4px">' + esc(cell.romaji) + '</div>' +
    (s
      ? '<div class="stats">' +
        '<div><b>' + s.reps + '</b><span>练习次数</span></div>' +
        '<div><b>' + s.lapses + '</b><span>答错次数</span></div>' +
        '<div><b>' + Math.round(s.strength * 100) + '%</b><span>记忆强度</span></div>' +
        '</div>' +
        '<div class="muted" style="text-align:center;margin-top:12px">' +
        (s.due ? '现在待复习' : '下次复习：' + due.toLocaleDateString()) + '</div>'
      : '<div class="muted" style="text-align:center;margin-top:16px">这个假名还没学到。</div>') +
    '<div class="actions">' +
    '<button class="primary" id="play">🔊 发音</button>' +
    (s ? '<button class="ghost" id="again">安排复习</button>' : '') +
    '<button class="ghost" id="close">关闭</button>' +
    '</div>';
  sheet.showModal();

  const audio = new Audio('/audio/kana/' + encodeURIComponent(cell.id) + '.mp3');
  sheet.querySelector('#play').addEventListener('click', () => {
    audio.currentTime = 0;
    audio.play().catch(() => {});
  });
  sheet.querySelector('#close').addEventListener('click', closeSheet);
  const again = sheet.querySelector('#again');
  again?.addEventListener('click', async () => {
    again.disabled = true;
    again.textContent = '已安排 ✓';
    try {
      await api('/api/practice', { key: s.key });
      hap.ok();
      // 表の点灯を実際の状態に合わせ直す。押しただけで見た目が変わらないと
      // 効いたのか分からない。
      await show('kana');
    } catch { again.textContent = '失败'; }
  });
  // 開いた瞬間に一度鳴らす。発音を聞くのがこの画面の主目的。
  audio.play().catch(() => {});
}

/* ---------- 错题本 ---------- */
function errorsView(rows) {
  let html = '<div class="lt">错题本</div>' +
    '<div class="lsub">跟 bot 用日语聊天时记下的。</div>';
  if (rows.length === 0) {
    return html + '<div class="empty"><span class="eg">🌱</span>还没有记录到错误。<br>跟 bot 用日语聊几句试试。</div>';
  }
  return html + rows.map((e) =>
    '<div class="card">' +
    '<div class="ejp"><del>' + esc(e.original) + '</del><span class="arr">→</span><ins>' + esc(e.recommended) + '</ins></div>' +
    (e.reason ? '<div class="muted" style="margin-top:6px">' + esc(e.reason) + '</div>' : '') +
    '<div class="emeta"><span class="pill">' + esc(e.source) + '</span><span>' + esc(e.knowledgeKey) + '</span><span style="margin-left:auto">' + esc(e.at.slice(0, 10)) + '</span></div>' +
    '</div>').join('');
}

/* ---------- 日历 ---------- */
function calendarView(days) {
  const total = days.reduce((s, d) => s + d.due, 0);
  let html = '<div class="lt">日历</div>' +
    '<div class="lsub">未来 4 周的复习安排，共 ' + total + ' 项。</div>' +
    '<div class="card"><div class="cal7">';
  for (const w of ['一', '二', '三', '四', '五', '六', '日']) {
    html += '<div class="wd">' + w + '</div>';
  }
  // 曜日を揃える。先頭は今日なので、月曜起点の位置まで空けて置く。
  const first = days[0];
  if (first !== undefined) {
    const dow = new Date(first.day + 'T12:00:00Z').getUTCDay();
    const pad = (dow + 6) % 7;
    for (let i = 0; i < pad; i += 1) html += '<div></div>';
  }
  days.forEach((d, index) => {
    const dn = parseInt(d.day.slice(8), 10);
    html += '<div class="cd" data-due="' + (d.due > 0 ? 'y' : 'n') + '"' +
      (index === 0 ? ' data-today="y"' : '') + '>' +
      '<span class="dn">' + dn + '</span>' +
      (d.due > 0 ? '<span class="db">' + d.due + '</span>' : '') +
      '</div>';
  });
  html += '</div><div class="muted" style="margin-top:10px">数字是当天到期的项目数。到期不做会顺延，不会消失。</div></div>';
  return html;
}

/* ---------- 阅读 ---------- */
let rubyLevel = 'ALL';
let sceneId = '';
let reading = null;
let sceneList = [];

function rubyHtml(segments) {
  return segments.map((s) => s.ruby === null
    ? esc(s.text)
    : '<ruby>' + esc(s.text) + '<rt>' + esc(s.ruby) + '</rt></ruby>').join('');
}

function readingView(d) {
  let html = '<div class="lt">阅读</div>';
  if (d === null) {
    return html + '<div class="empty"><span class="eg">📖</span>还没有可读的句子。<br>先发 /vocab 学一些单词。</div>';
  }
  reading = d;
  // 場面はボタン＋シートで選ぶ。分野別場面を足しても一覧が破綻しない。
  sceneList = [{ id: '', name: '全部' }].concat(d.scenes);
  const current = sceneList.find((sc) => sc.id === (d.sceneId || '')) ?? sceneList[0];
  const levels = [['ALL', '全部注音'], ['UNKNOWN', '只标生词'], ['NONE', '不注音']]
    .map(([v, label]) => '<button data-level="' + v + '" aria-selected="' +
      (v === d.level) + '">' + label + '</button>').join('');
  const choices = d.options.map((o) =>
    '<button class="choice" data-id="' + esc(o.id) + '">' + esc(o.label) + '</button>').join('');
  return html +
    '<div class="pickrow"><button class="selbtn" id="scenepick">' +
    '<span class="muted">场景</span><b>' + esc(current.name) + '</b>' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>' +
    '</button></div>' +
    '<div class="seg">' + levels + '</div>' +
    '<div class="card">' +
    '<div class="sent" data-speak="' + esc(d.sentenceId) + '">' + rubyHtml(d.segments) + '</div>' +
    (d.unknown > 0 ? '<div class="sentmeta"><span class="chip">含 ' + d.unknown + ' 个生词</span></div>' : '') +
    '<button class="speak" data-speak="' + esc(d.sentenceId) + '">🔊 朗读</button>' +
    '</div>' +
    '<div class="sec">这句话是什么意思？</div>' +
    '<div class="list">' + choices + '</div>' +
    '<div id="verdict"></div>';
}

function openScenePicker() {
  hap.imp();
  sheet.innerHTML = '<div class="grab"></div>' +
    '<div class="sheett">选择场景</div>' +
    '<div class="pickgrid">' +
    sceneList.map((sc) => '<button data-pick-scene="' + esc(sc.id) + '" aria-selected="' +
      (sc.id === sceneId) + '">' + esc(sc.name) + '</button>').join('') +
    '</div>';
  sheet.showModal();
}

/* ---------- 設定（账号・用量・关于） ---------- */
function openSettings() {
  hap.imp();
  const u = tg?.initDataUnsafe?.user;
  const name = u ? [u.first_name, u.last_name].filter(Boolean).join(' ') : '未连接 Telegram';
  const srow = (k, v) =>
    '<div class="setrow"><span>' + k + '</span><b class="num">' + v + '</b></div>';
  sheet.innerHTML = '<div class="grab"></div>' +
    '<div class="setacct"><span class="ava" aria-hidden="true"></span><div>' +
    '<b>' + esc(name) + '</b>' +
    '<div class="muted">' + (u ? 'Telegram ID ' + esc(String(u.id)) : 'MasaGo 学习助手') + '</div>' +
    '</div></div>' +
    '<div class="sec">用量与成本</div>' +
    '<div class="list" id="costbox"><div class="setrow"><span class="muted">读取中…</span></div></div>' +
    '<div class="sec">关于</div>' +
    '<div class="list">' +
    srow('版本', esc(APPVER === '' ? '—' : APPVER)) +
    '<div class="setrow"><span>词库来源</span><span class="muted">JMdict · Tatoeba · 五十音</span></div>' +
    '</div>' +
    '<div class="actions"><button class="ghost" id="close">关闭</button></div>';
  sheet.showModal();
  sheet.querySelector('#close').addEventListener('click', closeSheet);

  // 費用は /cost と同じ集計を API 越しに読む。ここで別に数えない。
  api('/api/cost').then((c) => {
    const box = sheet.querySelector('#costbox');
    if (box === null || c === null) return;
    const fmt = (v) => '$' + (v >= 1 ? v.toFixed(2) : v.toFixed(4));
    box.innerHTML =
      srow('今日', fmt(c.todayUsd) + (c.dailyLimitUsd ? ' <span class="muted">/ ' + fmt(c.dailyLimitUsd) + '</span>' : '')) +
      srow('本周', fmt(c.weekUsd)) +
      srow('本月', fmt(c.monthUsd) + (c.monthlyLimitUsd ? ' <span class="muted">/ ' + fmt(c.monthlyLimitUsd) + '</span>' : '')) +
      (c.unknownCostCalls > 0 ? srow('未计价调用', String(c.unknownCostCalls)) : '');
  }).catch(() => {
    const box = sheet.querySelector('#costbox');
    if (box !== null) box.innerHTML = '<div class="setrow"><span class="muted">读取失败</span></div>';
  });
}

/* 朗读。二度目以降はブラウザのキャッシュから出るので、待ちは初回だけ。 */
let playing = null;
function speakSentence(id) {
  const button = view.querySelector('.speak[data-speak="' + CSS.escape(id) + '"]');
  if (playing !== null) { playing.pause(); playing = null; }
  if (button !== null) { button.dataset.state = 'loading'; button.textContent = '🔊 加载中…'; }

  const audio = new Audio('/audio/sentence/' + encodeURIComponent(id) + '.mp3');
  playing = audio;
  const done = (state, label) => {
    if (button === null) return;
    button.dataset.state = state;
    button.textContent = label;
  };
  audio.addEventListener('playing', () => { done('playing', '🔊 朗读中'); });
  audio.addEventListener('ended', () => { done('', '🔊 朗读'); playing = null; });
  audio.addEventListener('error', () => {
    // 音が出せなくても読む練習は続く。文字は画面にある。
    done('error', '🔇 暂时无法朗读');
    playing = null;
  });
  audio.play().catch(() => { done('error', '🔇 暂时无法朗读'); });
}

async function answerReading(chosenId) {
  if (reading === null) return;
  const buttons = [...view.querySelectorAll('.choice')];
  for (const b of buttons) b.disabled = true;
  let v;
  try {
    v = await api('/api/reading/answer', { target: reading.sentenceId, chosen: chosenId });
  } catch (err) {
    document.getElementById('verdict').innerHTML =
      '<div class="verdict bad"><div class="vt">判分失败：' + esc(err.message || err) + '</div>' +
      '<button class="primary" data-retry="reading">重试</button></div>';
    return;
  }
  if (v === null) return;
  if (v.correct) hap.ok(); else hap.bad();
  for (const b of buttons) {
    if (b.dataset.id === chosenId) b.dataset.state = v.correct ? 'right' : 'wrong';
    // 間違えたときは正解も示す。どれが正しかったか分からないまま次へ行かせない。
    else if (!v.correct && b.textContent === v.answer) b.dataset.state = 'right';
  }
  const verdict = document.getElementById('verdict');
  verdict.innerHTML =
    '<div class="verdict ' + (v.correct ? 'ok' : 'bad') + '">' +
    '<div class="vt">' + (v.correct ? '✓ 答对了' : '✕ 正确答案：' + esc(v.answer)) + '</div>' +
    '<button class="primary" id="next">下一句</button></div>';
  document.getElementById('next').addEventListener('click', () => show('reading'));
  verdict.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* ---------- 骨組みと切り替え ---------- */
function skeleton(tab) {
  if (tab === 'kana') {
    return '<div class="sk" style="height:29px;width:40%;margin:10px 0 18px"></div>' +
      '<div class="sk" style="height:280px"></div><div class="sk" style="height:180px"></div>';
  }
  return '<div class="sk" style="height:29px;width:40%;margin:10px 0 18px"></div>' +
    '<div class="sk" style="height:170px"></div><div class="sk" style="height:130px"></div>';
}

const tabs = {
  progress: ['/api/progress', progressView],
  kana: ['/api/kana', kanaView],
  reading: ['/api/reading', readingView],
  errors: ['/api/errors', errorsView],
  calendar: ['/api/calendar', calendarView],
};

async function show(tab) {
  for (const b of document.querySelectorAll('#tabbar button'))
    b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  window.scrollTo(0, 0);
  view.innerHTML = skeleton(tab);
  try {
    const [path, render] = tabs[tab];
    const data = await api(path, tab === 'reading' ? { level: rubyLevel, scene: sceneId } : undefined);
    view.innerHTML = '<div class="vwrap">' + render(data) + '</div>';
  } catch (err) {
    view.innerHTML = '<div class="vwrap"><div class="lt">' + (TITLES[tab] ?? '') + '</div>' +
      '<div class="card"><div class="muted" style="margin-bottom:12px">读取失败：' + esc(err.message || err) + '</div>' +
      '<button class="primary" data-retry="' + tab + '">重试</button></div></div>';
  }
}

view.addEventListener('click', (e) => {
  const retry = e.target.closest('[data-retry]');
  if (retry !== null) { show(retry.dataset.retry); return; }
  const go = e.target.closest('[data-go]');
  if (go !== null) { goBot(go.dataset.go); return; }
  const gear = e.target.closest('#gear');
  if (gear !== null) { openSettings(); return; }
  const cell = e.target.closest('.cell[data-id]');
  if (cell !== null) { openKana(cell.dataset.id); return; }
  const level = e.target.closest('.seg button[data-level]');
  if (level !== null) { hap.tap(); rubyLevel = level.dataset.level; show('reading'); return; }
  const pick = e.target.closest('#scenepick');
  if (pick !== null) { openScenePicker(); return; }
  const speak = e.target.closest('[data-speak]');
  if (speak !== null) { speakSentence(speak.dataset.speak); return; }
  const choice = e.target.closest('.choice[data-id]');
  if (choice !== null && !choice.disabled) answerReading(choice.dataset.id);
});
sheet.addEventListener('click', (e) => {
  const pick = e.target.closest('[data-pick-scene]');
  if (pick !== null) {
    hap.tap();
    sceneId = pick.dataset.pickScene;
    closeSheet();
    show('reading');
    return;
  }
  if (e.target === sheet) closeSheet();
});
sheet.addEventListener('cancel', (e) => { e.preventDefault(); closeSheet(); });
for (const b of document.querySelectorAll('#tabbar button'))
  b.addEventListener('click', () => { hap.tap(); show(b.dataset.tab); });
show('progress');
</script>
</body>
</html>`;
}
