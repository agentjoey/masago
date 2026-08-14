import {
  asRetryTurnHooks,
  type CorrectionTurnHooks,
} from '../corrections/index.js';
import type { Executor } from '../db/index.js';
import { turnsRepo } from '../db/index.js';
import type { Logger } from '../observability/index.js';
import type { HintLevel, ModePolicy } from './modes.js';
import type { Tutor, TutorResponse } from './voiceTurn.js';

export interface TextTurnDeps {
  executor: Executor;
  tutor?: Tutor;
  corrections?: CorrectionTurnHooks;
  logger?: Logger;
  /**
   * 形態素解析による裏取り（§8）。渡されなければ模型の判定だけを使う。
   *
   * 規則で確実に言える誤り（助詞・活用）は、模型より確かで安く、
   * 何より同じ入力に同じ判定を返す。
   */
  grammarCheck?: (
    text: string,
    alreadyDetected: readonly { knowledgeKey: string; original: string }[],
  ) => Promise<
    readonly {
      knowledgeKey: string;
      original: string;
      recommended: string | undefined;
      explanation: string;
    }[]
  >;
  /**
   * 会話で使えた既習語を FSRS に戻す（§3.2）。
   *
   * 返事を送った**後**の記録にだけ効かせる。ここで失敗しても会話は
   * 続く——語彙の記録が取れないことと、返事が返らないことは別の重さ。
   */
  reflowVocabulary?: (
    learnerId: string,
    text: string,
    detected: readonly { original: string }[],
  ) => Promise<void>;
}

export interface TextTurnInput {
  sessionId: string;
  telegramMessageId: number;
  /** 語彙の回流に要る。渡されなければ回流は行わない。 */
  learnerId?: string;
  text: string;
  explicitRequest?: boolean;
  sessionEnding?: boolean;
  modePolicy?: ModePolicy;
  hintLevel?: HintLevel;
}

export interface TextTurnResult {
  turnId: string;
  reply: string;
  /** モデルの出力が使えず、定型文で応答したか。 */
  degraded?: boolean;
}

/**
 * 構造化出力が検証に通らなかったときの応答。
 *
 * 以前はここで例外がそのまま上がり、bot.catch がログを残して終わりだった
 * ——学習者から見れば、話しかけたのに何も返ってこない。原因が模型側の
 * 一時的な失敗であれば、黙って消えるより「もう一度」と言えるほうがいい。
 *
 * 案内は中国語も添える。返事が作れなかった状況で日本語だけ返しても、
 * ゼロから始める人には二重に伝わらない。
 */
export const TUTOR_DEGRADED_REPLY =
  'すみません、うまく返事を作れませんでした。もう一度送ってください。\n（抱歉，这条没能正常处理，请再发一次。）';

