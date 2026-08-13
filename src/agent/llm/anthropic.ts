import Anthropic from '@anthropic-ai/sdk';
import type { AnthropicClientLike } from './types.js';

export interface AnthropicClientOptions {
  apiKey: string;
  baseUrl?: string;
  maxRetries?: number;
  timeoutMs?: number;
}

export function createAnthropicClient(
  options: AnthropicClientOptions,
): AnthropicClientLike {
  return new Anthropic({
    apiKey: options.apiKey,
    ...(options.baseUrl !== undefined ? { baseURL: options.baseUrl } : {}),
    ...(options.maxRetries !== undefined
      ? { maxRetries: options.maxRetries }
      : {}),
    ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
  });
}
