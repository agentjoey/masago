import { describe, expect, it } from 'vitest';
import {
  TUTOR_OUTPUT_JSON_SCHEMA,
  tutorOutputSchema,
} from '../../src/agent/index.js';

const MINIMAL_VALID = {
  reply: { japanese: 'そうなんですね！', translation: null },
  detectedIssues: [],
  correctionCard: null,
  retryEvaluation: null,
  session: { continue: true },
};

describe('tutorOutputSchema', () => {
  it('accepts the minimal stage-2 output shape', () => {
    const parsed = tutorOutputSchema.safeParse(MINIMAL_VALID);
    expect(parsed.success).toBe(true);
  });

  it('accepts detected issues with the stage-3-ready fields', () => {
    const parsed = tutorOutputSchema.safeParse({
      ...MINIMAL_VALID,
      detectedIssues: [
        {
          original: '映画を見るました',
          recommended: '映画を見ました',
          reason: '「見る」のマス形過去は「見ました」',
          naturalAlternative: null,
          knowledgeKey: 'verb_masu_past',
          importance: 'HIGH',
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects malformed outputs that must not become learning events', () => {
    expect(tutorOutputSchema.safeParse({}).success).toBe(false);
    expect(
      tutorOutputSchema.safeParse({ reply: { japanese: '' } }).success,
    ).toBe(false);
    expect(
      tutorOutputSchema.safeParse({
        ...MINIMAL_VALID,
        detectedIssues: [{ original: 'x' }],
      }).success,
    ).toBe(false);
    expect(
      tutorOutputSchema.safeParse({
        ...MINIMAL_VALID,
        session: { continue: 'yes' },
      }).success,
    ).toBe(false);
  });

  it('rejects free-text knowledgeKey (spaces, Japanese, arrows) so mastery can aggregate', () => {
    const issue = {
      original: '映画を見るました',
      recommended: '映画を見ました',
      reason: null,
      naturalAlternative: null,
      importance: 'HIGH' as const,
    };
    // 実測（2026-08-14, MiniMax-M3）：モデルは説明文をキーとして返しがち
    const freeTextKeys = [
      '動詞の過去形：見る → 見ました',
      'verb masu past',
      'Verb_masu_past',
      'verb-masu-past',
      'verb_masu_past。',
      '見るました→見ました',
      '_verb_masu_past',
      '1verb_masu_past',
    ];
    for (const knowledgeKey of freeTextKeys) {
      const parsed = tutorOutputSchema.safeParse({
        ...MINIMAL_VALID,
        detectedIssues: [{ ...issue, knowledgeKey }],
      });
      expect(parsed.success, `should reject: ${knowledgeKey}`).toBe(false);
    }
    const stableKeys = ['verb_masu_past', 'particle_ni_de', 'a', 'x1_2'];
    for (const knowledgeKey of stableKeys) {
      const parsed = tutorOutputSchema.safeParse({
        ...MINIMAL_VALID,
        detectedIssues: [{ ...issue, knowledgeKey }],
      });
      expect(parsed.success, `should accept: ${knowledgeKey}`).toBe(true);
    }
  });

  it('json schema handed to the API mirrors the zod contract', () => {
    expect(TUTOR_OUTPUT_JSON_SCHEMA).toMatchObject({
      type: 'object',
      required: [
        'reply',
        'detectedIssues',
        'correctionCard',
        'retryEvaluation',
        'session',
      ],
      additionalProperties: false,
    });
    // knowledgeKey の pattern も API 側の input_schema に乗せる
    const issues = TUTOR_OUTPUT_JSON_SCHEMA['properties'] as Record<
      string,
      unknown
    >;
    const detected = issues['detectedIssues'] as Record<string, unknown>;
    const item = detected['items'] as Record<string, unknown>;
    const itemProps = item['properties'] as Record<string, unknown>;
    expect(itemProps['knowledgeKey']).toMatchObject({
      pattern: '^[a-z][a-z0-9_]*$',
    });
  });
});
