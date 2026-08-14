import { KANA_BY_ID, kanaOfKey } from '../curriculum/kana.js';
import {
  renderCorrect,
  renderActivity,
  renderCompositionQuestion,
  renderCompositionResult,
  renderCost,
  renderDaily,
  renderDrillFinished,
  renderFullProgress,
  renderParticleCard,
  renderParticleCorrect,
  renderParticleQuestion,
  renderParticleWrong,
  renderQuestion,
  renderReadingCorrect,
  renderReadingQuestion,
  renderReadingWrong,
  renderTeachingCard,
  renderVocabCard,
  renderVocabCorrect,
  renderVocabQuestion,
  renderVocabWrong,
  renderWelcome,
  renderWordOrderQuestion,
  renderWordOrderResult,
  renderWritingIntro,
  renderWrong,
  type CostView,
} from '../curriculum/render.js';
import type { Random } from '../curriculum/quiz.js';
import { vocabOfKey } from '../curriculum/vocab.js';
import type { Executor } from '../db/repositories/executor.js';
import * as learnerProfiles from '../db/repositories/learnerProfiles.js';
import * as reviewQueue from '../db/repositories/reviewQueue.js';
import {
  decodeAnswer,
  decodeVocabAnswer,
  encodeAnswer,
  encodeVocabAnswer,
  gradeAndRecord,
  gradeTypedAndRecord,
  nextDrillQuestion,
  targetOfQuestionText,
  targetOfVocabQuestionText,
} from './kanaDrill.js';
import { remainingNewToday as remainingNewTodayOf } from './dailyCap.js';
import { introduceKana, planKanaLesson } from './kanaSession.js';
import {
  gradeVocabChoice,
  gradeVocabTyped,
  introduceVocab,
  nextVocabQuestion,
  planVocabSession,
} from './vocabSession.js';
import {
  gradeComposition,
  nextCompositionQuestion,
  sentenceOfCompositionQuestion,
  type JudgeDeps,
} from './compositionSession.js';
import {
  decodeReadingAnswer,
  encodeReadingAnswer,
  gradeReading,
  knownWords,
  nextReadingQuestion,
  readingKindFor,
} from './readingSession.js';
import {
  decodeParticleAnswer,
  encodeParticleAnswer,
  gradeParticle,
  gradeWordOrder,
  introduceParticles,
  nextWritingQuestion,
  planWritingSession,
  sentenceOfOrderQuestion,
  type WritingQuestion,
} from './writingSession.js';

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
  /**
   * 読み上げてほしい日本語。仮名は事前生成の音库で足りるが、
   * 単語は数が多く合成が要る。二度目からは file_id で送るので費用は一度きり。
   */
  readonly speakText?: string;
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
  /** S1：単語の練習。 */
  vocab(telegramUserId: number): Promise<KanaReply[]>;
  /** 書く練習：助詞の穴埋めと語順の並べ替え。 */
  write(telegramUserId: number): Promise<KanaReply[]>;
  /** 読む練習：文の意味を四択で選ぶ。 */
  read(telegramUserId: number): Promise<KanaReply[]>;
  /** 中訳日：中国語を見て日本語を書く。 */
  compose(telegramUserId: number): Promise<KanaReply[]>;
  /** 用量と費用。 */
  cost(telegramUserId: number): Promise<KanaReply[]>;
  /** 直近に答えた項目の解説。 */
  explain(telegramUserId: number): Promise<KanaReply[]>;
  /** 初回の案内。学習者の記録もここで作る。 */
  start(telegramUserId: number): Promise<KanaReply[]>;
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
  /**
   * 学習者の地域時間での「その日の 0 時」。一日の新出上限を数えるのに要る。
   * 省略すると上限は一回あたりの数として働く（従来の挙動）。
   */
  readonly dayStart?: (now: Date) => Date;
  /** 費用の集計。DB とタイムゾーンは呼び出し側が閉じ込める。 */
  readonly costSummary?: (now: Date) => Promise<CostView>;
  /** 直近一週間の活動。無ければ /progress は進度だけを出す。 */
  readonly activity?: (
    learnerId: string,
    now: Date,
  ) => Promise<{ days: { day: string; count: number }[]; streak: number }>;
  readonly dailyLimitUsd: number;
  readonly monthlyLimitUsd: number;
  /**
   * 作文の判定。規則で決められなかった分だけここへ来る。
   * 無ければ /compose は規則層までで止まる。
   */
  readonly judgeWriting?: JudgeDeps;
  /** 解説の生成。無ければ /explain は「未启用」と答える。 */
  readonly explainItem?: (target: {
    subject: string;
    reading?: string;
    meaning?: string;
  }) => Promise<string>;
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

  /** 今日まだ出してよい新出の数。数え方は dailyCap.ts に一本化。 */
  function remainingNewToday(
    learnerId: string,
    now: Date,
    type: 'KANA' | 'VOCABULARY' | 'GRAMMAR',
  ): Promise<number> {
    return remainingNewTodayOf(executor, learnerId, now, type, {
      newPerDay: deps.newPerDay,
      ...(deps.dayStart === undefined ? {} : { dayStart: deps.dayStart }),
    });
  }

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

  /** 単語の次の一問。 */
  async function askNextVocab(
    learnerId: string,
    now: Date,
    answered: number,
  ): Promise<KanaReply[]> {
    const next = await nextVocabQuestion(executor, learnerId, now, {
      optionCount: deps.optionCount,
      random: deps.random,
    });
    if (next === undefined) {
      return [{ text: renderDrillFinished(answered) }];
    }
    if (next.typed) {
      return [
        { text: renderVocabQuestion(next.question, true), expectsReply: true },
      ];
    }
    return [
      {
        text: renderVocabQuestion(next.question),
        buttons: next.question.options.map((option) => ({
          label: option.label,
          data: encodeVocabAnswer(next.question.targetId, option.vocabId),
        })),
      },
    ];
  }

  /** 書く練習の次の一問。 */
  function toWritingReply(question: WritingQuestion): KanaReply {
    if (question.kind === 'PARTICLE' && question.blankAt !== undefined) {
      return {
        text: renderParticleQuestion(question.prompt),
        buttons: question.options.map((option) => ({
          label: option,
          data: encodeParticleAnswer(
            question.sentenceId,
            question.blankAt ?? 0,
            option,
          ),
        })),
      };
    }
    // 語順は打って答えてもらう。返信元の本文から、どの文を訊いたかが
    // 断片の顔ぶれで辿れるので、出題を覚えておかずに済む。
    return {
      text: renderWordOrderQuestion(question.pieces),
      expectsReply: true,
    };
  }

  async function askNextWriting(
    learnerId: string,
    now: Date,
    answered: number,
  ): Promise<KanaReply[]> {
    const next = await nextWritingQuestion(executor, learnerId, now, {
      optionCount: deps.optionCount,
      random: deps.random,
    });
    if (next === undefined) return [{ text: renderDrillFinished(answered) }];
    return [toWritingReply(next)];
  }

  async function askNextReading(
    learnerId: string,
    answered: number,
  ): Promise<KanaReply[]> {
    const next = await nextReadingQuestion(executor, learnerId, {
      optionCount: deps.optionCount,
      random: deps.random,
      // 向きは乱数で決める。answered を渡していた頃は二問目以降が
      // 全部 JA_TO_ZH に固定されていた（呼び出し側が定数 1 を渡していた）。
      kind: readingKindFor(deps.random()),
    });
    if (next === undefined) return [{ text: renderDrillFinished(answered) }];
    return [
      {
        text: renderReadingQuestion(next.question),
        buttons: next.question.options.map((option) => ({
          label: option.label,
          data: encodeReadingAnswer(
            next.question.targetId,
            option.sentenceId,
          ),
        })),
        // 日本語を見せる向きのときだけ読み上げる。中国語から選ばせる
        // 問題で日本語を先に流すと、答えを言ってしまう。
        ...(next.question.kind === 'JA_TO_ZH'
          ? { speakText: next.sentence.text }
          : {}),
      },
    ];
  }

  /**
   * 中訳日の次の一問。
   *
   * 既習の語だけで書ける文を選ぶ。読解と違い、作文は知らない語が
   * 一つあると手が止まる。
   */
  async function askNextComposition(learnerId: string): Promise<KanaReply[]> {
    const known = await knownWords(executor, learnerId);
    const question = nextCompositionQuestion({ random: deps.random, known });
    if (question === undefined) {
      return [{ text: '现在还没有可以写的句子。先发 /vocab 学一些单词。' }];
    }
    return [
      {
        text: renderCompositionQuestion(question.meaning),
        expectsReply: true,
      },
    ];
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
      // 仮名が片付いたら単語へ。両方無ければ締める。
      return askNextVocab(learnerId, now, answered);
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
      const kana = await planKanaLesson(executor, learnerId, now, {
        ...lessonOptions,
        newPerDay: await remainingNewToday(learnerId, now, 'KANA'),
      });
      const vocab = await planVocabSession(executor, learnerId, now, {
        ...lessonOptions,
        newPerDay: await remainingNewToday(learnerId, now, 'VOCABULARY'),
      });
      return [
        {
          text: renderDaily({
            stage: vocab.stage,
            newKana: kana.newKana,
            kanaDue: kana.dueTotal,
            newWords: vocab.newWords,
            vocabDue: vocab.dueTotal,
            kanaProgress: kana.progress,
            vocabProgress: vocab.progress,
            heldBack: kana.newHeldBackForBacklog || vocab.newHeldBackForBacklog,
          }),
        },
      ];
    },

    async drill(telegramUserId) {
      const learnerId = await learnerIdOf(telegramUserId);
      if (learnerId === undefined) return [{ text: NOT_REGISTERED }];
      const now = deps.now();

      const lesson = await planKanaLesson(executor, learnerId, now, {
        ...lessonOptions,
        newPerDay: await remainingNewToday(learnerId, now, 'KANA'),
      });

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
      const kana = await planKanaLesson(executor, learnerId, now, lessonOptions);
      const vocab = await planVocabSession(
        executor,
        learnerId,
        now,
        lessonOptions,
      );
      const masteredKana = await reviewQueue.countMastered(
        executor,
        learnerId,
        'KANA',
      );
      const masteredVocab = await reviewQueue.countMastered(
        executor,
        learnerId,
        'VOCABULARY',
      );
      const activity =
        deps.activity === undefined
          ? undefined
          : await deps.activity(learnerId, now);

      const progressText = renderFullProgress({
        kana: {
          introduced: kana.progress.introduced,
          total: kana.progress.total,
          dueNow: kana.dueTotal,
          mastered: masteredKana,
        },
        vocab: {
          introduced: vocab.progress.introduced,
          total: vocab.progress.total,
          dueNow: vocab.dueTotal,
          mastered: masteredVocab,
        },
        // 語彙を始めていない段階で総数を突きつけない。
        showVocab: vocab.stage !== 'S0_KANA_ONLY',
        vocabLevel: vocab.level,
        levelProgress: vocab.levelProgress,
      });

      return [
        {
          text:
            activity === undefined
              ? progressText
              : `${progressText}\n\n${renderActivity(activity)}`,
        },
      ];
    },

    async answer(telegramUserId, callbackData, askedAt) {
      const learnerId = await learnerIdOf(telegramUserId);
      if (learnerId === undefined) return [{ text: NOT_REGISTERED }];

      const now = deps.now();

      // 読解の回答。
      const readingAnswer = decodeReadingAnswer(callbackData);
      if (readingAnswer !== undefined) {
        const graded = gradeReading(readingAnswer);
        if (graded === undefined) {
          return [{ text: '这道题已经过期了，发 /read 继续。' }];
        }
        const zh = graded.target.zh ?? '';
        const feedback: KanaReply = graded.correct
          ? {
              text: renderReadingCorrect(graded.target.text, zh),
              speakText: graded.target.text,
            }
          : {
              text: renderReadingWrong(
                graded.target.text,
                zh,
                graded.chosen?.text,
              ),
              speakText: graded.target.text,
            };
        return [feedback, ...(await askNextReading(learnerId, 1))];
      }

      // 助詞の回答。仮名・単語とは別の接頭辞で先に分ける。
      const particleAnswer = decodeParticleAnswer(callbackData);
      if (particleAnswer !== undefined) {
        const graded = await gradeParticle(
          executor,
          learnerId,
          particleAnswer,
          now,
          deps.requestRetention,
          responseMsOf(askedAt, now),
        );
        if (graded === undefined) {
          return [{ text: '这道题已经过期了，发 /write 继续。' }];
        }
        const feedback: KanaReply = graded.correct
          ? {
              text: renderParticleCorrect(graded.answer, graded.full),
              // 正解の文をそのまま聞かせる。助詞は文の中でしか
              // 音の感じがつかめない。
              speakText: graded.full,
            }
          : {
              text: renderParticleWrong(
                graded.answer,
                graded.chosen,
                graded.full,
              ),
              speakText: graded.full,
            };
        return [feedback, ...(await askNextWriting(learnerId, now, 1))];
      }

      // 単語の回答は別の接頭辞。仮名として採点しないよう先に分ける。
      const vocabAnswer = decodeVocabAnswer(callbackData);
      if (vocabAnswer !== undefined) {
        const gradedVocab = await gradeVocabChoice(
          executor,
          learnerId,
          vocabAnswer.targetId,
          vocabAnswer.chosenId,
          now,
          deps.requestRetention,
          responseMsOf(askedAt, now),
        );
        const vocabFeedback: KanaReply = gradedVocab.correct
          ? { text: renderVocabCorrect(gradedVocab.target) }
          : {
              text: renderVocabWrong(gradedVocab.target, gradedVocab.chosen),
              speakText: gradedVocab.target.reading,
            };
        return [
          vocabFeedback,
          ...(await askNextVocab(learnerId, now, 1)),
        ];
      }

      const decoded = decodeAnswer(callbackData);
      if (decoded === undefined) {
        // 古いメッセージのボタンを押した場合など。黙って落とさない。
        return [{ text: '这道题已经过期了，发 /kana 继续。' }];
      }

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

    async cost() {
      if (deps.costSummary === undefined) {
        return [{ text: '成本统计尚未启用。' }];
      }
      return [{ text: renderCost(await deps.costSummary(deps.now())) }];
    },

    async start(telegramUserId) {
      // ここで記録を作る。Telegram は bot を開いた時点で /start を送るので、
      // ここを通らないと「先に一言送ってください」から始まることになる。
      const existing = await learnerProfiles.findByTelegramUserId(
        executor,
        telegramUserId,
      );
      if (existing === undefined) {
        await learnerProfiles.upsert(executor, { telegramUserId });
      }
      return [{ text: renderWelcome(existing !== undefined) }];
    },

    async explain(telegramUserId) {
      const learnerId = await learnerIdOf(telegramUserId);
      if (learnerId === undefined) return [{ text: NOT_REGISTERED }];
      if (deps.explainItem === undefined) {
        return [{ text: '讲解功能尚未启用。' }];
      }

      const recent = await reviewQueue.findMostRecentlyReviewed(
        executor,
        learnerId,
      );
      if (recent === undefined) {
        return [
          { text: '还没有练过的内容。先发 /kana 或 /vocab 做几题，再来问。' },
        ];
      }

      const kana = kanaOfKey(recent.knowledgeKey);
      const word = vocabOfKey(recent.knowledgeKey);
      if (kana === undefined && word === undefined) {
        return [{ text: '刚才那一项我讲不了。' }];
      }

      // 語義は出典の値をそのまま渡す。模型に意味を作らせない（§8）。
      const target =
        kana !== undefined
          ? { subject: kana.hiragana, reading: kana.romaji }
          : {
              subject: word?.expression ?? '',
              reading: word?.reading ?? '',
              meaning: word?.meaning ?? '',
            };

      try {
        const text = await deps.explainItem(target);
        if (text.trim() === '') {
          return [{ text: '这次没能生成讲解，再试一次。' }];
        }
        return [{ text: `📖 ${target.subject}\n\n${text}` }];
      } catch {
        return [{ text: '讲解暂时不可用，稍后再试。' }];
      }
    },

    async vocab(telegramUserId) {
      const learnerId = await learnerIdOf(telegramUserId);
      if (learnerId === undefined) return [{ text: NOT_REGISTERED }];
      const now = deps.now();
      const lesson = await planVocabSession(executor, learnerId, now, {
        ...lessonOptions,
        newPerDay: await remainingNewToday(learnerId, now, 'VOCABULARY'),
      });

      if (lesson.stage === 'S0_KANA_ONLY') {
        return [
          {
            text: '先把五十音的清音学完，再开始背单词——现在很多字还读不出来。\n\n发 /kana 继续。',
          },
        ];
      }

      const replies: KanaReply[] = [];
      if (lesson.newWords.length > 0) {
        lesson.newWords.forEach((entry, index) => {
          replies.push({
            text: renderVocabCard(entry, index + 1, lesson.newWords.length),
            // 読みだけを合成する。表記を読ませると読み方が定まらない
            // （「今」は いま とも こん とも読む）。
            speakText: entry.reading,
          });
        });
        await introduceVocab(
          executor,
          learnerId,
          lesson.newWords.map((entry) => entry.id),
          now,
        );
      }
      replies.push(...(await askNextVocab(learnerId, now, 0)));
      return replies;
    },

    async write(telegramUserId) {
      const learnerId = await learnerIdOf(telegramUserId);
      if (learnerId === undefined) return [{ text: NOT_REGISTERED }];
      const now = deps.now();

      // 語彙が始まっていない段階では文が読めない。助詞だけ先に覚えても
      // 入れる場所が分からず、記号の暗記にしかならない。
      const vocab = await planVocabSession(executor, learnerId, now, lessonOptions);
      if (vocab.stage === 'S0_KANA_ONLY') {
        return [
          {
            text: '先把五十音的清音学完再来写句子——现在句子里的字还读不出来。\n\n发 /kana 继续。',
          },
        ];
      }

      // 助詞にも一日の新出上限を効かせる。効かせないと /write を三回
      // 叩くだけで 12 項が一日で入る——仮名で直した取りこぼし（§2.5）と
      // 同じ形が、新しい型でそのまま再発していた。
      const lesson = await planWritingSession(executor, learnerId, now, {
        newPerDay: await remainingNewToday(learnerId, now, 'GRAMMAR'),
        maxReviews: deps.maxReviews,
      });

      const replies: KanaReply[] = [];
      if (lesson.progress.introduced === 0) {
        replies.push({
          text: renderWritingIntro(
            lesson.progress.introduced,
            lesson.progress.total,
          ),
        });
      }
      if (lesson.newParticles.length > 0) {
        lesson.newParticles.forEach((particle, index) => {
          replies.push({
            text: renderParticleCard(
              particle,
              index + 1,
              lesson.newParticles.length,
            ),
            // 助詞は一文字なので、単独で読み上げても学習者は聞き分けにくい。
            // 音は文の中で聞かせたほうがよいので、ここでは付けない。
          });
        });
        await introduceParticles(
          executor,
          learnerId,
          lesson.newParticles.map((particle) => particle.id),
          now,
        );
      }
      replies.push(...(await askNextWriting(learnerId, now, 0)));
      return replies;
    },

    async read(telegramUserId) {
      const learnerId = await learnerIdOf(telegramUserId);
      if (learnerId === undefined) return [{ text: NOT_REGISTERED }];
      const now = deps.now();
      const vocab = await planVocabSession(executor, learnerId, now, lessonOptions);
      if (vocab.stage === 'S0_KANA_ONLY') {
        return [
          {
            text: '先把五十音的清音学完再来读句子——现在句子里的字还读不出来。\n\n发 /kana 继续。',
          },
        ];
      }
      return askNextReading(learnerId, 0);
    },

    async compose(telegramUserId) {
      const learnerId = await learnerIdOf(telegramUserId);
      if (learnerId === undefined) return [{ text: NOT_REGISTERED }];
      const now = deps.now();
      const vocab = await planVocabSession(executor, learnerId, now, lessonOptions);
      if (vocab.stage === 'S0_KANA_ONLY') {
        return [
          {
            text: '先把五十音的清音学完再来写句子。\n\n发 /kana 继续。',
          },
        ];
      }
      return askNextComposition(learnerId);
    },

    async answerTyped(telegramUserId, questionText, typed, askedAt) {
      // 返信元が出題でなければ、これは答えではなく普通の会話。
      // undefined を返して、呼び出し側に通常の経路へ渡させる。
      const targetId = targetOfQuestionText(questionText);
      const vocabTargetId =
        targetId === undefined
          ? targetOfVocabQuestionText(questionText)
          : undefined;
      const orderSentenceId =
        targetId === undefined && vocabTargetId === undefined
          ? sentenceOfOrderQuestion(questionText)
          : undefined;
      const composeSentenceId =
        targetId === undefined &&
        vocabTargetId === undefined &&
        orderSentenceId === undefined
          ? sentenceOfCompositionQuestion(questionText)
          : undefined;
      if (
        targetId === undefined &&
        vocabTargetId === undefined &&
        orderSentenceId === undefined &&
        composeSentenceId === undefined
      ) {
        return undefined;
      }

      const learnerId = await learnerIdOf(telegramUserId);
      if (learnerId === undefined) return [{ text: NOT_REGISTERED }];

      const now = deps.now();

      if (composeSentenceId !== undefined) {
        if (deps.judgeWriting === undefined) {
          return [{ text: '写句子判分尚未启用。' }];
        }
        const graded = await gradeComposition(
          composeSentenceId,
          typed,
          deps.judgeWriting,
        );
        if (graded === undefined) {
          return [{ text: '这道题已经过期了，发 /compose 继续。' }];
        }
        return [
          {
            text: renderCompositionResult(
              graded.correct,
              graded.reference,
              graded.note,
              graded.source !== 'UNJUDGED',
            ),
            speakText: graded.reference,
          },
          ...(await askNextComposition(learnerId)),
        ];
      }

      if (orderSentenceId !== undefined) {
        const result = gradeWordOrder(orderSentenceId, typed);
        if (result === undefined) return undefined;
        // 語順は特定の知識項を測っていないので FSRS には入れない
        // （writingSession.nextWritingQuestion の註）。
        return [
          {
            text: renderWordOrderResult(result.verdict, result.full, typed),
            speakText: result.full,
          },
          ...(await askNextWriting(learnerId, now, 1)),
        ];
      }

      if (vocabTargetId !== undefined) {
        const gradedVocab = await gradeVocabTyped(
          executor,
          learnerId,
          vocabTargetId,
          typed,
          now,
          deps.requestRetention,
          responseMsOf(askedAt, now),
        );
        const feedbackVocab: KanaReply = gradedVocab.correct
          ? { text: renderVocabCorrect(gradedVocab.target) }
          : {
              text: renderVocabWrong(gradedVocab.target, undefined, typed),
              speakText: gradedVocab.target.reading,
            };
        return [feedbackVocab, ...(await askNextVocab(learnerId, now, 1))];
      }
      if (targetId === undefined) return undefined;
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
