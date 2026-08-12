import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  createMinimalTutor,
  HOLD_DIRECTIVE_TEXT,
} from '../../src/agent/index.js';
import type {
  PendingIssue,
  SurfacingDirective,
} from '../../src/corrections/index.js';
import type { TutorRequest } from '../../src/sessions/voiceTurn.js';
import { makeTextMessage, StubAnthropicClient } from './stubAnthropic.js';

const MODEL = 'claude-sonnet-5';

const REQUEST: TutorRequest = {
  rawTranscript: '昨日、友達と映画を見るました',
  normalizedTranscript: '昨日、友達と映画を見るました',
};

const HOLD_DIRECTIVE: SurfacingDirective = { action: 'HOLD' };

const SURFACE_ISSUE: PendingIssue = {
  id: 'issue-surface-1',
  turnId: 'turn-1',
  sessionId: 'session-1',
  knowledgeItemId: null,
  knowledgeKey: 'verb_masu_past',
  original: '映画を見るました',
  recommended: '映画を見ました',
  reason: '「見る」のマス形過去は「見ました」',
  naturalAlternative: null,
  importance: 'HIGH',
  surfacedAt: null,
  retryStatus: 'NONE',
  createdAt: new Date('2026-08-01T00:00:00Z'),
};

const SURFACE_DIRECTIVE: SurfacingDirective = {
  action: 'SURFACE',
  issues: [SURFACE_ISSUE],
  requestRetry: true,
};

const HOLD_OUTPUT = JSON.stringify({
  reply: { japanese: 'へえ、どんな映画でしたか？', translation: null },
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
  correctionCard: null,
  retryEvaluation: null,
  session: { continue: true },
});

const SURFACE_OUTPUT = JSON.stringify({
  reply: { japanese: 'へえ、どんな映画でしたか？', translation: null },
  detectedIssues: [],
  correctionCard:
    '今日のポイント:「映画を見るました」→「映画を見ました」。もう一度言ってみましょう。',
  retryEvaluation: null,
  session: { continue: true },
});

function userMessageOf(call: {
  messages: Anthropic.MessageParam[];
}): string {
  const first = call.messages[0];
  if (first === undefined || typeof first.content !== 'string') {
    throw new Error('expected a string user message');
  }
  return first.content;
}

function systemTextOf(call: { system?: unknown }): string {
  const system = call.system;
  if (!Array.isArray(system)) {
    throw new Error('expected system blocks array');
  }
  return system
    .map((block) => (block as { text?: string }).text ?? '')
    .join('\n');
}

describe('tutor surfacing directive', () => {
  it('HOLD: correctionCard is null, the reply carries no correction, and detectedIssues still flow out', async () => {
    const client = new StubAnthropicClient([makeTextMessage(HOLD_OUTPUT)]);
    const tutor = createMinimalTutor({ client, model: MODEL });

    const response = await tutor.respond({
      ...REQUEST,
      surfacingDirective: HOLD_DIRECTIVE,
    });

    expect(response.correctionCard).toBeNull();
    expect(response.replyText).not.toContain('見ました');
    expect(response.replyText).not.toContain('見るました');
    expect(response.detectedIssues).toHaveLength(1);
    expect(response.detectedIssues?.[0]?.recommended).toBe('映画を見ました');
  });

  it('HOLD: the directive injected into the user turn explicitly forbids corrections in the reply', async () => {
    const client = new StubAnthropicClient([makeTextMessage(HOLD_OUTPUT)]);
    const tutor = createMinimalTutor({ client, model: MODEL });

    await tutor.respond({ ...REQUEST, surfacingDirective: HOLD_DIRECTIVE });

    const call = client.calls[0];
    if (call === undefined) throw new Error('expected one call');
    const userMessage = userMessageOf(call);
    expect(userMessage).toContain('<correction_directive>');
    expect(userMessage).toContain(HOLD_DIRECTIVE_TEXT);
    expect(userMessage).toContain('してはいけません');
    expect(systemTextOf(call)).not.toContain(HOLD_DIRECTIVE_TEXT);
  });

  it('HOLD: even if the model returns a correctionCard, the program nulls it', async () => {
    const leakyOutput = JSON.stringify({
      ...JSON.parse(HOLD_OUTPUT),
      correctionCard: '間違いがあります:「映画を見るました」→「映画を見ました」',
    });
    const client = new StubAnthropicClient([makeTextMessage(leakyOutput)]);
    const tutor = createMinimalTutor({ client, model: MODEL });

    const response = await tutor.respond({
      ...REQUEST,
      surfacingDirective: HOLD_DIRECTIVE,
    });

    expect(response.correctionCard).toBeNull();
  });

  it('SURFACE: the specified issues are injected into the user turn and the card flows out', async () => {
    const client = new StubAnthropicClient([makeTextMessage(SURFACE_OUTPUT)]);
    const tutor = createMinimalTutor({ client, model: MODEL });

    const response = await tutor.respond({
      ...REQUEST,
      surfacingDirective: SURFACE_DIRECTIVE,
    });

    const call = client.calls[0];
    if (call === undefined) throw new Error('expected one call');
    const userMessage = userMessageOf(call);
    expect(userMessage).toContain('SURFACE');
    expect(userMessage).toContain('映画を見るました');
    expect(userMessage).toContain('映画を見ました');
    expect(userMessage).toContain('もう一度');

    expect(response.correctionCard).toContain('映画を見るました');
    expect(response.correctionCard).toContain('映画を見ました');
    expect(response.detectedIssues).toEqual([]);
  });

  it('SURFACE without retry request omits the retry prompt from the directive', async () => {
    const client = new StubAnthropicClient([makeTextMessage(SURFACE_OUTPUT)]);
    const tutor = createMinimalTutor({ client, model: MODEL });

    await tutor.respond({
      ...REQUEST,
      surfacingDirective: { action: 'SURFACE', issues: [SURFACE_ISSUE], requestRetry: false },
    });

    const call = client.calls[0];
    if (call === undefined) throw new Error('expected one call');
    expect(userMessageOf(call)).not.toContain('もう一度言ってもらうよう促してください');
  });

  it('keeps the system prefix byte-identical across no directive, HOLD, and SURFACE', async () => {
    const client = new StubAnthropicClient([
      makeTextMessage(HOLD_OUTPUT),
      makeTextMessage(HOLD_OUTPUT),
      makeTextMessage(SURFACE_OUTPUT),
    ]);
    const tutor = createMinimalTutor({ client, model: MODEL });

    await tutor.respond(REQUEST);
    await tutor.respond({ ...REQUEST, surfacingDirective: HOLD_DIRECTIVE });
    await tutor.respond({ ...REQUEST, surfacingDirective: SURFACE_DIRECTIVE });

    expect(client.calls).toHaveLength(3);
    const systems = client.calls.map((call) => JSON.stringify(call.system));
    expect(systems[1]).toBe(systems[0]);
    expect(systems[2]).toBe(systems[0]);
  });
});
