import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  buildHintRequestText,
  buildModePolicyText,
  buildRetryEvaluationText,
  createMinimalTutor,
} from '../../src/agent/index.js';
import type { PendingIssue } from '../../src/corrections/index.js';
import type { ModePolicy } from '../../src/sessions/modes.js';
import type { TutorRequest } from '../../src/sessions/voiceTurn.js';
import { makeToolUseMessage, StubAnthropicClient } from './stubAnthropic.js';

const MODEL = 'claude-sonnet-5';

const CHALLENGE_POLICY: ModePolicy = {
  surfaceAfterTurns: 4,
  chineseAllowed: 'none',
  hintLadder: true,
  immersive: true,
};

const CONVERSATION_POLICY: ModePolicy = {
  surfaceAfterTurns: 4,
  chineseAllowed: 'as-needed',
  hintLadder: false,
  immersive: false,
};

const RETRY_ISSUE: PendingIssue = {
  id: 'issue-retry-1',
  turnId: 'turn-1',
  sessionId: 'session-1',
  knowledgeItemId: null,
  knowledgeKey: 'verb_masu_past',
  original: '映画を見るました',
  recommended: '映画を見ました',
  reason: '「見る」のマス形過去は「見ました」',
  naturalAlternative: null,
  importance: 'HIGH',
  surfacedAt: new Date('2026-08-01T00:00:00Z'),
  retryStatus: 'REQUESTED',
  createdAt: new Date('2026-08-01T00:00:00Z'),
};

const OK_OUTPUT = {
  reply: { japanese: 'そうですか。', translation: null },
  detectedIssues: [],
  correctionCard: null,
  retryEvaluation: null,
  session: { continue: true },
};

function userMessageOf(call: {
  messages: Anthropic.MessageParam[];
}): string {
  const first = call.messages[0];
  if (first === undefined || typeof first.content !== 'string') {
    throw new Error('expected a string user message');
  }
  return first.content;
}

function makeTutor(): {
  tutor: ReturnType<typeof createMinimalTutor>;
  client: StubAnthropicClient;
} {
  const client = new StubAnthropicClient([makeToolUseMessage(OK_OUTPUT)]);
  return {
    tutor: createMinimalTutor({ client, model: MODEL }),
    client,
  };
}

describe('mode policy directive builders', () => {
  it('Challenge 策略禁止任何中文', () => {
    const text = buildModePolicyText(CHALLENGE_POLICY);
    expect(text).toContain('中国語は一切使わないでください');
    expect(text).toContain('イマージョン');
  });

  it('非沉浸策略不含沉浸式指令', () => {
    const text = buildModePolicyText(CONVERSATION_POLICY);
    expect(text).not.toContain('イマージョン');
    expect(text).toContain('as-needed');
  });

  it('hint ladder 分级：1 日语提示 / 2 关键词 / 3 允许一句中文', () => {
    expect(buildHintRequestText(1)).toContain('日本語で短いヒント');
    expect(buildHintRequestText(1)).not.toContain('キーワード');
    expect(buildHintRequestText(2)).toContain('キーワード');
    expect(buildHintRequestText(3)).toContain('短い中国語の説明');
  });

  it('retry evaluation 指令列出待验证 issue', () => {
    const text = buildRetryEvaluationText([RETRY_ISSUE]);
    expect(text).toContain('issue-retry-1');
    expect(text).toContain('映画を見るました');
    expect(text).toContain('retryEvaluation');
  });
});

describe('createMinimalTutor mode awareness', () => {
  const BASE_REQUEST: TutorRequest = {
    rawTranscript: 'テスト',
    normalizedTranscript: 'テスト',
  };

  it('modePolicy 进入 user message', async () => {
    const { tutor, client } = makeTutor();
    await tutor.respond({ ...BASE_REQUEST, modePolicy: CHALLENGE_POLICY });
    const message = userMessageOf(client.calls[0] ?? { messages: [] });
    expect(message).toContain('<mode_policy>');
    expect(message).toContain('中国語は一切使わないでください');
  });

  it('retryEvaluationRequest 进入 user message', async () => {
    const { tutor, client } = makeTutor();
    await tutor.respond({
      ...BASE_REQUEST,
      retryEvaluationRequest: {
        learnerId: 'learner-1',
        issues: [RETRY_ISSUE],
      },
    });
    const message = userMessageOf(client.calls[0] ?? { messages: [] });
    expect(message).toContain('<retry_evaluation_request>');
    expect(message).toContain('issue-retry-1');
  });

  it('hint 请求进入 user message', async () => {
    const { tutor, client } = makeTutor();
    await tutor.respond({ ...BASE_REQUEST, hint: { level: 2 } });
    const message = userMessageOf(client.calls[0] ?? { messages: [] });
    expect(message).toContain('<hint_request>');
    expect(message).toContain('キーワード');
  });

  it('未提供新字段时 user message 不含任何新增段落', async () => {
    const { tutor, client } = makeTutor();
    await tutor.respond(BASE_REQUEST);
    const message = userMessageOf(client.calls[0] ?? { messages: [] });
    expect(message).not.toContain('<mode_policy>');
    expect(message).not.toContain('<retry_evaluation_request>');
    expect(message).not.toContain('<hint_request>');
  });
});
