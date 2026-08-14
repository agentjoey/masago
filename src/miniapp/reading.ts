import { toRubySegments, type RubySegment } from '../curriculum/furigana.js';
import type { Random } from '../curriculum/quiz.js';
import type { Sentence } from '../curriculum/sentences.js';
import type { Executor } from '../db/repositories/executor.js';
import { SCENES } from '../curriculum/scenes.js';
import {
  buildReadingQuestion,
  gradeReading,
  knownWords,
} from '../learning/readingSession.js';

/**
 * Mini App の読解（V3 / docs/scenario-learning.md §5 読）。
 *
 * **ここが Mini App の主目的**。Telegram のメッセージは ruby を出せないので、
 * これまで「見(み)ました」と括弧で添えるしかなかった（§4.2）。普通の Web
 * ページなら `<ruby>` が使えて、漢字の上に読みが乗る——本の振り仮名と
 * 同じ見え方になる。
 *
 * 段は三つ。四つ目（文についての設問に答える）は、設問を作る出所が
 * 無いので置かない——模型に作らせれば書けるが、それは §8 が禁じている
 * 「事実を現場で作る」に当たる。
 */

export type RubyLevel =
  /** 漢字すべてに読みを振る。読めない字が一つも無い状態。 */
  | 'ALL'
  /** 未習の語にだけ振る。既に習った語は自力で読む。 */
  | 'UNKNOWN'
  /** 振らない。 */
  | 'NONE';

export interface ReadingSegment {
  readonly text: string;
  readonly ruby: string | null;
}

export interface ReadingOption {
  readonly id: string;
  readonly label: string;
}

export interface ReadingPayload {
  readonly sentenceId: string;
  /** ruby を組むための区間。段ごとに読みの有無が変わる。 */
  readonly segments: readonly ReadingSegment[];
  readonly options: readonly ReadingOption[];
  readonly level: RubyLevel;
  /** 未習の語がいくつ混ざっているか。 */
  readonly unknown: number;
  /** 選べる場面の一覧。前端が並べる。 */
  readonly scenes: readonly { id: string; name: string }[];
  readonly sceneId: string | null;
}

export function readingSegments(
  sentence: Sentence,
  level: RubyLevel,
  known: ReadonlySet<string>,
): ReadingSegment[] {
  if (level === 'NONE') {
    return [{ text: sentence.text, ruby: null }];
  }
  const tokens = sentence.tokens.map((token) => ({
    surface: token.s,
    // 既習の語には振らない段では、読みを渡さないことで ruby を落とす。
    // 出力側で消すのではなく入力で落とす——`assignRuby` は読みが
    // 合わないと何も振らないので、判断を一箇所に寄せておく。
    reading:
      level === 'ALL' || !known.has(token.s) ? token.r : undefined,
  }));
  return toRubySegments(tokens).map(toReadingSegment);
}

function toReadingSegment(segment: RubySegment): ReadingSegment {
  return { text: segment.text, ruby: segment.ruby ?? null };
}

export interface LoadReadingOptions {
  readonly optionCount: number;
  readonly random: Random;
  readonly level: RubyLevel;
  /** 場面で絞る。未指定なら全部から。 */
  readonly sceneId?: string;
}

export async function loadReading(
  tx: Executor,
  learnerId: string,
  options: LoadReadingOptions,
): Promise<ReadingPayload | null> {
  const known = await knownWords(tx, learnerId);
  const next = buildReadingQuestion(known, {
    optionCount: options.optionCount,
    random: options.random,
    // Mini App では常に日本語を読ませる。意味から日本語を選ぶ向きは
    // 読む練習ではないので、こちらには置かない。
    kind: 'JA_TO_ZH',
    ...(options.sceneId === undefined ? {} : { sceneId: options.sceneId }),
  });
  if (next === undefined) return null;

  return {
    sentenceId: next.sentence.id,
    segments: readingSegments(next.sentence, options.level, known),
    options: next.question.options.map((option) => ({
      id: option.sentenceId,
      label: option.label,
    })),
    level: options.level,
    unknown: next.unknown,
    scenes: SCENES.map((scene) => ({ id: scene.id, name: scene.name })),
    sceneId: options.sceneId ?? null,
  };
}

export interface ReadingVerdict {
  readonly correct: boolean;
  /** 正解の意味。間違えたときに見せる。 */
  readonly answer: string;
  readonly text: string;
}

/**
 * 採点は後端で行う。
 *
 * 正解を payload に載せて前端で判定させると、開発者ツールで見えてしまう。
 * 自分をごまかすだけとはいえ、見えるものは見てしまう。
 */
export function judgeReading(
  targetId: string,
  chosenId: string,
): ReadingVerdict | null {
  const graded = gradeReading({ targetId, chosenId });
  if (graded === undefined) return null;
  return {
    correct: graded.correct,
    answer: graded.target.zh ?? '',
    text: graded.target.text,
  };
}
