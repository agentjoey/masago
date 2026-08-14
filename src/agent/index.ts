export {
  createAnthropicClient,
  type AnthropicClientLike,
  type AnthropicClientOptions,
  type AnthropicMessagesLike,
} from './llm/index.js';
export {
  buildHintRequestText,
  buildKnownKeysText,
  buildModePolicyText,
  buildRetryEvaluationText,
  buildSurfacingDirectiveText,
  createMinimalTutor,
  DEFAULT_MAX_TOKENS,
  HOLD_DIRECTIVE_TEXT,
  INITIAL_KNOWLEDGE_KEYS,
  REPAIR_INSTRUCTION,
  replyContainsCorrection,
  TUTOR_POLICY,
  TUTOR_PROVIDER_NAME,
  TUTOR_TOOL_NAME,
  TutorError,
  TutorOutputError,
  TutorRequestError,
  type MinimalTutorOptions,
} from './tutor.js';
export {
  detectedIssueSchema,
  KNOWLEDGE_KEY_PATTERN,
  retryEvaluationSchema,
  TUTOR_OUTPUT_JSON_SCHEMA,
  tutorOutputSchema,
  type DetectedIssueOutput,
  type RetryEvaluationOutput,
  type TutorOutput,
} from './schemas.js';

export { explain } from './explain.js';
export type { ExplainTarget, ExplainOptions, Explanation } from './explain.js';
export { judgeComposition, COMPOSITION_VERDICT } from './composition.js';
export type {
  CompositionVerdict,
  JudgeCompositionInput,
  JudgeCompositionOptions,
} from './composition.js';
