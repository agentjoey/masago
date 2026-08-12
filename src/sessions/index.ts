import {
  handleIncomingMessage,
  VOICE_NOT_ENABLED_REPLY,
  type OrchestratorDeps,
} from './orchestrator.js';

export type { OrchestratorDeps, OrchestratorResult } from './orchestrator.js';
export { handleIncomingMessage, VOICE_NOT_ENABLED_REPLY };

export interface IncomingMessageContext {
  from?: { id: number };
  message?: {
    message_id: number;
    text?: string;
    voice?: unknown;
  };
  reply(text: string): Promise<unknown>;
}

export function createHandleUpdate(
  deps: OrchestratorDeps,
): (ctx: IncomingMessageContext) => Promise<void> {
  return async (ctx) => {
    const telegramUserId = ctx.from?.id;
    const message = ctx.message;
    if (telegramUserId === undefined || message === undefined) {
      return;
    }
    if (message.text !== undefined) {
      const result = await handleIncomingMessage(deps, {
        telegramUserId,
        telegramMessageId: message.message_id,
        kind: 'text',
        text: message.text,
      });
      await ctx.reply(result.reply);
      return;
    }
    if (message.voice !== undefined) {
      const result = await handleIncomingMessage(deps, {
        telegramUserId,
        telegramMessageId: message.message_id,
        kind: 'voice',
      });
      await ctx.reply(result.reply);
    }
  };
}
