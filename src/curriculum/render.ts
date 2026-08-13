/**
 * 学習者に見せる文面（V2 §4：文字中心）。
 *
 * 説明は中国語。ゼロから始める人に日本語で案内文を書いても読めない——
 * 教える対象の日本語と、操作を説明する言葉は分ける。
 */
import type { Kana } from './kana.js';
import type { QuizQuestion } from './quiz.js';
import type { VocabEntry } from './vocabN5.js';
import type { VocabQuestion } from './vocabQuiz.js';

export interface LessonSummary {
  readonly newKana: readonly Kana[];
  readonly reviewCount: number;
  readonly newHeldBackForBacklog: boolean;
  readonly progress: { introduced: number; total: number };
}

function glyphList(kana: readonly Kana[]): string {
  return kana.map((k) => `${k.hiragana}(${k.romaji})`).join('  ');
}

export function renderToday(summary: LessonSummary): string {
  const lines: string[] = ['📅 今天的学习', ''];

  if (summary.newKana.length > 0) {
    lines.push(`新假名 ${String(summary.newKana.length)} 个`);
    lines.push(`  ${glyphList(summary.newKana)}`);
  } else if (summary.newHeldBackForBacklog) {
    // 何も出ない理由を黙っていると「壊れている」と読まれる。
    lines.push('新假名 暂停');
    lines.push('  复习积压较多，今天先追平再往前走。');
  } else {
    lines.push('新假名 无（五十音已全部学过）');
  }

  lines.push(`复习 ${String(summary.reviewCount)} 个`);
  lines.push('');
  lines.push(
    `进度 ${String(summary.progress.introduced)}/${String(summary.progress.total)}`,
  );
  lines.push('');
  lines.push('发 /kana 开始今天的学习。');
  return lines.join('\n');
}

/** 新しい仮名を教えるカード。音声は呼び出し側が別途送る。 */
export function renderTeachingCard(kana: Kana, index: number, total: number): string {
  return [
    `${String(index)}/${String(total)}`,
    '',
    `${kana.hiragana}　／　${kana.katakana}`,
    `读作：${kana.romaji}`,
    '',
    `（${kana.row}行）`,
  ].join('\n');
}

/**
 * 出題の本文。
 *
 * 字形は必ず単独の行に置く。打ち込みで答えたものは、返信元の本文から
 * 「何を訊かれたか」を読み直して採点する（targetOfQuestionText）ので、
 * 説明文と同じ行に混ぜると復元できなくなる。
 */
export function renderQuestion(
  question: QuizQuestion,
  typed = false,
): string {
  switch (question.kind) {
    case 'GLYPH_TO_ROMAJI':
      return typed
        ? `这个假名怎么读？\n\n${question.prompt}\n\n直接回复罗马字（例：ka）`
        : `这个假名怎么读？\n\n${question.prompt}`;
    case 'ROMAJI_TO_GLYPH':
      return `哪个是 ${question.prompt}？`;
    case 'AUDIO_TO_GLYPH':
      return '听到的是哪个假名？';
  }
}

export function renderCorrect(kana: Kana): string {
  return `✅ ${kana.hiragana} = ${kana.romaji}`;
}

export function renderWrong(
  target: Kana,
  chosen: Kana | undefined,
  typed?: string,
): string {
  const lines = [`❌ 正确答案是 ${target.hiragana}（${target.romaji}）`];
  if (chosen !== undefined && chosen.id !== target.id) {
    lines.push(`你选的 ${chosen.hiragana} 读作 ${chosen.romaji}`);
  } else if (typed !== undefined && typed.trim() !== '') {
    // 打ち間違いか、別の字と取り違えたのか。返した文字をそのまま見せると
    // 「何を打ったか」を自分で確かめられる。
    lines.push(`你打的是「${typed.trim()}」`);
  }
  return lines.join('\n');
}

export function renderDrillFinished(answered: number): string {
  if (answered === 0) {
    return '今天没有到期的复习。发 /today 看看安排。';
  }
  return `👍 本轮完成，共 ${String(answered)} 题。\n\n发 /kana 继续，或 /progress 看进度。`;
}

export interface ProgressView {
  readonly introduced: number;
  readonly total: number;
  readonly dueNow: number;
  readonly mastered: number;
}

function bar(introduced: number, total: number): string {
  const pct = total === 0 ? 0 : Math.round((introduced / total) * 100);
  const filled = Math.round(pct / 5);
  return `${'█'.repeat(filled)}${'░'.repeat(20 - filled)} ${String(pct)}%`;
}

export function renderProgress(view: ProgressView): string {
  return [
    '📊 五十音进度',
    '',
    bar(view.introduced, view.total),
    `已学 ${String(view.introduced)}/${String(view.total)}`,
    `已掌握 ${String(view.mastered)}`,
    `待复习 ${String(view.dueNow)}`,
  ].join('\n');
}

export interface FullProgressView {
  readonly kana: ProgressView;
  readonly vocab: ProgressView;
  readonly showVocab: boolean;
}

