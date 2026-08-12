import { PRICE_TABLE, PRICING_VERSION } from './pricingTable.js';
import type { CostEstimate, PriceEntry, Rational, UsageInput } from './types.js';

function utcDayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function isEffective(entry: PriceEntry, dayKey: string): boolean {
  if (dayKey < entry.effectiveFrom) {
    return false;
  }
  if (entry.effectiveTo !== undefined && dayKey > entry.effectiveTo) {
    return false;
  }
  return true;
}

export function priceFor(
  provider: string,
  model: string,
  at: Date,
): PriceEntry | undefined {
  const dayKey = utcDayKey(at);
  return PRICE_TABLE.find(
    (entry) =>
      entry.provider === provider &&
      entry.model === model &&
      isEffective(entry, dayKey),
  );
}

function scaleBy(units: number, microUsdPerUnit: number, multiplier?: Rational): number {
  const base = units * microUsdPerUnit;
  if (multiplier === undefined) {
    return base;
  }
  return Math.round((base * multiplier.numerator) / multiplier.denominator);
}

export function estimateCost(usage: UsageInput, at: Date): CostEstimate {
  const entry = priceFor(usage.provider, usage.model, at);
  if (entry === undefined) {
    return { status: 'unknown', pricingVersion: PRICING_VERSION };
  }

  let microUsd = 0;
  switch (entry.unit) {
    case 'tokens': {
      const inputPrice = entry.inputMicroUsdPerUnit ?? 0;
      const outputPrice = entry.outputMicroUsdPerUnit ?? 0;
      microUsd += scaleBy(usage.inputTokens ?? 0, inputPrice);
      microUsd += scaleBy(usage.outputTokens ?? 0, outputPrice);
      microUsd += scaleBy(usage.cacheReadTokens ?? 0, inputPrice, entry.cacheReadMultiplier);
      microUsd += scaleBy(usage.cacheWriteTokens ?? 0, inputPrice, entry.cacheWriteMultiplier);
      break;
    }
    case 'characters': {
      microUsd += scaleBy(usage.ttsCharacters ?? 0, entry.microUsdPerUnit ?? 0);
      break;
    }
    case 'seconds': {
      const seconds = (usage.audioInputSeconds ?? 0) + (usage.audioOutputSeconds ?? 0);
      microUsd += Math.round(seconds * (entry.microUsdPerUnit ?? 0));
      break;
    }
  }

  return {
    status: 'priced',
    amountMicroUsd: microUsd,
    amountUsd: microUsd / 1_000_000,
    pricingVersion: PRICING_VERSION,
  };
}
