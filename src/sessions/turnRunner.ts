import type { Turn } from '../db/schema/session.js';
import type { Executor } from '../db/repositories/executor.js';
import { findByTelegramMessageId, updateStatus } from '../db/repositories/turns.js';
import type { Logger } from '../observability/index.js';
import type { UsageRecordInput } from '../usage/types.js';
import {
  assertTransition,
  chainIndex,
  type ChainStatus,
  type TurnStatus,
} from './turnStateMachine.js';

export interface TurnPatch {
  rawTranscript?: string;
  normalizedTranscript?: string;
  replyText?: string;
}

export interface StepOutcome {
  patch?: TurnPatch;
  requestId?: string;
  usage?: UsageRecordInput;
}

export interface TurnStep<C> {
  status: ChainStatus;
  execute(ctx: C): Promise<StepOutcome | void>;
}

export interface TurnStore {
  load(): Promise<Turn | undefined>;
  advance(status: TurnStatus, patch?: TurnPatch & { error?: string }): Promise<Turn>;
}

export class TurnNotFoundError extends Error {
  constructor() {
    super('turn not found');
    this.name = 'TurnNotFoundError';
  }
}

export class TurnStepFailedError extends Error {
  readonly failedAt: ChainStatus;
  readonly cause: unknown;

  constructor(failedAt: ChainStatus, cause: unknown) {
    super(`turn step ${failedAt} failed: ${errorMessage(cause)}`);
    this.name = 'TurnStepFailedError';
    this.failedAt = failedAt;
    this.cause = cause;
  }
}

export interface TurnFailure {
  failedAt: ChainStatus;
  message: string;
}

export function encodeTurnFailure(failedAt: ChainStatus, cause: unknown): string {
  const failure: TurnFailure = { failedAt, message: errorMessage(cause) };
  return JSON.stringify(failure);
}

const CHAIN_STATUSES: readonly string[] = [
  'RECEIVED',
  'AUDIO_READY',
  'AUDIO_NORMALIZED',
  'STT_DONE',
  'LLM_DONE',
  'PERSISTED',
  'TEXT_SENT',
  'VOICE_SENT',
  'COMPLETED',
];

export function parseTurnFailure(error: string | null): TurnFailure | undefined {
  if (error === null) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(error);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'failedAt' in parsed &&
      'message' in parsed &&
      typeof parsed.message === 'string' &&
      typeof parsed.failedAt === 'string' &&
      CHAIN_STATUSES.includes(parsed.failedAt)
    ) {
      return { failedAt: parsed.failedAt as ChainStatus, message: parsed.message };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export interface TurnRunnerDeps<C> {
  store: TurnStore;
  steps: readonly TurnStep<C>[];
  buildContext(turn: Turn): C;
  logger: Logger;
  recordUsage?(usage: UsageRecordInput): Promise<void>;
}

export async function runTurn<C>(deps: TurnRunnerDeps<C>): Promise<Turn> {
  const { store, steps, buildContext, logger, recordUsage } = deps;

  const turn = await store.load();
  if (turn === undefined) {
    throw new TurnNotFoundError();
  }
  if (turn.status === 'COMPLETED') {
    return turn;
  }

  let resumeIndex: number;
  if (turn.status === 'FAILED') {
    const failure = parseTurnFailure(turn.error);
    if (failure === undefined) {
      throw new TurnStepFailedError('RECEIVED', new Error('turn is FAILED but failure metadata is unreadable'));
    }
    resumeIndex = chainIndex(failure.failedAt);
    logger.info('resuming failed turn', {
      turnId: turn.id,
      failedAt: failure.failedAt,
    });
  } else {
    resumeIndex = chainIndex(turn.status as ChainStatus) + 1;
  }

  const ctx = buildContext(turn);
  let current = turn;

  for (const step of steps) {
    if (chainIndex(step.status) < resumeIndex) {
      continue;
    }
    assertTransition(current.status as TurnStatus, step.status);
    let outcome: StepOutcome | void;
    try {
      outcome = await step.execute(ctx);
    } catch (cause) {
      await store.advance('FAILED', {
        error: encodeTurnFailure(step.status, cause),
      });
      logger.error('turn step failed', {
        turnId: current.id,
        failedAt: step.status,
        error: errorMessage(cause),
      });
      throw new TurnStepFailedError(step.status, cause);
    }
    current = await store.advance(step.status, outcome?.patch);
    if (outcome?.requestId !== undefined) {
      logger.debug('turn step completed', {
        turnId: current.id,
        status: step.status,
        requestId: outcome.requestId,
      });
    }
    if (outcome?.usage !== undefined && recordUsage !== undefined) {
      await recordUsage(outcome.usage);
    }
  }

  return current;
}

export function createDrizzleTurnStore(options: {
  executor: Executor;
  telegramMessageId: number;
}): TurnStore {
  const { executor, telegramMessageId } = options;
  let turnId: string | undefined;
  return {
    async load() {
      const turn = await findByTelegramMessageId(executor, telegramMessageId);
      turnId = turn?.id;
      return turn;
    },
    advance(status, patch = {}) {
      if (turnId === undefined) {
        throw new TurnNotFoundError();
      }
      return updateStatus(executor, turnId, status, patch);
    },
  };
}
