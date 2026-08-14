/**
 * Mini App の画面（V3）。
 *
 * 単一の HTML を返すだけ。ビルド工程を増やしたくないので、依存も無し。
 * ここでしかできないのは **本物の ruby**——Telegram のメッセージでは
 * 「見(み)ました」と括弧で添えるしかなかった（§4.2）。
 */
export function renderPage(): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>MasaGo</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root {
  --bg: var(--tg-theme-bg-color, #fff);
  --fg: var(--tg-theme-text-color, #111);
  --muted: var(--tg-theme-hint-color, #888);
  --card: var(--tg-theme-secondary-bg-color, #f4f4f5);
  --accent: var(--tg-theme-link-color, #2f81f7);
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 16px 16px 32px;
  background: var(--bg); color: var(--fg);
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Noto Sans CJK SC", sans-serif;
}
h1 { font-size: 18px; margin: 0 0 16px; }
nav { display: flex; gap: 8px; margin-bottom: 16px; }
nav button {
  flex: 1; padding: 8px; border: 0; border-radius: 8px;
  background: var(--card); color: var(--fg); font-size: 14px; cursor: pointer;
}
nav button[aria-selected="true"] { background: var(--accent); color: #fff; }
.card { background: var(--card); border-radius: 12px; padding: 14px; margin-bottom: 12px; }
.row { display: flex; justify-content: space-between; align-items: baseline; }
.muted { color: var(--muted); font-size: 13px; }
.bar { height: 8px; border-radius: 4px; background: rgba(127,127,127,.25); overflow: hidden; margin: 8px 0 4px; }
.bar > i { display: block; height: 100%; background: var(--accent); }
.strip { display: flex; gap: 4px; margin-top: 8px; }
.strip > i {
  flex: 1; height: 28px; border-radius: 4px;
  background: rgba(127,127,127,.2);
}
.strip > i[data-level="1"] { background: color-mix(in srgb, var(--accent) 40%, transparent); }
.strip > i[data-level="2"] { background: var(--accent); }
.cal { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; margin-top: 8px; }
.cal > div { aspect-ratio: 1; border-radius: 4px; background: rgba(127,127,127,.15);
  display: flex; align-items: center; justify-content: center; font-size: 11px; color: var(--muted); }
.cal > div[data-due="y"] { background: color-mix(in srgb, var(--accent) 30%, transparent); color: var(--fg); }
ruby { ruby-position: over; }
rt { font-size: .5em; color: var(--muted); }
.jp { font-size: 17px; line-height: 2.2; }
.err { border-left: 3px solid var(--accent); padding-left: 10px; margin-bottom: 12px; }
.err del { color: var(--muted); text-decoration-thickness: 1px; }
.err ins { text-decoration: none; }
.tag { font-size: 11px; color: var(--muted); border: 1px solid var(--muted);
  border-radius: 4px; padding: 0 4px; margin-left: 6px; }
.empty { color: var(--muted); text-align: center; padding: 32px 0; }
</style>
</head>
<body>
<h1>MasaGo</h1>
<nav>
  <button data-tab="progress" aria-selected="true">进度</button>
  <button data-tab="errors" aria-selected="false">错题本</button>
  <button data-tab="calendar" aria-selected="false">复习日历</button>
</nav>
<main id="view"><div class="empty">加载中…</div></main>
<script>
const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();
const view = document.getElementById('view');
const initData = tg?.initData ?? '';

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ initData }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function pct(a, b) { return b > 0 ? Math.round((a / b) * 100) : 0; }

function progressView(d) {
  const strip = d.activity.map((x) =>
    '<i data-level="' + (x.count === 0 ? '0' : x.count < 10 ? '1' : '2') + '" title="' + esc(x.day) + ' ' + x.count + '"></i>').join('');
  return \`
  <div class="card">
    <div class="row"><b>五十音</b><span class="muted">\${d.kana.introduced}/\${d.kana.total}</span></div>
    <div class="bar"><i style="width:\${pct(d.kana.introduced, d.kana.total)}%"></i></div>
    <div class="muted">待复习 \${d.kana.due}</div>
  </div>
  <div class="card">
    <div class="row"><b>\${esc(d.vocab.level)} 单词</b><span class="muted">\${d.vocab.levelIntroduced}/\${d.vocab.levelTotal}</span></div>
    <div class="bar"><i style="width:\${pct(d.vocab.levelIntroduced, d.vocab.levelTotal)}%"></i></div>
    <div class="muted">合计 \${d.vocab.introduced}/\${d.vocab.total}　待复习 \${d.vocab.due}</div>
  </div>
  <div class="card">
    <div class="row"><b>最近 7 天</b><span class="muted">\${d.streak > 1 ? '连续 ' + d.streak + ' 天 🔥' : ''}</span></div>
    <div class="strip">\${strip}</div>
  </div>\`;
}

function errorsView(rows) {
  if (rows.length === 0) return '<div class="empty">还没有记录到错误。</div>';
  return rows.map((e) => \`
  <div class="card err">
    <div class="jp"><del>\${esc(e.original)}</del> → <ins>\${e.recommendedHtml ?? esc(e.recommended)}</ins>
      <span class="tag">\${esc(e.source)}</span></div>
    \${e.reason ? '<div class="muted">' + esc(e.reason) + '</div>' : ''}
    <div class="muted">\${esc(e.knowledgeKey)}　\${esc(e.at.slice(0, 10))}</div>
  </div>\`).join('');
}

function calendarView(days) {
  const cells = days.map((d) =>
    '<div data-due="' + (d.due > 0 ? 'y' : 'n') + '" title="' + esc(d.day) + '">' +
    (d.due > 0 ? d.due : '') + '</div>').join('');
  const total = days.reduce((s, d) => s + d.due, 0);
  return '<div class="card"><div class="row"><b>未来 4 周</b><span class="muted">共 ' + total + ' 项</span></div>' +
    '<div class="cal">' + cells + '</div>' +
    '<div class="muted" style="margin-top:8px">格子里的数字是当天到期的项目数。</div></div>';
}

const tabs = { progress: ['/api/progress', progressView], errors: ['/api/errors', errorsView], calendar: ['/api/calendar', calendarView] };

async function show(tab) {
  for (const b of document.querySelectorAll('nav button'))
    b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  view.innerHTML = '<div class="empty">加载中…</div>';
  try {
    const [path, render] = tabs[tab];
    view.innerHTML = render(await api(path));
  } catch (err) {
    view.innerHTML = '<div class="empty">读取失败：' + esc(err.message || err) + '</div>';
  }
}

for (const b of document.querySelectorAll('nav button'))
  b.addEventListener('click', () => show(b.dataset.tab));
show('progress');
</script>
</body>
</html>`;
}