export async function runTextTurn(
  deps: TextTurnDeps,
  input: TextTurnInput,
): Promise<TextTurnResult> {
  const turn = await turnsRepo.create(deps.executor, {
    sessionId: input.sessionId,
    telegramMessageId: input.telegramMessageId,
    inputType: 'TEXT',
    rawTranscript: input.text,
  });

  let reply: string;
  // 誤りとして指摘された断片。回流でこれに触れる語を外すのに使う。
  let allDetected: readonly { original: string }[] = [];
  if (deps.tutor !== undefined && deps.corrections !== undefined) {
    const retryHooks = asRetryTurnHooks(deps.corrections);
    const retryPreparation = retryHooks
      ? await retryHooks.prepareRetryEvaluation({ sessionId: input.sessionId })
      : undefined;
    const directive = await deps.corrections.prepareSurfacing({
      turnId: turn.id,
      sessionId: input.sessionId,
      ...(input.explicitRequest !== undefined
        ? { explicitRequest: input.explicitRequest }
        : {}),
      ...(input.sessionEnding !== undefined
        ? { sessionEnding: input.sessionEnding }
        : {}),
    });
    let response: TutorResponse;
    try {
      response = await deps.tutor.respond({
        rawTranscript: input.text,
        normalizedTranscript: input.text,
        surfacingDirective: directive,
        ...(retryPreparation !== undefined
          ? { retryEvaluationRequest: retryPreparation }
          : {}),
        ...(input.modePolicy !== undefined
          ? { modePolicy: input.modePolicy }
          : {}),
        ...(input.hintLevel !== undefined
          ? { hint: { level: input.hintLevel } }
          : {}),
      });
    } catch (error) {
      // 契約は「使える応答を返すか、投げるか」。sessions から見れば
      // 投げられた理由の区別に意味は無く、どれも「答えが得られなかった」。
      // 例外の型で分岐すると agent/ の具体実装に依存することになるので、
      // ここでは種類を問わず受け止める（INTERFACES.md §1 の依存方向）。
      //
      // 検証エラーの内訳は agent/ が例外に載せてくる。あれば拾うが、
      // 無くても構わない——形に依存せず、あるものだけ記録する。
      const detail =
        typeof error === 'object' && error !== null && 'validationErrors' in error
          ? (error as { validationErrors?: unknown }).validationErrors
          : undefined;
      deps.logger?.error('tutor turn degraded', {
        turnId: turn.id,
        sessionId: input.sessionId,
        error,
        ...(detail === undefined ? {} : { validationErrors: detail }),
      });
      // ターンは既に作ってある。ここで放り出すと未完了のまま残るので、
      // FAILED として閉じてから定型文を返す。
      await turnsRepo.updateStatus(deps.executor, turn.id, 'FAILED', {
        replyText: TUTOR_DEGRADED_REPLY,
      });
      return {
        turnId: turn.id,
        reply: TUTOR_DEGRADED_REPLY,
        degraded: true,
      };
    }
    if (retryHooks !== undefined && retryPreparation !== undefined) {
      await retryHooks.finalizeTurnCorrections({
        retryEvaluation: {
          turnId: turn.id,
          sessionId: input.sessionId,
          preparation: retryPreparation,
          evaluation: response.retryEvaluation ?? null,
        },
        surfacing: {
          turnId: turn.id,
          sessionId: input.sessionId,
          directive,
          detectedIssues: response.detectedIssues ?? [],
        },
      });
    } else {
      await deps.corrections.finalizeSurfacing({
        turnId: turn.id,
        sessionId: input.sessionId,
        directive,
        detectedIssues: response.detectedIssues ?? [],
      });
    }
    reply = response.correctionCard
      ? `${response.replyText}\n\n${response.correctionCard}`
      : response.replyText;

    // 規則側の裏取りは返事を送った後の記録にだけ効かせる。会話の流れは
    // 変えない——纠错のリズムは Correction Scheduler が持っている（§R6）。
    if (deps.grammarCheck !== undefined) {
      const detected = response.detectedIssues ?? [];
      const extra = await deps.grammarCheck(
        input.text,
        detected.map((issue) => ({
          knowledgeKey: issue.knowledgeKey,
          original: issue.original,
        })),
      );
      if (extra.length > 0) {
        deps.logger?.info('grammar rules caught what the model missed', {
          turnId: turn.id,
          keys: extra.map((issue) => issue.knowledgeKey),
        });
      }
      allDetected = [...detected, ...extra];
    } else {
      allDetected = response.detectedIssues ?? [];
    }
  } else {
    reply = `echo: ${input.text}`;
  }

  await turnsRepo.updateStatus(deps.executor, turn.id, 'COMPLETED', {
    replyText: reply,
  });

  // 語彙の回流は最後に。ここで転んでもターンは既に成立している。
  if (deps.reflowVocabulary !== undefined && input.learnerId !== undefined) {
    try {
      await deps.reflowVocabulary(input.learnerId, input.text, allDetected);
    } catch (error) {
      deps.logger?.warn('could not record spontaneous vocabulary use', {
        turnId: turn.id,
        error,
      });
    }
  }

  return { turnId: turn.id, reply };
}
