import type { Executor } from '../db/index.js';
import { turnsRepo } from '../db/index.js';

export interface TextTurnDeps {
  executor: Executor;
}

export interface TextTurnInput {
  sessionId: string;
  telegramMessageId: number;
  text: string;
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
  const reply = `echo: ${input.text}`;
  await turnsRepo.updateStatus(deps.executor, turn.id, 'COMPLETED', {
    replyText: reply,
  });
  return { turnId: turn.id, reply };
}
