/**
 * 学習者に見せる文面（V2 §4：文字中心）。
 *
 * 説明は中国語。ゼロから始める人に日本語で案内文を書いても読めない——
 * 教える対象の日本語と、操作を説明する言葉は分ける。
 */
import { kanaGlyph, type Kana, type KanaScript } from './kana.js';
import type { Particle } from './particles.js';
import type { QuizQuestion } from './quiz.js';
import type { SentenceQuestion } from './sentenceQuiz.js';
import type { VocabEntry } from './vocab.js';
import type { VocabQuestion } from './vocabQuiz.js';
import type { OrderVerdict } from './writing.js';

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

/**
 * 講評は**訊いたのと同じ字体**で返す。
 *
 * ここを平仮名に固定していたせいで、`キ` と訊いて「正确答案是 き」と
 * 返していた。零基礎の学習者に キ と き が同じ音だと見抜く手立ては
 * 無い（§15）——別の字の話に見えるし、押した札（コ）と講評の字（こ）
 * が違うので、自分が何を押したのかも突き合わせられない。
 */
export function renderCorrect(kana: Kana, script: KanaScript): string {
  return `✅ ${kanaGlyph(kana, script)} = ${kana.romaji}`;
}

export function renderWrong(
  target: Kana,
  chosen: Kana | undefined,
  typed: string | undefined,
  script: KanaScript,
): string {
  const lines = [`❌ 正确答案是 ${kanaGlyph(target, script)}（${target.romaji}）`];
  if (chosen !== undefined && chosen.id !== target.id) {
    lines.push(`你选的 ${kanaGlyph(chosen, script)} 读作 ${chosen.romaji}`);
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
  /** いま取り組んでいる等級（N5 / N4）。 */
  readonly vocabLevel?: string;
  /** その等級の中での進み。全体の数だけだと現在地が見えない。 */
  readonly levelProgress?: { introduced: number; total: number };
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
    const label = view.vocabLevel === undefined ? '单词' : `${view.vocabLevel} 单词`;
    lines.push('', label, bar(view.vocab.introduced, view.vocab.total));
    // 全体の数だけだと「1375 のうち 90」で現在地が分からない。
    // いまの等級の中でどこまで来たかを併記する。
    if (view.levelProgress !== undefined) {
      lines.push(
        `  ${view.vocabLevel ?? ''} ${String(view.levelProgress.introduced)}/${String(view.levelProgress.total)}　合计 ${String(view.vocab.introduced)}/${String(view.vocab.total)}　待复习 ${String(view.vocab.dueNow)}`,
      );
    } else {
      lines.push(
        `  已学 ${String(view.vocab.introduced)}/${String(view.vocab.total)}　待复习 ${String(view.vocab.dueNow)}`,
      );
    }
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
  /** 期限の来た助詞。/write へ誘導するのに要る。 */
  readonly grammarDue: number;
  /** 今日これから教える助詞。 */
  readonly newParticles: readonly Particle[];
  readonly kanaProgress: { introduced: number; total: number };
  readonly vocabProgress: { introduced: number; total: number };
  readonly grammarProgress: { introduced: number; total: number };
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
  // 助詞も課程の一部。ここに出さないと、期限が来ていることに
  // 気づく手立てが無い——/write を自分で思い出すしかなかった。
  if (summary.newParticles.length > 0) {
    lines.push(`新助词 ${String(summary.newParticles.length)} 个`);
    lines.push(
      `  ${summary.newParticles.map((p) => `${p.surface}(${p.reading})`).join('  ')}`,
    );
  }
  if (summary.grammarDue > 0) {
    lines.push(`助词复习 ${String(summary.grammarDue)} 个`);
  }

  const nothingToDo =
    summary.newKana.length === 0 &&
    summary.newWords.length === 0 &&
    summary.newParticles.length === 0 &&
    summary.kanaDue === 0 &&
    summary.vocabDue === 0 &&
    summary.grammarDue === 0;
  // 一日の数は**計画**であって練習の上限ではない。今日のぶんを終えた日に
  // 「今天没有到期的内容」とだけ出して入口も /review しか出していなかった
  // ので、まだ 94 字残っていても今日はもう終わりに見えていた。
  const moreToLearn =
    summary.kanaProgress.introduced < summary.kanaProgress.total ||
    summary.vocabProgress.introduced < summary.vocabProgress.total;
  const planDone = nothingToDo && !summary.heldBack && moreToLearn;
  if (nothingToDo) {
    lines.push(
      summary.heldBack
        ? '复习积压较多，先追平。'
        : planDone
          ? '今天的计划做完了。想继续就直接往下学。'
          : '今天没有到期的内容。',
    );
  }

  lines.push('');
  const progress = [
    `五十音 ${String(summary.kanaProgress.introduced)}/${String(summary.kanaProgress.total)}`,
    `単語 ${String(summary.vocabProgress.introduced)}/${String(summary.vocabProgress.total)}`,
  ];
  // 助詞はまだ始めていない段階では出さない。0/12 と並べても
  // 今日やることは変わらない（語彙の行と同じ考え方）。
  if (summary.grammarProgress.introduced > 0 || summary.grammarDue > 0) {
    progress.push(
      `助词 ${String(summary.grammarProgress.introduced)}/${String(summary.grammarProgress.total)}`,
    );
  }
  lines.push(progress.join('　'));
  lines.push('');
  // 案内は「今日やることがある入口」だけ出す。全部並べると
  // どれを押せばいいのか分からない。
  const entries: string[] = [];
  // 計画を終えた日は、まだ材料が残っている線の入口を出す。案内が
  // /review だけだと「続けられる」と書いておいて押す所が無い。
  const kanaLeft =
    summary.kanaProgress.introduced < summary.kanaProgress.total;
  const vocabLeft =
    summary.vocabProgress.introduced < summary.vocabProgress.total;
  if (summary.newKana.length > 0 || summary.kanaDue > 0 || (planDone && kanaLeft)) {
    entries.push('/kana 练假名');
  }
  if (
    summary.newWords.length > 0 ||
    summary.vocabDue > 0 ||
    (planDone && !kanaLeft && vocabLeft)
  ) {
    entries.push('/vocab 练单词');
  }
  if (summary.newParticles.length > 0 || summary.grammarDue > 0) {
    entries.push('/write 练助词');
  }
  entries.push('/review 只复习');
  lines.push(entries.join('　'));
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

/* ─────────────── 書く練習（docs/scenario-learning.md §5） ─────────────── */

/** 助詞を教えるカード。 */
export function renderParticleCard(
  particle: Particle,
  index: number,
  total: number,
): string {
  const lines = [
    `${String(index)}/${String(total)}`,
    '',
    `【${particle.surface}】`,
    `　读作 ${particle.reading}`,
    `　${particle.label}`,
  ];
  // 表記どおりに読まない三つは、そこだけ念を押す。仮名を覚えた直後ほど
  // 「は」を ha と読んでしまう。
  if (particle.surface !== particle.reading) {
    lines.push('', `⚠️ 作助词时读 ${particle.reading}，不读 ${defaultReadingOf(particle.surface)}`);
  }
  return lines.join('\n');
}

/** 助詞として読み方が変わる三つの、本来の読み。 */
function defaultReadingOf(surface: string): string {
  const table: Record<string, string> = { は: 'ha', へ: 'he', を: 'wo' };
  return table[surface] ?? surface;
}

export function renderParticleQuestion(prompt: string): string {
  return `填入合适的助词：\n\n${prompt}`;
}

export function renderParticleCorrect(
  particle: Particle,
  full: string,
): string {
  return `✅ ${full}\n\n${particle.surface}（${particle.reading}）— ${particle.label}`;
}

export function renderParticleWrong(
  answer: Particle,
  chosen: Particle | undefined,
  full: string,
): string {
  const lines = [`❌ 正确答案是 ${answer.surface}`, '', full, '', `${answer.surface}（${answer.reading}）— ${answer.label}`];
  if (chosen !== undefined && chosen.id !== answer.id) {
    lines.push(`你选的 ${chosen.surface} 是「${chosen.label}」`);
  }
  return lines.join('\n');
}

export function renderWordOrderQuestion(pieces: readonly string[]): string {
  return [
    '把下面的词按正确顺序排成一句话：',
    '',
    pieces.join('　/　'),
    '',
    '回复完整的句子',
  ].join('\n');
}

export function renderWordOrderResult(
  verdict: OrderVerdict,
  full: string,
  submitted: string,
): string {
  if (verdict === 'CORRECT') return `✅ ${full}`;
  if (verdict === 'ACCEPTABLE') {
    // 日本語の語順は比較的自由。正しく書いた人に ❌ を出さない。
    return [
      '⭕ 这样也说得通。',
      '',
      `原句是：${full}`,
      '日语语序比较自由，只要谓语在最后、助词用对，换个顺序也成立。',
    ].join('\n');
  }
  const lines = ['❌ 正确的是：', '', full];
  if (submitted.trim() !== '') lines.push('', `你写的是：${submitted.trim()}`);
  return lines.join('\n');
}

export function renderWritingIntro(introduced: number, total: number): string {
  return [
    '✍️ 写句子练习',
    '',
    `助词进度 ${String(introduced)}/${String(total)}`,
    '',
    '助词是日语最容易出错的地方——先把它们练熟。',
  ].join('\n');
}

/* ─────────────── 読む練習（docs/scenario-learning.md §5） ─────────────── */

export function renderReadingQuestion(question: SentenceQuestion): string {
  if (question.kind === 'ZH_TO_JA') {
    return `这句话日语怎么说？\n\n${question.prompt}`;
  }
  return `这句话是什么意思？\n\n${question.prompt}`;
}

export function renderReadingCorrect(text: string, zh: string): string {
  return `✅ ${text}\n　${zh}`;
}

export function renderReadingWrong(
  text: string,
  zh: string,
  chosenLabel: string | undefined,
): string {
  const lines = ['❌ 正确答案是：', '', text, `　${zh}`];
  if (chosenLabel !== undefined && chosenLabel.trim() !== '') {
    lines.push('', `你选的是「${chosenLabel.trim()}」`);
  }
  return lines.join('\n');
}

/* ─────────────── 中訳日（docs/scenario-learning.md §5 書 第 3 档） ─────────────── */

export function renderCompositionQuestion(meaning: string): string {
  return [
    '用日语写出这句话的意思：',
    '',
    meaning,
    '',
    '直接回复日语句子',
  ].join('\n');
}

export function renderCompositionResult(
  correct: boolean,
  reference: string,
  note: string,
  judged: boolean,
): string {
  const head = judged
    ? correct
      ? '✅ 意思表达出来了'
      : '❌ 这句还不对'
    // 判定できなかったときに「間違い」と言わない。判定していないだけ。
    : '📝 这次没能判分，先看参考句';
  const lines = [head, '', `参考：${reference}`];
  if (note.trim() !== '') lines.push('', note.trim());
  return lines.join('\n');
}

/* ─────────────── 分野別語彙（商务谈判 / 高尔夫 / AI） ─────────────── */

export interface DomainOverviewRow {
  readonly domain: { id: string; name: string };
  readonly introduced: number;
  readonly total: number;
  readonly due: number;
}

/**
 * 分野の一覧。
 *
 * 主線（仮名 → N5 → N4）とは別の線であることを明示する。混ぜて考えると
 * 「どっちを先にやるのか」が分からなくなる。
 */
export function renderDomainList(rows: readonly DomainOverviewRow[]): string {
  const lines = ['🗂 专业词汇', '', '和主线（五十音 → N5 → N4）分开计算。', ''];
  for (const row of rows) {
    const due = row.due > 0 ? `　待复习 ${String(row.due)}` : '';
    lines.push(
      `${row.domain.name}　${String(row.introduced)}/${String(row.total)}${due}`,
    );
  }
  lines.push('', '选一个开始。');
  return lines.join('\n');
}

/** 新しい分野語のカード。読みは必ず添える（読めない字は覚えようが無い）。 */
export function renderDomainCard(
  entry: { expression: string; reading: string; meaning: string },
  index: number,
  total: number,
): string {
  const lines = [`${String(index)}/${String(total)}`, '', entry.expression];
  if (entry.reading !== entry.expression) lines.push(`　${entry.reading}`);
  lines.push('', entry.meaning);
  return lines.join('\n');
}

export function renderDomainQuestion(question: {
  kind: 'WORD_TO_MEANING' | 'MEANING_TO_WORD';
  prompt: string;
  promptReading?: string;
}): string {
  if (question.kind === 'MEANING_TO_WORD') {
    return `哪个词是「${question.prompt}」？`;
  }
  const reading =
    question.promptReading === undefined ? '' : `\n　${question.promptReading}`;
  return `这个词是什么意思？\n\n${question.prompt}${reading}`;
}

export function renderDomainCorrect(entry: {
  expression: string;
  reading: string;
  meaning: string;
}): string {
  const reading =
    entry.reading === entry.expression ? '' : `（${entry.reading}）`;
  return `✅ ${entry.expression}${reading} = ${entry.meaning}`;
}

export function renderDomainWrong(
  target: { expression: string; reading: string; meaning: string },
  chosen: { expression: string; meaning: string } | undefined,
): string {
  const reading =
    target.reading === target.expression ? '' : `（${target.reading}）`;
  const lines = [
    `❌ 正确答案是 ${target.expression}${reading} — ${target.meaning}`,
  ];
  if (chosen !== undefined && chosen.expression !== target.expression) {
    lines.push(`你选的 ${chosen.expression} 是「${chosen.meaning}」`);
  }
  return lines.join('\n');
}
