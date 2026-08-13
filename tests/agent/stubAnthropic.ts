import type Anthropic from '@anthropic-ai/sdk';
import { TUTOR_TOOL_NAME } from '../../src/agent/index.js';
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

/**
 * 強制ツール呼び出しに移行したため、既定のスタブ応答は tool_use ブロックを返す。
 * `makeTextMessage` は「ツールを呼ばずテキストだけ返した」異常系のスタブとして残す。
 *
 * 既存テストの期待値は JSON 文字列で書かれているため、文字列も受け付けて
 * ここで object に戻す（tool_use.input は object でなければならない）。
 */
export function makeToolUseMessage(
  input: unknown,
  overrides: StubUsageOverrides & {
    id?: string;
    toolUseId?: string;
    toolName?: string;
    /** 実測どおり text ブロックが tool_use と同居する場合を再現する */
    leadingText?: string;
  } = {},
): Anthropic.Message {
  const message = makeTextMessage('', overrides);
  const parsed: unknown =
    typeof input === 'string' ? (JSON.parse(input) as unknown) : input;
  const content: Anthropic.ContentBlock[] = [];
  if (overrides.leadingText !== undefined) {
    content.push({
      type: 'text',
      text: overrides.leadingText,
      citations: null,
    });
  }
  content.push({
    type: 'tool_use',
    id: overrides.toolUseId ?? 'toolu_stub_1',
    name: overrides.toolName ?? TUTOR_TOOL_NAME,
    input: parsed,
    caller: { type: 'direct' },
  });
  message.content = content;
  return message;
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
