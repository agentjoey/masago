import { KANA_BY_ID } from '../curriculum/kana.js';
import {
  renderCorrect,
  renderDrillFinished,
  renderProgress,
  renderQuestion,
  renderTeachingCard,
  renderToday,
  renderWrong,
} from '../curriculum/render.js';
import type { Random } from '../curriculum/quiz.js';
import type { Executor } from '../db/repositories/executor.js';
import * as learnerProfiles from '../db/repositories/learnerProfiles.js';
import * as reviewQueue from '../db/repositories/reviewQueue.js';
import {
  decodeAnswer,
  encodeAnswer,
  gradeAndRecord,
  gradeTypedAndRecord,
  nextDrillQuestion,
  targetOfQuestionText,
} from './kanaDrill.js';
import { introduceKana, planKanaLesson } from './kanaSession.js';

/**
 * 仮名学習のコマンド層。
 *
 * Telegram の API はここでは呼ばない。返すのは「何を出すか」だけで、
 * どう送るかは telegram/ の仕事——境界を跨ぐと、テストのたびに
 * Bot を立てる羽目になる（INTERFACES.md §1）。
 */

export interface KanaButton {
  readonly label: string;
  readonly data: string;
}

export interface KanaReply {
  readonly text: string;
  readonly buttons?: readonly KanaButton[];
  /** 送るべき仮名音声の id。発音を教えるのは音でしかできない。 */
  readonly audioKanaId?: string;
  /**
   * 返信で答えてもらう問題か。Telegram の ForceReply を付ける目印。
   *
   * 返信にしておくと「どの問題への答えか」が返信元から辿れる。
   * 直前の問題を覚えておく必要が無く、途中で他の操作を挟まれても
   * 取り違えない。
   */
  readonly expectsReply?: boolean;
}

export interface KanaCommands {
  today(telegramUserId: number): Promise<KanaReply[]>;
  drill(telegramUserId: number): Promise<KanaReply[]>;
  review(telegramUserId: number): Promise<KanaReply[]>;
  progress(telegramUserId: number): Promise<KanaReply[]>;
  answer(
    telegramUserId: number,
    callbackData: string,
    askedAt: Date | undefined,
  ): Promise<KanaReply[]>;
  /**
   * 打ち込みの答え。`questionText` は返信元の本文で、そこから
   * 何を訊いたかを復元する。
   */
  answerTyped(
    telegramUserId: number,
    questionText: string,
    typed: string,
    askedAt: Date | undefined,
  ): Promise<KanaReply[] | undefined>;
}

export interface KanaCommandDeps {
  readonly executor: Executor;
  readonly now: () => Date;
  readonly random: Random;
  readonly requestRetention: number;
  readonly optionCount: number;
  readonly newPerDay: number;
  readonly maxReviews: number;
  readonly backlogThreshold: number;
}

const NOT_REGISTERED =
  '还没有你的学习档案。先发一句话跟我打个招呼，我来建。';

