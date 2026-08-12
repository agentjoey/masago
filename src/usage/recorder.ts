import type { NewUsageRecord } from '../db/schema/ops.js';
import { insert as insertUsageRecord } from '../db/repositories/usageRecords.js';
import type { Executor } from '../db/repositories/executor.js';
import type { Logger } from '../observability/index.js';
import { estimateCost } from './pricing.js';
import { microUsdToUsdString, type UsageRecordInput } from './types.js';

export type InsertUsageRecord = (record: NewUsageRecord) => Promise<unknown>;

export interface RecorderDeps {
  logger: Logger;
  insertRecord: InsertUsageRecord;
}

export function createRecorder(options: {
  executor: Executor;
  logger: Logger;
}): RecorderDeps {
  return {
    logger: options.logger,
    insertRecord: (record) => insertUsageRecord(options.executor, record),
  };
}

export async function recordUsage(
  deps: RecorderDeps,
  input: UsageRecordInput,
): Promise<void> {
  const at = input.at ?? new Date();
  const estimate = estimateCost(input, at);

  let estimatedCost: string | null;
  if (estimate.status === 'priced') {
    estimatedCost = microUsdToUsdString(estimate.amountMicroUsd);
  } else {
    estimatedCost = null;
    deps.logger.warn('unknown pricing for usage record', {
      provider: input.provider,
      model: input.model,
      operation: input.operation,
    });
  }

  const record: NewUsageRecord = {
    turnId: input.turnId,
    provider: input.provider,
    model: input.model,
    operation: input.operation,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cachedInputTokens: (input.cacheReadTokens ?? 0) + (input.cacheWriteTokens ?? 0),
    audioInputSeconds:
      input.audioInputSeconds === undefined ? undefined : String(input.audioInputSeconds),
    audioOutputSeconds:
      input.audioOutputSeconds === undefined ? undefined : String(input.audioOutputSeconds),
    ttsCharacters: input.ttsCharacters,
    providerReportedUnits: input.providerReportedUnits,
    estimatedCost,
    currency: 'USD',
    pricingVersion: estimate.pricingVersion,
    latencyMs: input.latencyMs,
    success: input.success,
    errorCode: input.errorCode,
    requestId: input.requestId,
  };

  try {
    await deps.insertRecord(record);
  } catch (error) {
    deps.logger.error('failed to record usage', {
      provider: input.provider,
      model: input.model,
      operation: input.operation,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
