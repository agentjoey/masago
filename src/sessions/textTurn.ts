import type { CorrectionTurnHooks } from '../corrections/index.js';
import type { Executor } from '../db/index.js';
import { turnsRepo } from '../db/index.js';
import type { Tutor } from './voiceTurn.js';

export interface TextTurnDeps {
  executor: Executor;
  tutor?: Tutor;
  corrections?: CorrectionTurnHooks;
}

export interface TextTurnInput {
  sessionId: string;
  telegramMessageId: number;
  text: string;
  explicitRequest?: boolean;
  sessionEnding?: boolean;
}

export interface TextTurnResult {
  turnId: string;
  reply: string;
}

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
  if (deps.tutor !== undefined && deps.corrections !== undefined) {
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
    const response = await deps.tutor.respond({
      rawTranscript: input.text,
      normalizedTranscript: input.text,
      surfacingDirective: directive,
    });
    await deps.corrections.finalizeSurfacing({
      turnId: turn.id,
      sessionId: input.sessionId,
      directive,
      detectedIssues: response.detectedIssues ?? [],
    });
    reply = response.correctionCard
      ? `${response.replyText}\n\n${response.correctionCard}`
      : response.replyText;
  } else {
    reply = `echo: ${input.text}`;
  }

  await turnsRepo.updateStatus(deps.executor, turn.id, 'COMPLETED', {
    replyText: reply,
  });
  return { turnId: turn.id, reply };
}
