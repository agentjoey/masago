/** 語彙データの型。生成物（vocabN5.ts / vocabN4.ts）が参照する。 */

export type JlptLevel = 'N5' | 'N4';

export interface VocabEntry {
  /** `表記#読み` で一意。同表記異読を別語として扱うため。 */
  readonly id: string;
  readonly level: JlptLevel;
  readonly expression: string;
  /** 仮名だけの主たる読み。振り仮名と音声合成に使う。 */
  readonly reading: string;
  /** 出典の読み表記（「いく; ゆく」「～えん」など）。 */
  readonly displayReading?: string;
  /** 出典どおりの英語の語義。 */
  readonly meaning: string;
  /** Genki の課。無い語はその等級の補遺。 */
  readonly genkiLesson?: number;
  /** 接辞（～円、～時）。単独の語として出題しない。 */
  readonly isAffix?: boolean;
}
