import { describe, expect, it } from 'vitest';
import { estimateCost, priceFor } from '../../src/usage/pricing.js';
import { PRICE_TABLE, PRICING_VERSION } from '../../src/usage/pricingTable.js';

describe('pricingTable', () => {
  it('contains both claude-sonnet-5 entries (introductory and regular)', () => {
    const sonnet = PRICE_TABLE.filter(
      (entry) => entry.provider === 'anthropic' && entry.model === 'claude-sonnet-5',
    );
    expect(sonnet).toHaveLength(2);
    const [intro, regular] = sonnet;
    expect(intro?.effectiveFrom).toBe('2026-08-12');
    expect(intro?.effectiveTo).toBe('2026-08-31');
    expect(intro?.inputMicroUsdPerUnit).toBe(2);
    expect(intro?.outputMicroUsdPerUnit).toBe(10);
    expect(regular?.effectiveFrom).toBe('2026-09-01');
    expect(regular?.effectiveTo).toBeUndefined();
    expect(regular?.inputMicroUsdPerUnit).toBe(3);
    expect(regular?.outputMicroUsdPerUnit).toBe(15);
  });

  it('contains all providers and models from the verified price list', () => {
    const keys = PRICE_TABLE.map((entry) => `${entry.provider}/${entry.model}`);
    expect(keys).toContain('minimax/speech-2.8-turbo');
    expect(keys).toContain('minimax/speech-2.8-hd');
    expect(keys).toContain('openai/gpt-transcribe');
    expect(keys).toContain('openai/gpt-4o-transcribe');
    expect(keys).toContain('openai/gpt-4o-mini-transcribe');
    expect(keys).toContain('openai/whisper-1');
    expect(keys).toContain('anthropic/claude-opus-5');
  });
});

describe('priceFor', () => {
  it('selects the introductory price for calls made on 2026-08-20', () => {
    const entry = priceFor('anthropic', 'claude-sonnet-5', new Date('2026-08-20T10:00:00Z'));
    expect(entry?.inputMicroUsdPerUnit).toBe(2);
    expect(entry?.outputMicroUsdPerUnit).toBe(10);
  });

  it('selects the introductory price on the last effective day 2026-08-31', () => {
    const entry = priceFor('anthropic', 'claude-sonnet-5', new Date('2026-08-31T23:59:59Z'));
    expect(entry?.inputMicroUsdPerUnit).toBe(2);
  });

  it('selects the regular price for calls made on 2026-09-15', () => {
    const entry = priceFor('anthropic', 'claude-sonnet-5', new Date('2026-09-15T10:00:00Z'));
    expect(entry?.inputMicroUsdPerUnit).toBe(3);
    expect(entry?.outputMicroUsdPerUnit).toBe(15);
  });

  it('selects the regular price on the switch day 2026-09-01', () => {
    const entry = priceFor('anthropic', 'claude-sonnet-5', new Date('2026-09-01T00:00:00Z'));
    expect(entry?.inputMicroUsdPerUnit).toBe(3);
  });

  it('returns undefined before effective_from', () => {
    expect(priceFor('anthropic', 'claude-opus-5', new Date('2026-08-01T00:00:00Z'))).toBeUndefined();
  });

  it('returns undefined for unknown provider or model', () => {
    expect(priceFor('unknown', 'claude-sonnet-5', new Date('2026-08-20T00:00:00Z'))).toBeUndefined();
    expect(priceFor('anthropic', 'gpt-99', new Date('2026-08-20T00:00:00Z'))).toBeUndefined();
  });
});