/**
 * 仮名と語彙をまとめた進度。
 *
 * 語彙をまだ始めていない段階では語彙の行を出さない。0/671 と並べても
 * 「まだ手をつけていない量」を突きつけるだけで、今日やることは変わらない。
 */
export function renderFullProgress(view: FullProgressView): string {
  const lines = [
    '📊 学习进度',
    '',
    '五十音',
    bar(view.kana.introduced, view.kana.total),
    `  已学 ${String(view.kana.introduced)}/${String(view.kana.total)}　待复习 ${String(view.kana.dueNow)}`,
  ];
  if (view.showVocab) {
    lines.push(
      '',
      'N5 单词',
      bar(view.vocab.introduced, view.vocab.total),
      `  已学 ${String(view.vocab.introduced)}/${String(view.vocab.total)}　待复习 ${String(view.vocab.dueNow)}`,
    );
  }
  return lines.join('\n');
}

// ---------- S1 語彙 ----------

/**
 * 新しい語を教えるカード。
 *
 * 漢字には必ず読みを添える。読めない字は覚えようが無いし、
 * 読みを推測させると間違った音のまま覚える（§15 の誤模倣）。
 */
export function renderVocabCard(
  entry: VocabEntry,
  index: number,
  total: number,
): string {
  const lines = [
    `${String(index)}/${String(total)}`,
    '',
    entry.expression,
  ];
  if (entry.reading !== entry.expression) {
    lines.push(`　${entry.reading}`);
  }
  lines.push('', entry.meaning);
  if (entry.genkiLesson !== undefined) {
    lines.push('', `（Genki 第 ${String(entry.genkiLesson)} 课）`);
  }
  return lines.join('\n');
}

/**
 * 出題の本文。
 *
 * 打たせる問題は必ず「意味 → 日本語」にする。語を見せて書かせても
 * 目の前の字を写すだけで、思い出す働きが無い。意味は単独の行に置く
 * ——返信から何を訊いたかを復元するため（targetOfVocabQuestionText）。
 */
export function renderVocabQuestion(
  question: VocabQuestion,
  typed = false,
): string {
  if (question.kind === 'MEANING_TO_WORD') {
    return typed
      ? `这个意思的日文怎么写？\n\n${question.prompt}\n\n回复日文或假名`
      : `哪个词是「${question.prompt}」？`;
  }
  const reading =
    question.promptReading === undefined ? '' : `\n　${question.promptReading}`;
  return `这个词是什么意思？\n\n${question.prompt}${reading}`;
}

export function renderVocabCorrect(entry: VocabEntry): string {
  const reading =
    entry.reading === entry.expression ? '' : `（${entry.reading}）`;
  return `✅ ${entry.expression}${reading} = ${entry.meaning}`;
}

export function renderVocabWrong(
  target: VocabEntry,
  chosen: VocabEntry | undefined,
  typed?: string,
): string {
  const reading =
    target.reading === target.expression ? '' : `（${target.reading}）`;
  const lines = [`❌ 正确答案是 ${target.expression}${reading} — ${target.meaning}`];
  if (chosen !== undefined && chosen.id !== target.id) {
    lines.push(`你选的 ${chosen.expression} 是「${chosen.meaning}」`);
  } else if (typed !== undefined && typed.trim() !== '') {
    lines.push(`你写的是「${typed.trim()}」`);
  }
  return lines.join('\n');
}

export interface DailySummary {
  readonly stage: string;
  readonly newKana: readonly Kana[];
  readonly kanaDue: number;
  readonly newWords: readonly VocabEntry[];
  readonly vocabDue: number;
  readonly kanaProgress: { introduced: number; total: number };
  readonly vocabProgress: { introduced: number; total: number };
  readonly heldBack: boolean;
}

/** 仮名と語彙をまとめた今日の予定。 */
export function renderDaily(summary: DailySummary): string {
  const lines: string[] = ['📅 今天的学习', ''];

  if (summary.newKana.length > 0) {
    lines.push(`新假名 ${String(summary.newKana.length)} 个`);
    lines.push(`  ${glyphList(summary.newKana)}`);
  }
  if (summary.kanaDue > 0) {
    lines.push(`假名复习 ${String(summary.kanaDue)} 个`);
  }
  if (summary.newWords.length > 0) {
    lines.push(`新单词 ${String(summary.newWords.length)} 个`);
    // 仮名だけの語は表記と読みが同じ。「ノート(ノート)」と出すと
    // 壊れているように見える。
    lines.push(
      `  ${summary.newWords
        .map((w) =>
          w.reading === w.expression
            ? w.expression
            : `${w.expression}(${w.reading})`,
        )
        .join('  ')}`,
    );
  }
  if (summary.vocabDue > 0) {
    lines.push(`单词复习 ${String(summary.vocabDue)} 个`);
  }
  if (
    summary.newKana.length === 0 &&
    summary.newWords.length === 0 &&
    summary.kanaDue === 0 &&
    summary.vocabDue === 0
  ) {
    lines.push(summary.heldBack ? '复习积压较多，先追平。' : '今天没有到期的内容。');
  }

  lines.push('');
  lines.push(
    `五十音 ${String(summary.kanaProgress.introduced)}/${String(summary.kanaProgress.total)}　単語 ${String(summary.vocabProgress.introduced)}/${String(summary.vocabProgress.total)}`,
  );
  lines.push('');
  lines.push('/kana 练假名　/vocab 练单词　/review 只复习');
  return lines.join('\n');
}

