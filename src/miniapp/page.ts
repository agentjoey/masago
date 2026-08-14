/**
 * Mini App の画面（V3）。
 *
 * 単一の HTML を返すだけ。ビルド工程を増やしたくないので依存も無し。
 * ここでしかできないのは **本物の ruby** と **一覧の可視化**——Telegram の
 * メッセージでは括弧で添えるしかなく（§4.2）、五十音を表として見せることも
 * できない。学習者は表の位置で覚えるので、この一枚には意味がある。
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
  --muted: var(--tg-theme-hint-color, #8b8b8f);
  --card: var(--tg-theme-secondary-bg-color, #f4f4f5);
  --accent: var(--tg-theme-link-color, #2f81f7);
}
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
body {
  margin: 0; padding: 12px 12px 40px;
  background: var(--bg); color: var(--fg);
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Noto Sans CJK SC", sans-serif;
}
h1 { font-size: 17px; margin: 0 0 12px; }
nav { display: flex; gap: 6px; margin-bottom: 12px; }
nav button {
  flex: 1; padding: 7px 4px; border: 0; border-radius: 8px;
  background: var(--card); color: var(--fg); font-size: 13px; cursor: pointer;
}
nav button[aria-selected="true"] { background: var(--accent); color: #fff; }
.card { background: var(--card); border-radius: 12px; padding: 13px; margin-bottom: 10px; }
.row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.muted { color: var(--muted); font-size: 13px; }
.bar { height: 8px; border-radius: 4px; background: rgba(127,127,127,.25); overflow: hidden; margin: 8px 0 4px; }
.bar > i { display: block; height: 100%; background: var(--accent); }
.strip { display: flex; gap: 4px; margin-top: 8px; }
.strip > i { flex: 1; height: 26px; border-radius: 4px; background: rgba(127,127,127,.18); }
.strip > i[data-level="1"] { background: color-mix(in srgb, var(--accent) 40%, transparent); }
.strip > i[data-level="2"] { background: var(--accent); }

/* 五十音表 */
.sec-title { font-size: 13px; color: var(--muted); margin: 14px 2px 6px; }
.grid { display: grid; gap: 4px; }
.cell {
  aspect-ratio: 1; border: 0; border-radius: 8px; padding: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  background: var(--card); color: var(--muted);
  font-size: 17px; font-family: "Hiragino Sans", "Noto Sans CJK JP", sans-serif;
  cursor: pointer; position: relative;
}
.cell[data-blank="y"] { background: transparent; cursor: default; }
/* 未学：暗い。学習が進むほど点る。 */
.cell[data-known="y"] { color: var(--fg); }
.cell small { font-size: 9px; line-height: 1; opacity: .65; margin-top: 2px; }
.cell i {
  position: absolute; left: 6px; right: 6px; bottom: 4px; height: 2px;
  border-radius: 1px; background: var(--accent);
}
.cell[data-due="y"]::after {
  content: ''; position: absolute; top: 5px; right: 5px;
  width: 6px; height: 6px; border-radius: 50%; background: #f5a524;
}
.legend { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 10px; }
.legend span { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 4px; }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }

/* 詳細シート */
dialog {
  border: 0; border-radius: 16px 16px 0 0; padding: 18px 16px 24px;
  background: var(--bg); color: var(--fg); width: 100%; max-width: 520px;
  margin: auto auto 0; position: fixed; inset: auto 0 0;
}
dialog::backdrop { background: rgba(0,0,0,.4); }
.big { font-size: 56px; line-height: 1.1; text-align: center; font-family: "Hiragino Sans", "Noto Sans CJK JP", sans-serif; }
.pair { display: flex; justify-content: center; gap: 24px; align-items: baseline; }
.actions { display: flex; gap: 8px; margin-top: 16px; }
.actions button {
  flex: 1; padding: 11px; border: 0; border-radius: 10px; font-size: 15px; cursor: pointer;
  background: var(--card); color: var(--fg);
}
.actions button.primary { background: var(--accent); color: #fff; }
.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 14px; text-align: center; }
.stats div { background: var(--card); border-radius: 8px; padding: 8px 4px; }
.stats b { display: block; font-size: 16px; }
.stats span { font-size: 11px; color: var(--muted); }

.cal { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; margin-top: 8px; }
.cal > div { aspect-ratio: 1; border-radius: 4px; background: rgba(127,127,127,.15);
  display: flex; align-items: center; justify-content: center; font-size: 11px; color: var(--muted); }
