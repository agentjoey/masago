import type { PriceEntry } from './types.js';

export const PRICING_VERSION = '2026-08-14';

const CACHE_READ: PriceEntry['cacheReadMultiplier'] = { numerator: 1, denominator: 10 };
const CACHE_WRITE: PriceEntry['cacheWriteMultiplier'] = { numerator: 125, denominator: 100 };

export const PRICE_TABLE: readonly PriceEntry[] = [
  /**
   * MiniMax-M3（会話・判定・解説の全 LLM 呼び出しがこれ）。
   *
   * 公式の恒久 50% 引き後：入力 $0.30/M、出力 $1.20/M、キャッシュ読み
   * $0.06/M（= 入力の 1/5）。>512K 入力は全体 2 倍だが、この用途では
   * 到達しない。キャッシュ書き込みの価格は公表に見当たらないので
   * 倍率を付けない＝入力単価で計上する。安全側（過大見積もり）に倒れる。
   *
   * 出典: https://openrouter.ai/minimax/minimax-m3 と公式価格表
   * （2026-08-14 確認）。**この行が無かったせいで、仮に記録されていても
   * LLM は全部「価格不明」になるところだった**——実際には記録自体も
   * 落ちていて usage_records は 0 行だった。
   */
  {
    provider: 'minimax',
    model: 'MiniMax-M3',
    unit: 'tokens',
    inputMicroUsdPerUnit: 0.3,
    outputMicroUsdPerUnit: 1.2,
    cacheReadMultiplier: { numerator: 1, denominator: 5 },
    effectiveFrom: '2026-08-14',
  },
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
