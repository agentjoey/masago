export type {
  AudioResult,
  TextToSpeechProvider,
  TtsUsage,
  VoiceConfig,
} from './types.js';
export { TtsError, TtsTimeoutError } from './types.js';
export type { MockTtsOptions } from './mock.js';
export { MockTtsProvider } from './mock.js';
export type { MiniMaxTtsProviderOptions } from './minimax.js';
export { MiniMaxTtsError, MiniMaxTtsProvider } from './minimax.js';
export { createTtsProvider } from '../providerFactory.js';