export function createKanaCommands(deps: KanaCommandDeps): KanaCommands {
  const { executor } = deps;

  const lessonOptions = {
    newPerDay: deps.newPerDay,
    maxReviews: deps.maxReviews,
    backlogThreshold: deps.backlogThreshold,
  };

  async function learnerIdOf(
    telegramUserId: number,
  ): Promise<string | undefined> {
    const learner = await learnerProfiles.findByTelegramUserId(
      executor,
      telegramUserId,
    );
    return learner?.id;
  }

  /**
   * 出題から解答までの実測。負や桁外れは計測失敗として捨てる
   * ——時計のずれを「一瞬で答えた」と読むと難易度推定が壊れる。
   */
  function responseMsOf(askedAt: Date | undefined, now: Date): number | undefined {
    if (askedAt === undefined) return undefined;
    const elapsed = now.getTime() - askedAt.getTime();
    return elapsed >= 0 && elapsed < 600_000 ? elapsed : undefined;
  }

  /** 次の一問。無ければ締めの一言。 */
  async function askNext(
    learnerId: string,
    now: Date,
    answered: number,
  ): Promise<KanaReply[]> {
    const next = await nextDrillQuestion(executor, learnerId, now, {
      optionCount: deps.optionCount,
      random: deps.random,
    });
    if (next === undefined) {
      return [{ text: renderDrillFinished(answered) }];
    }
    if (next.typed) {
      // 選択肢を出さない。四択は消去法で当たるので、打てて初めて
      // 「覚えた」に近づく（§4.3 第二段）。
      return [{ text: renderQuestion(next.question, true), expectsReply: true }];
    }
    return [
      {
        text: renderQuestion(next.question),
        buttons: next.question.options.map((option) => ({
          label: option.label,
          data: encodeAnswer(
            next.question.targetId,
            option.kanaId,
            next.question.kind,
          ),
        })),
      },
    ];
  }

  return {
    async today(telegramUserId) {
      const learnerId = await learnerIdOf(telegramUserId);
      if (learnerId === undefined) return [{ text: NOT_REGISTERED }];
      const now = deps.now();
      const lesson = await planKanaLesson(
        executor,
        learnerId,
        now,
        lessonOptions,
      );
      return [
        {
          text: renderToday({
            newKana: lesson.newKana,
            reviewCount: lesson.dueTotal,
            newHeldBackForBacklog: lesson.newHeldBackForBacklog,
            progress: lesson.progress,
          }),
        },
      ];
    },

    async drill(telegramUserId) {
      const learnerId = await learnerIdOf(telegramUserId);
      if (learnerId === undefined) return [{ text: NOT_REGISTERED }];
      const now = deps.now();

      const lesson = await planKanaLesson(
        executor,
        learnerId,
        now,
        lessonOptions,
      );

      const replies: KanaReply[] = [];

      if (lesson.newKana.length > 0) {
        // 先に教えてから出題する。教える前に訊くのは当て物でしかない。
        lesson.newKana.forEach((kana, index) => {
          replies.push({
            text: renderTeachingCard(
              kana,
              index + 1,
              lesson.newKana.length,
            ),
            audioKanaId: kana.id,
          });
        });
        await introduceKana(
          executor,
          learnerId,
          lesson.newKana.map((kana) => kana.id),
          now,
        );
      }

      replies.push(...(await askNext(learnerId, now, 0)));
      return replies;
    },

    async review(telegramUserId) {
      const learnerId = await learnerIdOf(telegramUserId);
      if (learnerId === undefined) return [{ text: NOT_REGISTERED }];
      // 新出は入れない。復習だけしたい日のための入り口。
      return askNext(learnerId, deps.now(), 0);
    },

    async progress(telegramUserId) {
      const learnerId = await learnerIdOf(telegramUserId);
      if (learnerId === undefined) return [{ text: NOT_REGISTERED }];
      const now = deps.now();
      const lesson = await planKanaLesson(
        executor,
        learnerId,
        now,
        lessonOptions,
      );
      const mastered = await reviewQueue.countMastered(
        executor,
        learnerId,
        'KANA',
      );
      return [
        {
          text: renderProgress({
            introduced: lesson.progress.introduced,
            total: lesson.progress.total,
            dueNow: lesson.dueTotal,
            mastered,
          }),
        },
      ];
    },

    async answer(telegramUserId, callbackData, askedAt) {
      const learnerId = await learnerIdOf(telegramUserId);
      if (learnerId === undefined) return [{ text: NOT_REGISTERED }];

      const decoded = decodeAnswer(callbackData);
      if (decoded === undefined) {
        // 古いメッセージのボタンを押した場合など。黙って落とさない。
        return [{ text: '这道题已经过期了，发 /kana 继续。' }];
      }

      const now = deps.now();
      const graded = await gradeAndRecord(
        executor,
        learnerId,
        decoded.targetId,
        decoded.chosenId,
        decoded.kind,
        now,
        deps.requestRetention,
        responseMsOf(askedAt, now),
      );

      const feedback: KanaReply = graded.correct
        ? { text: renderCorrect(graded.target) }
        : {
            text: renderWrong(graded.target, graded.chosen),
            // 間違えた字は音でも確かめさせる。
            audioKanaId: graded.target.id,
          };

      return [feedback, ...(await askNext(learnerId, now, 1))];
    },

    async answerTyped(telegramUserId, questionText, typed, askedAt) {
      // 返信元が出題でなければ、これは答えではなく普通の会話。
      // undefined を返して、呼び出し側に通常の経路へ渡させる。
      const targetId = targetOfQuestionText(questionText);
      if (targetId === undefined) return undefined;

      const learnerId = await learnerIdOf(telegramUserId);
      if (learnerId === undefined) return [{ text: NOT_REGISTERED }];

      const now = deps.now();
      const graded = await gradeTypedAndRecord(
        executor,
        learnerId,
        targetId,
        typed,
        now,
        deps.requestRetention,
        responseMsOf(askedAt, now),
      );

      const feedback: KanaReply = graded.correct
        ? { text: renderCorrect(graded.target) }
        : {
            text: renderWrong(graded.target, undefined, typed),
            audioKanaId: graded.target.id,
          };

      return [feedback, ...(await askNext(learnerId, now, 1))];
    },
  };
}

/** 音声ファイル名。呼び出し側が音库ディレクトリと繋いで使う。 */
export function kanaAudioFileName(kanaId: string): string | undefined {
  return KANA_BY_ID.has(kanaId) ? `${kanaId}.mp3` : undefined;
}
