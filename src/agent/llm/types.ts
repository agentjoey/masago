import type Anthropic from '@anthropic-ai/sdk';

export interface AnthropicMessagesLike {
  create(
    params: Anthropic.MessageCreateParamsNonStreaming,
  ): Promise<Anthropic.Message>;
}

export interface AnthropicClientLike {
  readonly messages: AnthropicMessagesLike;
}
