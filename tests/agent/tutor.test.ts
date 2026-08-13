import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  createMinimalTutor,
  REPAIR_INSTRUCTION,
  TUTOR_TOOL_NAME,
  TutorOutputError,
  TutorRequestError,
} from '../../src/agent/index.js';
import type { TutorRequest } from '../../src/sessions/voiceTurn.js';
import {
  makeTextMessage,
  makeToolUseMessage,
  StubAnthropicClient,
} from './stubAnthropic.js';

const MODEL = 'claude-sonnet-5';

const VALID_OUTPUT = {
  reply: { japanese: '映画を見ましたね！面白かったですか？', translation: null },
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
};

const INVALID_OUTPUT = { reply: { japanese: '' }, detectedIssues: [] };

const REQUEST: TutorRequest = {
  rawTranscript: '昨日友達と映画を見るました',
  normalizedTranscript: '昨日、友達と映画を見ました',
};

function lastMessageRole(call: { messages: Array<{ role: string }> }): string {
  const last = call.messages[call.messages.length - 1];
  if (last === undefined) {
    throw new Error('call has no messages');
  }
  return last.role;
}

describe('createMinimalTutor', () => {
  it('returns the japanese reply and maps all four usage fields', async () => {
    const client = new StubAnthropicClient([
      makeToolUseMessage(VALID_OUTPUT, {
        id: 'msg_abc123',
        inputTokens: 1200,
        outputTokens: 80,
        cacheReadInputTokens: 1024,
        cacheCreationInputTokens: 176,
      }),
    ]);
    const tutor = createMinimalTutor({ client, model: MODEL });

    const response = await tutor.respond(REQUEST);

    expect(response.replyText).toBe('映画を見ましたね！面白かったですか？');
    expect(response.ttsText).toBe(response.replyText);
    expect(response.provider).toBe('anthropic');
    expect(response.model).toBe(MODEL);
    expect(response.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 80,
      cacheReadTokens: 1024,
      cacheWriteTokens: 176,
      requestId: 'msg_abc123',
    });
  });

  it('never sends sampling parameters (temperature/top_p/top_k)', async () => {
    const client = new StubAnthropicClient([makeToolUseMessage(VALID_OUTPUT)]);
    const tutor = createMinimalTutor({ client, model: MODEL });

    await tutor.respond(REQUEST);

    const params = client.calls[0];
    expect(params).toBeDefined();
    expect(params).not.toHaveProperty('temperature');
    expect(params).not.toHaveProperty('top_p');
    expect(params).not.toHaveProperty('top_k');
  });

  it('never uses assistant prefill: the last message is always a user turn', async () => {
    const client = new StubAnthropicClient([
      makeToolUseMessage(INVALID_OUTPUT),
      makeToolUseMessage(VALID_OUTPUT),
    ]);
    const tutor = createMinimalTutor({ client, model: MODEL });

    await tutor.respond(REQUEST);

    expect(client.calls).toHaveLength(2);
    for (const call of client.calls) {
      expect(lastMessageRole(call)).toBe('user');
    }
  });

  it('forces submit_tutor_turn via tools + tool_choice and never sends output_config', async () => {
    const client = new StubAnthropicClient([makeToolUseMessage(VALID_OUTPUT)]);
    const tutor = createMinimalTutor({ client, model: MODEL });

    await tutor.respond(REQUEST);

    const params = client.calls[0];
    expect(params).toBeDefined();
    expect(params?.tools).toHaveLength(1);
    // ToolUnion には input_schema を持たない変種があるため、カスタムツールへ絞る
    const tool = params?.tools?.[0] as Anthropic.Tool | undefined;
    expect(tool?.name).toBe(TUTOR_TOOL_NAME);
    expect(tool?.input_schema).toMatchObject({
      type: 'object',
      required: [
        'reply',
        'detectedIssues',
        'correctionCard',
        'retryEvaluation',
        'session',
      ],
    });
    expect(params?.tool_choice).toMatchObject({
      type: 'tool',
      name: TUTOR_TOOL_NAME,
    });
    expect(params).not.toHaveProperty('output_config');
    expect(params).not.toHaveProperty('output_format');
  });

  it('reads the tool_use block even when a text block precedes it', async () => {
    const message = makeToolUseMessage(VALID_OUTPUT);
    message.content = [
      { type: 'text', text: '補足のテキスト', citations: null },
      ...message.content,
    ];
    const client = new StubAnthropicClient([message]);
    const tutor = createMinimalTutor({ client, model: MODEL });

    const response = await tutor.respond(REQUEST);

    expect(response.replyText).toBe('映画を見ましたね！面白かったですか？');
  });

  it('marks the first system block cacheable and keeps the system prefix byte-identical across calls', async () => {
    const client = new StubAnthropicClient([
      makeToolUseMessage(VALID_OUTPUT),
      makeToolUseMessage(VALID_OUTPUT),
    ]);
    const tutor = createMinimalTutor({ client, model: MODEL });

    await tutor.respond(REQUEST);
    await tutor.respond({
      rawTranscript: '今日は寒いですね',
      normalizedTranscript: '今日は寒いですね',
    });

    expect(client.calls).toHaveLength(2);
    const firstSystem = client.calls[0]?.system;
    const secondSystem = client.calls[1]?.system;
    expect(Array.isArray(firstSystem)).toBe(true);
    const firstBlock = Array.isArray(firstSystem) ? firstSystem[0] : undefined;
    expect(firstBlock).toMatchObject({
      type: 'text',
      cache_control: { type: 'ephemeral' },
    });
    expect(JSON.stringify(secondSystem)).toBe(JSON.stringify(firstSystem));
  });

  it('omits cache_control when prompt caching is disabled', async () => {
    const client = new StubAnthropicClient([makeToolUseMessage(VALID_OUTPUT)]);
    const tutor = createMinimalTutor({
      client,
      model: MODEL,
      promptCacheEnabled: false,
    });

    await tutor.respond(REQUEST);

    const system = client.calls[0]?.system;
    const firstBlock = Array.isArray(system) ? system[0] : undefined;
    expect(firstBlock).not.toHaveProperty('cache_control');
  });

  it('does not send thinking or budget_tokens', async () => {
    const client = new StubAnthropicClient([makeToolUseMessage(VALID_OUTPUT)]);
    const tutor = createMinimalTutor({ client, model: MODEL });

    await tutor.respond(REQUEST);

    const params = client.calls[0];
    expect(params).not.toHaveProperty('thinking');
    expect(JSON.stringify(params)).not.toContain('budget_tokens');
  });

  it('repairs an invalid tool_use input via tool_result with the validation errors, then succeeds', async () => {
    const client = new StubAnthropicClient([
      makeToolUseMessage(INVALID_OUTPUT, {
        inputTokens: 1000,
        outputTokens: 20,
      }),
      makeToolUseMessage(VALID_OUTPUT, {
        inputTokens: 1100,
        outputTokens: 80,
        cacheReadInputTokens: 1000,
      }),
    ]);
    const tutor = createMinimalTutor({ client, model: MODEL });

    const response = await tutor.respond(REQUEST);

    expect(client.calls).toHaveLength(2);
    const repairCall = client.calls[1];
    expect(JSON.stringify(repairCall?.system)).toBe(
      JSON.stringify(client.calls[0]?.system),
    );
    const roles = repairCall?.messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'user']);
    const repairUser = repairCall?.messages[2];
    const repairContent = Array.isArray(repairUser?.content)
      ? repairUser.content[0]
      : undefined;
    expect(repairContent).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'toolu_stub_1',
      is_error: true,
    });
    expect(JSON.stringify(repairContent)).toContain(REPAIR_INSTRUCTION);

    expect(response.replyText).toBe('映画を見ましたね！面白かったですか？');
    expect(response.usage.inputTokens).toBe(2100);
    expect(response.usage.outputTokens).toBe(100);
    expect(response.usage.cacheReadTokens).toBe(1000);
  });

  it('degrades with TutorOutputError when the repair attempt still fails schema validation', async () => {
    const client = new StubAnthropicClient([
      makeToolUseMessage(INVALID_OUTPUT),
      makeToolUseMessage(INVALID_OUTPUT),
    ]);
    const tutor = createMinimalTutor({ client, model: MODEL });

    const error = await tutor.respond(REQUEST).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TutorOutputError);
    expect(client.calls).toHaveLength(2);
  });

  it('treats a response without a tool_use block as invalid output and repairs', async () => {
    const noToolUse = makeTextMessage('ツールを呼びませんでした');
    const client = new StubAnthropicClient([
      noToolUse,
      makeToolUseMessage(VALID_OUTPUT),
    ]);
    const tutor = createMinimalTutor({ client, model: MODEL });

    const response = await tutor.respond(REQUEST);

    expect(client.calls).toHaveLength(2);
    expect(response.replyText).toBe('映画を見ましたね！面白かったですか？');
  });

  it('never leaks the API key through errors', async () => {
    const secret = 'sk-ant-secret-key-under-test';
    const client = new StubAnthropicClient([
      new Error(`401 authentication failed: invalid x-api-key ${secret}`),
    ]);
    const tutor = createMinimalTutor({ client, model: MODEL });

    const error = await tutor.respond(REQUEST).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TutorRequestError);
    expect((error as Error).message).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });
});

describe('vacuous issue filtering', () => {
  // 実 API 検証（2026-08-14）で観測：recommended が original と同一の
  // 「訂正のない issue」が返ることがある。Error Bank に誤りでないものが
  // 溜まると §3.3 の mastery が歪むため、プログラム側で落とす。
  it('drops issues whose recommended equals original', async () => {
    const withVacuous = {
      ...VALID_OUTPUT,
      detectedIssues: [
        {
          original: '図書館へ行って',
          recommended: '図書館へ行って',
          reason: null,
          naturalAlternative: null,
          knowledgeKey: 'verb_te_form',
          importance: 'LOW',
        },
        VALID_OUTPUT.detectedIssues[0],
      ],
    };
    const client = new StubAnthropicClient([makeToolUseMessage(withVacuous)]);
    const tutor = createMinimalTutor({ client, model: MODEL });

    const response = await tutor.respond(REQUEST);

    expect(response.detectedIssues ?? []).toHaveLength(1);
    expect((response.detectedIssues ?? [])[0]?.knowledgeKey).toBe('verb_masu_past');
  });
});
