import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  createMinimalTutor,
  INITIAL_KNOWLEDGE_KEYS,
  TutorOutputError,
} from '../../src/agent/index.js';
import type { KnowledgeKeyStore } from '../../src/db/repositories/knowledgeItems.js';
import type { TutorRequest } from '../../src/sessions/voiceTurn.js';
import { makeToolUseMessage, StubAnthropicClient } from './stubAnthropic.js';

const MODEL = 'claude-sonnet-5';

const REQUEST: TutorRequest = {
  rawTranscript: '昨日友達と映画を見るました',
  normalizedTranscript: '昨日友達と映画を見るました',
};

function outputWithKey(knowledgeKey: string) {
  return {
    reply: { japanese: 'へえ、どんな映画でしたか？', translation: null },
    detectedIssues: [
      {
        original: '映画を見るました',
        recommended: '映画を見ました',
        reason: '「見る」のマス形過去は「見ました」',
        naturalAlternative: null,
        knowledgeKey,
        importance: 'HIGH',
      },
    ],
    correctionCard: null,
    retryEvaluation: null,
    session: { continue: true },
  };
}

function userMessageOf(call: {
  messages: Anthropic.MessageParam[];
}): string {
  const first = call.messages[0];
  if (first === undefined || typeof first.content !== 'string') {
    throw new Error('expected a string user message');
  }
  return first.content;
}

class FakeKnowledgeKeyStore implements KnowledgeKeyStore {
  readonly registered: string[][] = [];
  constructor(
    private readonly keys: readonly string[] = [],
    private readonly failure?: Error,
  ) {}

  listKeys(): Promise<readonly string[]> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return Promise.resolve(this.keys);
  }

  registerKeys(keys: readonly string[]): Promise<void> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    this.registered.push([...keys]);
    return Promise.resolve();
  }
}

describe('tutor knowledgeKey stability', () => {
  it('injects the initial key space into the user message without a store', async () => {
    const client = new StubAnthropicClient([
      makeToolUseMessage(outputWithKey('verb_masu_past')),
    ]);
    const tutor = createMinimalTutor({ client, model: MODEL });

    await tutor.respond(REQUEST);

    const message = userMessageOf(client.calls[0] ?? { messages: [] });
    expect(message).toContain('<known_knowledge_keys>');
    for (const key of INITIAL_KNOWLEDGE_KEYS) {
      expect(message).toContain(key);
    }
  });

  it('merges store keys into the context and keeps the system prefix stable', async () => {
    const client = new StubAnthropicClient([
      makeToolUseMessage(outputWithKey('verb_masu_past')),
      makeToolUseMessage(outputWithKey('verb_masu_past')),
    ]);
    const store = new FakeKnowledgeKeyStore(['particle_wo_o', 'kana_long_vowel']);
    const tutor = createMinimalTutor({
      client,
      model: MODEL,
      knowledgeKeys: store,
    });

    await tutor.respond(REQUEST);
    await tutor.respond({
      rawTranscript: '今日は寒いですね',
      normalizedTranscript: '今日は寒いですね',
    });

    const message = userMessageOf(client.calls[0] ?? { messages: [] });
    expect(message).toContain('particle_wo_o');
    expect(message).toContain('kana_long_vowel');
    expect(message).toContain('verb_masu_past');
    // 既知キーは user message に置き、system プレフィックスは変えない（§6.5）
    const systems = client.calls.map((call) => JSON.stringify(call.system));
    expect(systems[1]).toBe(systems[0]);
  });

  it('treats request.knownKnowledgeKeys as known too', async () => {
    const client = new StubAnthropicClient([
      makeToolUseMessage(outputWithKey('verb_masu_past')),
    ]);
    const tutor = createMinimalTutor({ client, model: MODEL });

    await tutor.respond({ ...REQUEST, knownKnowledgeKeys: ['custom_key_x'] });

    const message = userMessageOf(client.calls[0] ?? { messages: [] });
    expect(message).toContain('custom_key_x');
    expect(message).toContain('verb_masu_past');
  });

  it('registers only keys not already known', async () => {
    const client = new StubAnthropicClient([
      makeToolUseMessage(outputWithKey('verb_te_form')),
      makeToolUseMessage(outputWithKey('brand_new_error')),
    ]);
    const store = new FakeKnowledgeKeyStore(['particle_wo_o']);
    const tutor = createMinimalTutor({
      client,
      model: MODEL,
      knowledgeKeys: store,
    });

    await tutor.respond(REQUEST);
    expect(store.registered).toEqual([]);

    await tutor.respond(REQUEST);
    expect(store.registered).toEqual([['brand_new_error']]);
  });

  it('survives store failures: the turn still completes', async () => {
    const client = new StubAnthropicClient([
      makeToolUseMessage(outputWithKey('brand_new_error')),
    ]);
    const store = new FakeKnowledgeKeyStore([], new Error('db down'));
    const tutor = createMinimalTutor({
      client,
      model: MODEL,
      knowledgeKeys: store,
    });

    const response = await tutor.respond(REQUEST);

    expect(response.replyText).toBe('へえ、どんな映画でしたか？');
    const message = userMessageOf(client.calls[0] ?? { messages: [] });
    expect(message).toContain('<known_knowledge_keys>');
    expect(message).toContain('verb_masu_past');
  });

  it('rejects a free-text knowledgeKey from the model and degrades after repair', async () => {
    const freeText = outputWithKey('動詞の過去形：見る → 見ました');
    const client = new StubAnthropicClient([
      makeToolUseMessage(freeText),
      makeToolUseMessage(freeText),
    ]);
    const tutor = createMinimalTutor({ client, model: MODEL });

    const error = await tutor.respond(REQUEST).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TutorOutputError);
    expect(client.calls).toHaveLength(2);
    // repair の tool_result に検証エラーの詳細が渡る
    const repairCall = client.calls[1];
    expect(JSON.stringify(repairCall?.messages)).toContain('knowledgeKey');
  });
});
