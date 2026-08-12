import type Anthropic from '@anthropic-ai/sdk';
import type { AnthropicClientLike } from '../../src/agent/llm/types.js';

export interface StubUsageOverrides {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
}

export function makeTextMessage(
  text: string,
  overrides: StubUsageOverrides & { id?: string } = {},
): Anthropic.Message {
  return {
    id: overrides.id ?? 'msg_stub_1',
    container: null,
    content: [{ type: 'text', text, citations: null }],
    model: 'claude-sonnet-5',
    role: 'assistant',
    stop_details: null,
    stop_reason: 'end_turn',
    stop_sequence: null,
    type: 'message',
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: overrides.cacheCreationInputTokens ?? null,
      cache_read_input_tokens: overrides.cacheReadInputTokens ?? null,
      inference_geo: null,
      input_tokens: overrides.inputTokens ?? 100,
      output_tokens: overrides.outputTokens ?? 50,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: 'standard',
    },
  };
}

export class StubAnthropicClient implements AnthropicClientLike {
  readonly calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  private readonly queue: Array<Anthropic.Message | Error>;

  constructor(responses: Array<Anthropic.Message | Error>) {
    this.queue = [...responses];
  }

  readonly messages = {
    create: (
      params: Anthropic.MessageCreateParamsNonStreaming,
    ): Promise<Anthropic.Message> => {
      this.calls.push(params);
      const next = this.queue.shift();
      if (next === undefined) {
        return Promise.reject(new Error('stub client exhausted'));
      }
      if (next instanceof Error) {
        return Promise.reject(next);
      }
      return Promise.resolve(next);
    },
  };
}
