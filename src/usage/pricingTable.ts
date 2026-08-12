import type { PriceEntry } from './types.js';

export const PRICING_VERSION = '2026-08-12';

const CACHE_READ: PriceEntry['cacheReadMultiplier'] = { numerator: 1, denominator: 10 };
const CACHE_WRITE: PriceEntry['cacheWriteMultiplier'] = { numerator: 125, denominator: 100 };

export const PRICE_TABLE: readonly PriceEntry[] = [
  {
    provider: 'minimax',
    model: 'speech-2.8-turbo',
    unit: 'characters',
    microUsdPerUnit: 60,
    effectiveFrom: '2026-08-12',
  },
  {
    provider: 'minimax',
    model: 'speech-2.8-hd',
    unit: 'characters',
    microUsdPerUnit: 100,
    effectiveFrom: '2026-08-12',
  },
  {
    provider: 'openai',
    model: 'gpt-transcribe',
    unit: 'seconds',
    microUsdPerUnit: 75,
    effectiveFrom: '2026-08-12',
  },
  {
    provider: 'openai',
    model: 'gpt-4o-transcribe',
    unit: 'seconds',
    microUsdPerUnit: 100,
    effectiveFrom: '2026-08-12',
  },
  {
    provider: 'openai',
    model: 'gpt-4o-mini-transcribe',
    unit: 'seconds',
    microUsdPerUnit: 50,
    effectiveFrom: '2026-08-12',
  },
  {
    provider: 'openai',
    model: 'whisper-1',
    unit: 'seconds',
    microUsdPerUnit: 100,
    effectiveFrom: '2026-08-12',
  },
  {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    unit: 'tokens',
    inputMicroUsdPerUnit: 2,
    outputMicroUsdPerUnit: 10,
    cacheReadMultiplier: CACHE_READ,
    cacheWriteMultiplier: CACHE_WRITE,
    effectiveFrom: '2026-08-12',
    effectiveTo: '2026-08-31',
  },
  {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    unit: 'tokens',
    inputMicroUsdPerUnit: 3,
    outputMicroUsdPerUnit: 15,
    cacheReadMultiplier: CACHE_READ,
    cacheWriteMultiplier: CACHE_WRITE,
    effectiveFrom: '2026-09-01',
  },
  {
    provider: 'anthropic',
    model: 'claude-opus-5',
    unit: 'tokens',
    inputMicroUsdPerUnit: 5,
    outputMicroUsdPerUnit: 25,
    cacheReadMultiplier: CACHE_READ,
    cacheWriteMultiplier: CACHE_WRITE,
    effectiveFrom: '2026-08-12',
  },
];
