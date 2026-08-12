import Anthropic from '@anthropic-ai/sdk';
import type { AnthropicClientLike } from './types.js';

export interface AnthropicClientOptions {
  apiKey: string;
  maxRetries?: number;
  timeoutMs?: number;
}

export function createAnthropicClient(
  options: AnthropicClientOptions,
): AnthropicClientLike {
  return new Anthropic({
    apiKey: options.apiKey,
    ...(options.maxRetries !== undefined
      ? { maxRetries: options.maxRetries }
      : {}),
    ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
  });
}
