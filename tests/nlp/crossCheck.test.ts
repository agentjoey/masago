import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Analyzer, Token } from '../../src/nlp/analyzer.js';
import { crossCheck } from '../../src/nlp/crossCheck.js';

const FIXTURES = JSON.parse(
  readFileSync(new URL('./tokens.fixture.json', import.meta.url), 'utf8'),
) as Record<string, Token[]>;

function fakeAnalyzer(overrides?: Partial<Analyzer>): Analyzer {
  return {
    tokenize: (text: string) => Promise.resolve(FIXTURES[text] ?? []),
    shutdown: () => {},
    isRunning: () => true,
    ...overrides,
  };
}

describe('crossCheck', () => {
  it('adds what the model missed', async () => {
    const result = await crossCheck('犬を三匹あります', {
      analyzer: fakeAnalyzer(),
      alreadyDetected: [],
    });
    expect(result.analyzed).toBe(true);
    expect(result.added.map((i) => i.knowledgeKey)).toContain(
      'particle_wo_ga_existence',
    );
  });

  // 同じ指摘を二度見せない。
  it('does not repeat what the model already found', async () => {
    const result = await crossCheck('犬を三匹あります', {
      analyzer: fakeAnalyzer(),
      alreadyDetected: [
        { knowledgeKey: 'particle_wo_ga_existence', original: 'を' },
      ],
    });
    expect(result.added).toEqual([]);
  });

  it('adds nothing for a correct sentence', async () => {
    const result = await crossCheck('本を読みます', {
      analyzer: fakeAnalyzer(),
      alreadyDetected: [],
    });
    expect(result.added).toEqual([]);
    expect(result.analyzed).toBe(true);
  });

  // 形態素解析は補助。落ちても会話は成立させる——ここで投げると
  // 辞書が読めないだけで返事が返らなくなる。
  it('degrades quietly when the analyzer fails', async () => {
    const onError = vi.fn();
    const result = await crossCheck('犬を三匹あります', {
      analyzer: fakeAnalyzer({
        tokenize: () => Promise.reject(new Error('dictionary missing')),
      }),
      alreadyDetected: [],
      onError,
    });
    expect(result.analyzed).toBe(false);
    expect(result.added).toEqual([]);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('survives a timeout without throwing', async () => {
    const result = await crossCheck('本を読みます', {
      analyzer: fakeAnalyzer({
        tokenize: () => Promise.reject(new Error('analyzer timed out')),
      }),
      alreadyDetected: [],
    });
    expect(result.analyzed).toBe(false);
  });
});
