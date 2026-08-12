import { z } from 'zod';

export const detectedIssueSchema = z.object({
  original: z.string().min(1),
  recommended: z.string().min(1),
  reason: z.string().nullable(),
  naturalAlternative: z.string().nullable(),
  knowledgeKey: z.string().min(1),
  importance: z.enum(['LOW', 'MEDIUM', 'HIGH']),
});

export const tutorOutputSchema = z.object({
  reply: z.object({
    japanese: z.string().min(1),
    translation: z.string().nullable(),
  }),
  detectedIssues: z.array(detectedIssueSchema),
  session: z.object({ continue: z.boolean() }),
});

export type DetectedIssueOutput = z.infer<typeof detectedIssueSchema>;
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
  },
  required: ['reply', 'detectedIssues', 'session'],
  additionalProperties: false,
};