// ---------- 費用 ----------

export interface CostView {
  readonly todayUsd: number;
  readonly monthUsd: number;
  readonly dailyLimitUsd: number;
  readonly monthlyLimitUsd: number;
  readonly unknownCostCalls: number;
  readonly topThisMonth: readonly { label: string; usd: number }[];
}

/**
 * 費用の見え方（V2 §4.4 の /cost）。
 *
 * 上限に対する割合を必ず添える。金額だけでは多いのか少ないのか判断できず、
 * 見ても行動が変わらない数字になる。
 */
export function renderCost(view: CostView): string {
  const pct = (used: number, limit: number): string =>
    limit <= 0 ? '—' : `${String(Math.round((used / limit) * 100))}%`;
  const money = (usd: number): string => `$${usd.toFixed(4)}`;

  const lines = [
    '💰 用量与成本',
    '',
    `今天　${money(view.todayUsd)} / ${money(view.dailyLimitUsd)}　(${pct(view.todayUsd, view.dailyLimitUsd)})`,
    `本月　${money(view.monthUsd)} / ${money(view.monthlyLimitUsd)}　(${pct(view.monthUsd, view.monthlyLimitUsd)})`,
  ];

  if (view.topThisMonth.length > 0) {
    lines.push('', '本月构成');
    for (const row of view.topThisMonth) {
      lines.push(`  ${row.label}　${money(row.usd)}`);
    }
  }
  if (view.unknownCostCalls > 0) {
    // 価格表に無い呼び出しは合計に入っていない。黙って過少に見せない。
    lines.push(
      '',
      `⚠️ ${String(view.unknownCostCalls)} 次调用未计价（价格表缺该型号），未计入合计。`,
    );
  }
  return lines.join('\n');
}

/**
 * 初回の案内（`/start`）。
 *
 * 中国語で書く。ここを読むのは日本語を一文字も知らない人で、
 * 日本語で歓迎しても意味が通らない。
 */
export function renderWelcome(returning: boolean): string {
  if (returning) {
    return [
      '👋 欢迎回来。',
      '',
      '发 /today 看今天的安排，或直接 /kana 开始。',
    ].join('\n');
  }
  return [
    '👋 我是 MasaGo，陪你从零开始学日语。',
    '',
    '怎么走：',
    '1. 先学五十音（每天 5 个，带发音语音）',
    '2. 清音学完后开始 N5 单词，按 Genki 课本顺序',
    '3. 复习时间由程序按记忆曲线安排，不用自己规划',
    '',
    '常用命令',
    '  /today    今天学什么',
    '  /kana     练五十音',
    '  /vocab    练单词',
    '  /review   只复习到期的',
    '  /progress 看进度',
    '  /explain  讲解刚才那一项',
    '',
    '现在就可以发 /kana 开始第一课。',
  ].join('\n');
}

export interface ActivityView {
  /** 直近 7 日分（古い順）。`[{ day: '2026-08-08', count: 12 }, …]` */
  readonly days: readonly { day: string; count: number }[];
  readonly streak: number;
}

/**
 * 直近一週間の活動。
 *
 * 数字を並べるより、やった日と休んだ日が一目で分かるほうが続く。
 * 連続日数は「今日か昨日で終わっている連なり」だけを数える——
 * 二週間前に 10 日続けた記録を今日の連続として見せても意味が無い。
 */
export function renderActivity(view: ActivityView): string {
  const strip = view.days
    .map((d) => (d.count === 0 ? '·' : d.count < 10 ? '▪' : '■'))
    .join(' ');
  const total = view.days.reduce((sum, d) => sum + d.count, 0);
  const lines = [`最近 7 天　${strip}`, `  共 ${String(total)} 题`];
  if (view.streak > 1) {
    lines.push(`  连续 ${String(view.streak)} 天 🔥`);
  }
  return lines.join('\n');
}

/**
 * 連続日数。今日から遡って、答えた日が途切れるまで数える。
 *
 * 今日まだ答えていない場合は昨日から数える——夜にまとめてやる人の
 * 連続を、日中に見ただけで 0 に見せない。
 */
export function streakOf(
  counts: ReadonlyMap<string, number>,
  todayKey: string,
  dayKeyBefore: (key: string, back: number) => string,
): number {
  let streak = 0;
  const startedToday = (counts.get(todayKey) ?? 0) > 0;
  for (let back = startedToday ? 0 : 1; back < 400; back += 1) {
    const key = dayKeyBefore(todayKey, back);
    if ((counts.get(key) ?? 0) > 0) streak += 1;
    else break;
  }
  return streak;
}
