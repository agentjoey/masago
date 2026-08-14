/**
 * 週報・月報の文面（V1.5）。純粋関数——数字は呼び出し側が集める。
 *
 * 振り返りの値打ちは「やった量」ではなく**次に何をするか**が決まること。
 * だから「今週 120 題」より「を と が が 7 回混ざった」を上に置く。
 * 前者は気分の話で、後者は明日の行動が変わる。
 *
 * 何も無い週は送らない。用の無い通知は、通知を無視する習慣を育てる
 * （日次リマインダと同じ考え方）。
 */

export type ReportPeriod = 'WEEK' | 'MONTH';

export interface ReportTrouble {
  /** 学習者に見せる形（仮名なら字、語なら表記、助詞なら助詞そのもの）。 */
  readonly label: string;
  /** 添える一行（読みや意味）。無ければ空。 */
  readonly hint: string;
  readonly failures: number;
}

export interface ReportFacts {
  readonly period: ReportPeriod;
  /** 期間の呼び名（"8月8日 - 8月14日" など）。 */
  readonly span: string;
  readonly answered: number;
  readonly correct: number;
  readonly introduced: number;
  /** 学習した日数。 */
  readonly activeDays: number;
  readonly streak: number;
  readonly troubles: readonly ReportTrouble[];
  /** 期末時点の進度。 */
  readonly progress: {
    readonly kana: { introduced: number; total: number };
    readonly vocab: { introduced: number; total: number };
    readonly grammar: { introduced: number; total: number };
  };
  readonly dueNow: number;
  /** 前の期間の回答数。比較を出すのに使う。無ければ比較しない。 */
  readonly previousAnswered?: number;
}

export type ReportDecision =
  | { readonly send: false; readonly reason: 'NOTHING_HAPPENED' }
  | { readonly send: true; readonly text: string };

const TITLE: Record<ReportPeriod, string> = {
  WEEK: '📅 本周小结',
  MONTH: '🗓 本月小结',
};

const UNIT: Record<ReportPeriod, string> = { WEEK: '周', MONTH: '月' };

function accuracyLine(answered: number, correct: number): string {
  if (answered === 0) return '';
  const rate = Math.round((correct / answered) * 100);
  return `正确率 ${String(rate)}%`;
}

/**
 * 前期との比較。
 *
 * 「増えた/減った」だけを出す。パーセントにすると、5 題が 10 題になった
 * だけで「+100%」と出て、実態より大げさになる。
 */
function trendLine(
  facts: ReportFacts,
): string | undefined {
  const previous = facts.previousAnswered;
  // 前の期間が丸ごと空なら比べない。始めたばかりの人に
  // 「比上周多做了 12 题」と出しても、比べる相手が無い。
  if (previous === undefined || previous === 0) return undefined;
  const diff = facts.answered - previous;
  if (diff === 0) return `与上${UNIT[facts.period]}持平`;
  const unit = UNIT[facts.period];
  return diff > 0
    ? `比上${unit}多做了 ${String(diff)} 题`
    : `比上${unit}少做了 ${String(-diff)} 题`;
}

export function decideReport(facts: ReportFacts): ReportDecision {
  // 一題もやっていない期間に「今週の成果」を送らない。
  if (facts.answered === 0 && facts.introduced === 0) {
    return { send: false, reason: 'NOTHING_HAPPENED' };
  }

  const lines: string[] = [TITLE[facts.period], facts.span, ''];

  const done = [`做了 ${String(facts.answered)} 题`];
  const accuracy = accuracyLine(facts.answered, facts.correct);
  if (accuracy !== '') done.push(accuracy);
  lines.push(done.join('　'));

  const rhythm = [`学习 ${String(facts.activeDays)} 天`];
  if (facts.streak > 1) rhythm.push(`连续 ${String(facts.streak)} 天 🔥`);
  lines.push(rhythm.join('　'));

  const trend = trendLine(facts);
  if (trend !== undefined) lines.push(trend);

  if (facts.introduced > 0) {
    lines.push(`新学 ${String(facts.introduced)} 项`);
  }

  // いちばん役に立つ行を、数字より下・案内より上に置く。
  if (facts.troubles.length > 0) {
    lines.push('', '这些还不稳：');
    for (const trouble of facts.troubles) {
      const hint = trouble.hint === '' ? '' : `（${trouble.hint}）`;
      lines.push(`　${trouble.label}${hint}错了 ${String(trouble.failures)} 次`);
    }
  }

  lines.push(
    '',
    `进度　五十音 ${String(facts.progress.kana.introduced)}/${String(facts.progress.kana.total)}` +
      `　单词 ${String(facts.progress.vocab.introduced)}/${String(facts.progress.vocab.total)}` +
      `　助词 ${String(facts.progress.grammar.introduced)}/${String(facts.progress.grammar.total)}`,
  );

  if (facts.dueNow > 0) {
    lines.push('', `现在有 ${String(facts.dueNow)} 项到期，发 /review 追平。`);
  } else {
    lines.push('', '目前没有到期的复习。发 /today 看安排。');
  }

  return { send: true, text: lines.join('\n') };
}

/** "8月8日 - 8月14日"。年は跨いだときだけ出す。 */
export function spanLabel(since: Date, until: Date, timeZone: string): string {
  const format = (date: Date, withYear: boolean): string => {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      ...(withYear ? { year: 'numeric' as const } : {}),
      month: 'numeric',
      day: 'numeric',
    }).formatToParts(date);
    const value = (type: string): string =>
      parts.find((part) => part.type === type)?.value ?? '';
    const base = `${value('month')}月${value('day')}日`;
    return withYear ? `${value('year')}年${base}` : base;
  };
  const yearOf = (date: Date): string =>
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).format(date);
  const crossesYear = yearOf(since) !== yearOf(until);
  return `${format(since, crossesYear)} - ${format(until, crossesYear)}`;
}
