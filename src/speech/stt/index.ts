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
