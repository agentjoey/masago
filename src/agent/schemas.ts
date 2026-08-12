import { z } from 'zod';

export const detectedIssueSchema = z.object({
  original: z.string().min(1),
  recommended: z.string().min(1),
  reason: z.string().nullable(),
  naturalAlternative: z.string().nullable(),
  knowledgeKey: z.string().min(1),
  importance: z.enum(['LOW', 'MEDIUM', 'HIGH']),
});

export const retryEvaluationSchema = z.object({
  succeeded: z.boolean(),
  feedback: z.string().nullable(),
});

export const tutorOutputSchema = z.object({
  reply: z.object({
    japanese: z.string().min(1),
    translation: z.string().nullable(),
  }),
  detectedIssues: z.array(detectedIssueSchema),
  correctionCard: z.string().nullable().default(null),
  retryEvaluation: retryEvaluationSchema.nullable().default(null),
  session: z.object({ continue: z.boolean() }),
});

export type DetectedIssueOutput = z.infer<typeof detectedIssueSchema>;
export type RetryEvaluationOutput = z.infer<typeof retryEvaluationSchema>;
export type TutorOutput = z.infer<typeof tutorOutputSchema>;

export const TUTOR_OUTPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    reply: {
      type: 'object',
      properties: {
        japanese: { type: 'string' },
        translation: { type: ['string', 'null'] },
      },
      required: ['japanese', 'translation'],
      additionalProperties: false,
    },
    detectedIssues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          original: { type: 'string' },
          recommended: { type: 'string' },
          reason: { type: ['string', 'null'] },
          naturalAlternative: { type: ['string', 'null'] },
          knowledgeKey: { type: 'string' },
          importance: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
        },
        required: [
          'original',
          'recommended',
          'reason',
          'naturalAlternative',
          'knowledgeKey',
          'importance',
        ],
        additionalProperties: false,
      },
    },
    session: {
      type: 'object',
      properties: {
        continue: { type: 'boolean' },
      },
      required: ['continue'],
      additionalProperties: false,
    },
    correctionCard: { type: ['string', 'null'] },
    retryEvaluation: {
      type: ['object', 'null'],
      properties: {
        succeeded: { type: 'boolean' },
        feedback: { type: ['string', 'null'] },
      },
      required: ['succeeded', 'feedback'],
      additionalProperties: false,
    },
  },
  required: [
    'reply',
    'detectedIssues',
    'correctionCard',
    'retryEvaluation',
    'session',
  ],
  additionalProperties: false,
};
