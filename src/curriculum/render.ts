/**
 * 学習者に見せる文面（V2 §4：文字中心）。
 *
 * 説明は中国語。ゼロから始める人に日本語で案内文を書いても読めない——
 * 教える対象の日本語と、操作を説明する言葉は分ける。
 */
import type { Kana } from './kana.js';
import type { QuizQuestion } from './quiz.js';

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

export function renderQuestion(question: QuizQuestion): string {
  switch (question.kind) {
    case 'GLYPH_TO_ROMAJI':
      return `这个假名怎么读？\n\n${question.prompt}`;
    case 'ROMAJI_TO_GLYPH':
      return `哪个是 ${question.prompt}？`;
    case 'AUDIO_TO_GLYPH':
      return '听到的是哪个假名？';
  }
}

export function renderCorrect(kana: Kana): string {
  return `✅ ${kana.hiragana} = ${kana.romaji}`;
}

export function renderWrong(target: Kana, chosen: Kana | undefined): string {
  const lines = [`❌ 正确答案是 ${target.hiragana}（${target.romaji}）`];
  if (chosen !== undefined && chosen.id !== target.id) {
    lines.push(`你选的 ${chosen.hiragana} 读作 ${chosen.romaji}`);
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

export function renderProgress(view: ProgressView): string {
  const pct =
    view.total === 0 ? 0 : Math.round((view.introduced / view.total) * 100);
  const filled = Math.round(pct / 5);
  const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
  return [
    '📊 五十音进度',
    '',
    `${bar} ${String(pct)}%`,
    `已学 ${String(view.introduced)}/${String(view.total)}`,
    `已掌握 ${String(view.mastered)}`,
    `待复习 ${String(view.dueNow)}`,
  ].join('\n');
}
