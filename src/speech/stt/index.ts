export type {
  SpeechToTextProvider,
  SttOptions,
  SttUsage,
  Transcript,
  TranscriptSegment,
} from './types.js';
export { SttError, SttTimeoutError, SttUnsupportedFormatError } from './types.js';
export type { MockSttOptions } from './mock.js';
export {
  MOCK_STT_DEFAULT_TRANSCRIPT,
  MOCK_STT_SUPPORTED_INPUT_FORMATS,
  MockSttProvider,
} from './mock.js';
export type {
  OpenAiSttProviderOptions,
  OpenAiTranscribeOptions,
} from './openai.js';
export {
  OPENAI_STT_MAX_FILE_BYTES,
  OPENAI_STT_SUPPORTED_INPUT_FORMATS,
  OpenAiSttError,
  OpenAiSttProvider,
} from './openai.js';
export { createSttProvider } from '../providerFactory.js';
