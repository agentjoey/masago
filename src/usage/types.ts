export type PricingUnit = 'tokens' | 'characters' | 'seconds';

export interface Rational {
  numerator: number;
  denominator: number;
}

export interface PriceEntry {
  provider: string;
  model: string;
  unit: PricingUnit;
  inputMicroUsdPerUnit?: number;
  outputMicroUsdPerUnit?: number;
  microUsdPerUnit?: number;
  cacheReadMultiplier?: Rational;
  cacheWriteMultiplier?: Rational;
  effectiveFrom: string;
  effectiveTo?: string;
}

export interface UsageInput {
  provider: string;
  model: string;
  operation: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  audioInputSeconds?: number;
  audioOutputSeconds?: number;
  ttsCharacters?: number;
  providerReportedUnits?: Record<string, unknown>;
}

export type CostEstimate =
  | {
      status: 'priced';
      amountMicroUsd: number;
      amountUsd: number;
      pricingVersion: string;
    }
  | {
      status: 'unknown';
      pricingVersion: string;
    };

export interface UsageRecordInput extends UsageInput {
  turnId?: string;
  latencyMs?: number;
  success: boolean;
  errorCode?: string;
  requestId?: string;
  at?: Date;
}

export const MICRO_USD_PER_USD = 1_000_000;

export function microUsdToUsdString(microUsd: number): string {
  const sign = microUsd < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(microUsd));
  const intPart = Math.trunc(abs / MICRO_USD_PER_USD);
  const fracPart = String(abs % MICRO_USD_PER_USD).padStart(6, '0');
  return `${sign}${intPart}.${fracPart}`;
}

export function usdStringToMicroUsd(usd: string): number {
  const value = Number.parseFloat(usd);
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.round(value * MICRO_USD_PER_USD);
}