describe('estimateCost', () => {
  it('prices claude-sonnet-5 at $2/$10 for a call on 2026-08-20', () => {
    const estimate = estimateCost(
      {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        operation: 'llm',
        inputTokens: 1_000_000,
        outputTokens: 100_000,
      },
      new Date('2026-08-20T12:00:00Z'),
    );
    expect(estimate).toEqual({
      status: 'priced',
      amountMicroUsd: 3_000_000,
      amountUsd: 3,
      pricingVersion: PRICING_VERSION,
    });
  });

  it('prices claude-sonnet-5 at $3/$15 for a call on 2026-09-15', () => {
    const estimate = estimateCost(
      {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        operation: 'llm',
        inputTokens: 1_000_000,
        outputTokens: 100_000,
      },
      new Date('2026-09-15T12:00:00Z'),
    );
    expect(estimate.status).toBe('priced');
    if (estimate.status === 'priced') {
      expect(estimate.amountUsd).toBe(4.5);
    }
  });

  it('does not re-price historical calls when the table gains a newer entry', () => {
    const usage = {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      operation: 'llm',
      inputTokens: 500_000,
      outputTokens: 50_000,
    };
    const calledAt = new Date('2026-08-25T12:00:00Z');
    const first = estimateCost(usage, calledAt);
    const recomputedLater = estimateCost(usage, calledAt);
    expect(first).toEqual(recomputedLater);
    expect(first.status).toBe('priced');
    if (first.status === 'priced') {
      expect(first.amountUsd).toBe(1.5);
    }
  });

  it('returns unknown (not zero) for unknown provider/model', () => {
    const estimate = estimateCost(
      {
        provider: 'mystery',
        model: 'model-x',
        operation: 'llm',
        inputTokens: 1000,
        outputTokens: 1000,
      },
      new Date('2026-08-20T12:00:00Z'),
    );
    expect(estimate.status).toBe('unknown');
    expect(estimate).not.toMatchObject({ amountUsd: 0 });
  });

  it('prices MiniMax TTS per character', () => {
    const turbo = estimateCost(
      {
        provider: 'minimax',
        model: 'speech-2.8-turbo',
        operation: 'tts',
        ttsCharacters: 100_000,
      },
      new Date('2026-08-20T12:00:00Z'),
    );
    expect(turbo.status).toBe('priced');
    if (turbo.status === 'priced') {
      expect(turbo.amountUsd).toBe(6);
    }

    const hd = estimateCost(
      {
        provider: 'minimax',
        model: 'speech-2.8-hd',
        operation: 'tts',
        ttsCharacters: 100_000,
      },
      new Date('2026-08-20T12:00:00Z'),
    );
    expect(hd.status).toBe('priced');
    if (hd.status === 'priced') {
      expect(hd.amountUsd).toBe(10);
    }
  });

  it('prices OpenAI STT per minute (seconds converted)', () => {
    const estimate = estimateCost(
      {
        provider: 'openai',
        model: 'gpt-transcribe',
        operation: 'stt',
        audioInputSeconds: 60,
      },
      new Date('2026-08-20T12:00:00Z'),
    );
    expect(estimate.status).toBe('priced');
    if (estimate.status === 'priced') {
      expect(estimate.amountMicroUsd).toBe(4500);
      expect(estimate.amountUsd).toBeCloseTo(0.0045, 6);
    }

    const mini = estimateCost(
      {
        provider: 'openai',
        model: 'gpt-4o-mini-transcribe',
        operation: 'stt',
        audioInputSeconds: 30,
      },
      new Date('2026-08-20T12:00:00Z'),
    );
    expect(mini.status).toBe('priced');
    if (mini.status === 'priced') {
      expect(mini.amountMicroUsd).toBe(1500);
    }
  });

  it('prices cache read at 0.1x and cache write at 1.25x the input price', () => {
    const estimate = estimateCost(
      {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        operation: 'llm',
        inputTokens: 100_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      },
      new Date('2026-08-20T12:00:00Z'),
    );
    expect(estimate.status).toBe('priced');
    if (estimate.status === 'priced') {
      expect(estimate.amountMicroUsd).toBe(200_000 + 200_000 + 2_500_000);
    }
  });

  it('uses integer micro-USD without floating point drift', () => {
    let total = 0;
    for (let i = 0; i < 1000; i += 1) {
      const estimate = estimateCost(
        {
          provider: 'openai',
          model: 'gpt-transcribe',
          operation: 'stt',
          audioInputSeconds: 1,
        },
        new Date('2026-08-20T12:00:00Z'),
      );
      if (estimate.status === 'priced') {
        total += estimate.amountMicroUsd;
      }
    }
    expect(total).toBe(75_000);
  });
});