.cal > div[data-due="y"] { background: color-mix(in srgb, var(--accent) 30%, transparent); color: var(--fg); }
ruby { ruby-position: over; }
rt { font-size: .5em; color: var(--muted); }
.jp { font-size: 17px; line-height: 2.2; }
.err { border-left: 3px solid var(--accent); padding-left: 10px; }
.err del { color: var(--muted); }
.err ins { text-decoration: none; }
.tag { font-size: 11px; color: var(--muted); border: 1px solid var(--muted); border-radius: 4px; padding: 0 4px; margin-left: 6px; }
.empty { color: var(--muted); text-align: center; padding: 32px 0; }
/* 本文の振り仮名。Telegram のメッセージでは出せない、これが Mini App の主目的。 */
.sent { font-size: 26px; line-height: 2.6; text-align: center; padding: 8px 0 16px; }
.sent ruby { ruby-position: over; }
/* rt の既定は小さすぎて、読みを覚えるための字として読めない。 */
.sent rt { font-size: 12px; color: var(--muted); letter-spacing: .04em; }
.choices { display: grid; gap: 8px; }
.choice {
  width: 100%; text-align: left; padding: 12px 14px; font: inherit;
  border: 1px solid var(--line); border-radius: 10px;
  background: var(--card); color: inherit; cursor: pointer;
}
.choice[data-state="right"] { border-color: #2e9e5b; background: #2e9e5b18; }
.choice[data-state="wrong"] { border-color: #c0392b; background: #c0392b18; }
.choice[disabled] { cursor: default; }
.levels { display: flex; gap: 6px; justify-content: center; margin-bottom: 10px; }
.levels button {
  font: inherit; font-size: 13px; padding: 4px 10px; border-radius: 999px;
  border: 1px solid var(--line); background: var(--card); color: var(--muted); cursor: pointer;
}
.levels button[aria-selected="true"] { background: var(--accent); color: #fff; border-color: var(--accent); }
.scenes { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 6px; margin-bottom: 10px; }
.scenes button {
  font: inherit; font-size: 13px; padding: 5px 12px; border-radius: 999px; white-space: nowrap;
  border: 1px solid var(--line); background: var(--card); color: var(--muted); cursor: pointer;
}
.scenes button[aria-selected="true"] { background: var(--accent); color: #fff; border-color: var(--accent); }
</style>
</head>
<body>
<h1>MasaGo</h1>
<nav>
  <button data-tab="progress" aria-selected="true">进度</button>
  <button data-tab="kana" aria-selected="false">五十音</button>
  <button data-tab="reading" aria-selected="false">阅读</button>
  <button data-tab="errors" aria-selected="false">错题本</button>
  <button data-tab="calendar" aria-selected="false">日历</button>
</nav>
<main id="view"><div class="empty">加载中…</div></main>
<dialog id="sheet"></dialog>
<script>
const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();
const view = document.getElementById('view');
const sheet = document.getElementById('sheet');
const initData = tg?.initData ?? '';

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

/* ---------- 进度 ---------- */
function progressView(d) {
  const strip = d.activity.map((x) =>
    '<i data-level="' + (x.count === 0 ? '0' : x.count < 10 ? '1' : '2') +
    '" title="' + esc(x.day) + '：' + x.count + ' 题"></i>').join('');
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

/* ---------- 五十音表 ---------- */
let kanaIndex = {};
function kanaView(sections) {
  kanaIndex = {};
  let html = '';
  for (const sec of sections) {
    html += '<div class="sec-title">' + esc(sec.title) + '</div>';
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
          (known ? '<i style="width:' + Math.max(strength, 6) + '%"></i>' : '') +
          '</button>';
      }
    }
    html += '</div>';
  }
  html += \`<div class="legend">
    <span><i class="dot" style="background:var(--accent)"></i>下线越长＝记得越牢</span>
    <span><i class="dot" style="background:#f5a524"></i>待复习</span>
    <span style="opacity:.55">灰色＝还没学到</span>
  </div>\`;
  return html;
}

function openKana(id) {
  const cell = kanaIndex[id];
  if (cell === undefined) return;
  const s = cell.state;
  const due = s ? new Date(s.dueAt) : null;
  sheet.innerHTML = \`
    <div class="pair"><div class="big">\${esc(cell.hiragana)}</div><div class="big">\${esc(cell.katakana)}</div></div>
    <div class="muted" style="text-align:center;font-size:15px">\${esc(cell.romaji)}</div>
    \${s ? \`<div class="stats">
      <div><b>\${s.reps}</b><span>练习次数</span></div>
      <div><b>\${s.lapses}</b><span>答错次数</span></div>
      <div><b>\${Math.round(s.strength * 100)}%</b><span>记忆强度</span></div>
    </div>
    <div class="muted" style="text-align:center;margin-top:10px">
      \${s.due ? '现在待复习' : '下次复习：' + due.toLocaleDateString()}
    </div>\` : '<div class="muted" style="text-align:center;margin-top:14px">这个假名还没学到。</div>'}
    <div class="actions">
      <button class="primary" id="play">🔊 发音</button>
      \${s ? '<button id="again">安排复习</button>' : ''}
      <button id="close">关闭</button>
    </div>\`;
  sheet.showModal();

  const audio = new Audio('/audio/kana/' + encodeURIComponent(cell.id) + '.mp3');
  sheet.querySelector('#play').addEventListener('click', () => {
    audio.currentTime = 0;
    audio.play().catch(() => {});
  });
  sheet.querySelector('#close').addEventListener('click', () => sheet.close());
  const again = sheet.querySelector('#again');
  again?.addEventListener('click', async () => {
    again.disabled = true;
    again.textContent = '已安排';
    try {
      await api('/api/practice', { key: s.key });
      tg?.HapticFeedback?.notificationOccurred('success');
      // 表の点灯を実際の状態に合わせ直す。押しただけで見た目が変わらないと
      // 効いたのか分からない。
      await show('kana');
    } catch { again.textContent = '失败'; }
  });
  // 開いた瞬間に一度鳴らす。発音を聞くのがこの画面の主目的。
  audio.play().catch(() => {});
}

/* ---------- 错题本 / 日历 ---------- */
function errorsView(rows) {
  if (rows.length === 0) return '<div class="empty">还没有记录到错误。<br><span class="muted">跟 bot 用日语聊天时才会产生。</span></div>';
  return rows.map((e) => \`
  <div class="card err">
    <div class="jp"><del>\${esc(e.original)}</del> → <ins>\${esc(e.recommended)}</ins><span class="tag">\${esc(e.source)}</span></div>
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

/* ---------- 阅读 ---------- */
let rubyLevel = 'ALL';
let sceneId = '';
let reading = null;

function rubyHtml(segments) {
  return segments.map((s) => s.ruby === null
    ? esc(s.text)
    : '<ruby>' + esc(s.text) + '<rt>' + esc(s.ruby) + '</rt></ruby>').join('');
}

function readingView(d) {
  if (d === null) return '<div class="empty">还没有可读的句子。先发 /vocab 学一些单词。</div>';
  reading = d;
  const levels = [['ALL', '全部注音'], ['UNKNOWN', '只标生词'], ['NONE', '不注音']]
    .map(([v, label]) => '<button data-level="' + v + '" aria-selected="' +
      (v === d.level) + '">' + label + '</button>').join('');
  const scenes = [{ id: '', name: '全部' }].concat(d.scenes)
    .map((sc) => '<button data-scene="' + esc(sc.id) + '" aria-selected="' +
      (sc.id === (d.sceneId || '')) + '">' + esc(sc.name) + '</button>').join('');
  const choices = d.options.map((o) =>
    '<button class="choice" data-id="' + esc(o.id) + '">' + esc(o.label) + '</button>').join('');
  return '<div class="scenes">' + scenes + '</div>' +
    '<div class="levels">' + levels + '</div>' +
    '<div class="card"><div class="sent">' + rubyHtml(d.segments) + '</div></div>' +
    '<div class="muted" style="margin:0 0 8px">这句话是什么意思？</div>' +
    '<div class="choices">' + choices + '</div>' +
    '<div id="verdict"></div>';
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
      '<div class="empty">判分失败：' + esc(err.message || err) + '</div>';
    return;
  }
  if (v === null) return;
  for (const b of buttons) {
    if (b.dataset.id === chosenId) b.dataset.state = v.correct ? 'right' : 'wrong';
    // 間違えたときは正解も示す。どれが正しかったか分からないまま次へ行かせない。
    else if (!v.correct && b.textContent === v.answer) b.dataset.state = 'right';
  }
  document.getElementById('verdict').innerHTML =
    '<div class="card" style="margin-top:12px">' +
    (v.correct ? '✅ 答对了' : '❌ 正确答案：' + esc(v.answer)) +
    '<div style="margin-top:10px"><button class="choice" id="next">下一句</button></div></div>';
  document.getElementById('next').addEventListener('click', () => show('reading'));
}

const tabs = {
  progress: ['/api/progress', progressView],
  kana: ['/api/kana', kanaView],
  reading: ['/api/reading', readingView],
  errors: ['/api/errors', errorsView],
  calendar: ['/api/calendar', calendarView],
};

async function show(tab) {
  for (const b of document.querySelectorAll('nav button'))
    b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  view.innerHTML = '<div class="empty">加载中…</div>';
  try {
    const [path, render] = tabs[tab];
    view.innerHTML = render(await api(path,
      tab === 'reading' ? { level: rubyLevel, scene: sceneId } : undefined));
  } catch (err) {
    view.innerHTML = '<div class="empty">读取失败：' + esc(err.message || err) + '</div>';
  }
}

view.addEventListener('click', (e) => {
  const cell = e.target.closest('.cell[data-id]');
  if (cell !== null) { openKana(cell.dataset.id); return; }
  const level = e.target.closest('.levels button[data-level]');
  if (level !== null) { rubyLevel = level.dataset.level; show('reading'); return; }
  const scene = e.target.closest('.scenes button[data-scene]');
  if (scene !== null) { sceneId = scene.dataset.scene; show('reading'); return; }
  const choice = e.target.closest('.choice[data-id]');
  if (choice !== null && !choice.disabled) answerReading(choice.dataset.id);
});
sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); });
for (const b of document.querySelectorAll('nav button'))
  b.addEventListener('click', () => show(b.dataset.tab));
show('progress');
</script>
</body>
</html>`;
}
