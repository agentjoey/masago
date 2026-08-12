import { describe, expect, it } from 'vitest';
import {
  createMinimalTutor,
  REPAIR_INSTRUCTION,
  TutorOutputError,
  TutorRequestError,
} from '../../src/agent/index.js';
import type { TutorRequest } from '../../src/sessions/voiceTurn.js';
import { makeTextMessage, StubAnthropicClient } from './stubAnthropic.js';

const MODEL = 'claude-sonnet-5';

const VALID_OUTPUT = JSON.stringify({
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
  session: { continue: true },
});

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
      makeTextMessage(VALID_OUTPUT, {
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

  it('never sends sampling parameters (temperature/top_p/top_k 400 on Sonnet 5)', async () => {
    const client = new StubAnthropicClient([makeTextMessage(VALID_OUTPUT)]);
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
      makeTextMessage('not json at all'),
      makeTextMessage(VALID_OUTPUT),
    ]);
    const tutor = createMinimalTutor({ client, model: MODEL });

    await tutor.respond(REQUEST);

    expect(client.calls).toHaveLength(2);
    for (const call of client.calls) {
      expect(lastMessageRole(call)).toBe('user');
    }
  });

  it('uses output_config.format json_schema, never the deprecated output_format', async () => {
    const client = new StubAnthropicClient([makeTextMessage(VALID_OUTPUT)]);
    const tutor = createMinimalTutor({ client, model: MODEL });

    await tutor.respond(REQUEST);

    const params = client.calls[0];
    expect(params).toBeDefined();
    expect(params?.output_config?.format?.type).toBe('json_schema');
    expect(params?.output_config?.format?.schema).toMatchObject({
      type: 'object',
      required: ['reply', 'detectedIssues', 'session'],
    });
    expect(params).not.toHaveProperty('output_format');
  });

  it('marks the first system block cacheable and keeps the system prefix byte-identical across calls', async () => {
    const client = new StubAnthropicClient([
      makeTextMessage(VALID_OUTPUT),
      makeTextMessage(VALID_OUTPUT),
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
    const client = new StubAnthropicClient([makeTextMessage(VALID_OUTPUT)]);
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

  it('does not send thinking or budget_tokens (removed on Sonnet 5)', async () => {
    const client = new StubAnthropicClient([makeTextMessage(VALID_OUTPUT)]);
    const tutor = createMinimalTutor({ client, model: MODEL });

    await tutor.respond(REQUEST);

    const params = client.calls[0];
    expect(params).not.toHaveProperty('thinking');
    expect(JSON.stringify(params)).not.toContain('budget_tokens');
  });

  it('repairs once on invalid output: same system prefix, assistant turn echoed back, then succeeds', async () => {
    const client = new StubAnthropicClient([
      makeTextMessage('{"reply": "broken"', {
        inputTokens: 1000,
        outputTokens: 20,
      }),
      makeTextMessage(VALID_OUTPUT, {
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
    expect(repairUser?.content).toBe(REPAIR_INSTRUCTION);

    expect(response.replyText).toBe('映画を見ましたね！面白かったですか？');
    expect(response.usage.inputTokens).toBe(2100);
    expect(response.usage.outputTokens).toBe(100);
    expect(response.usage.cacheReadTokens).toBe(1000);
  });

  it('degrades with TutorOutputError when the repair attempt still fails schema validation', async () => {
    const client = new StubAnthropicClient([
      makeTextMessage('not json'),
      makeTextMessage(
        JSON.stringify({ reply: { japanese: '' }, detectedIssues: [] }),
      ),
    ]);
    const tutor = createMinimalTutor({ client, model: MODEL });

    const error = await tutor.respond(REQUEST).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TutorOutputError);
    expect(client.calls).toHaveLength(2);
  });

  it('treats a response without a text block as invalid output and repairs', async () => {
    const noText = makeTextMessage('');
    noText.content = [];
    const client = new StubAnthropicClient([
      noText,
      makeTextMessage(VALID_OUTPUT),
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
