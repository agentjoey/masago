import type { Executor } from '../db/repositories/executor.js';
import {
  insertMany,
  listAwaitingRetry,
  listPending,
  markSurfaced,
  setRetryStatus,
} from '../db/repositories/detectedIssues.js';
import { insertMany as insertLearningEvents } from '../db/repositories/learningEvents.js';
import { getSessionCorrectionContext } from '../db/repositories/sessions.js';
import { countSessionTurnsSinceLastSurface } from '../db/repositories/turns.js';
import { decideSurfacing } from './scheduler.js';
import type {
  CorrectionTurnHooks,
  FinalizeSurfacingInput,
  PendingIssue,
  PrepareSurfacingInput,
  SurfacingConfig,
  SurfacingDirective,
} from './types.js';

export interface CorrectionTurnHooksDeps {
  executor: Executor;
  config: SurfacingConfig;
}

export interface RetryEvaluationVerdict {
  succeeded: boolean;
  feedback: string | null;
}

export interface RetryEvaluationPreparation {
  learnerId: string;
  issues: PendingIssue[];
}

export interface PrepareRetryEvaluationInput {
  sessionId: string;
}

export interface FinalizeRetryEvaluationInput {
  turnId: string;
  sessionId: string;
  preparation: RetryEvaluationPreparation;
  evaluation: RetryEvaluationVerdict | null;
}

export interface FinalizeTurnCorrectionsInput {
  retryEvaluation: FinalizeRetryEvaluationInput;
  surfacing: FinalizeSurfacingInput;
}

export interface RetryTurnHooks {
  prepareRetryEvaluation(
    input: PrepareRetryEvaluationInput,
  ): Promise<RetryEvaluationPreparation | undefined>;
  finalizeRetryEvaluation(input: FinalizeRetryEvaluationInput): Promise<void>;
  finalizeTurnCorrections(input: FinalizeTurnCorrectionsInput): Promise<void>;
}

export interface CorrectionTurnHooksWithRetry
  extends CorrectionTurnHooks,
    RetryTurnHooks {}

export function asRetryTurnHooks(
  hooks: CorrectionTurnHooks,
): RetryTurnHooks | undefined {
  const candidate = hooks as CorrectionTurnHooks & Partial<RetryTurnHooks>;
  if (
    typeof candidate.prepareRetryEvaluation === 'function' &&
    typeof candidate.finalizeRetryEvaluation === 'function'
  ) {
    return candidate as RetryTurnHooks;
  }
  return undefined;
}

async function inTransaction(
  executor: Executor,
  fn: (tx: Executor) => Promise<void>,
): Promise<void> {
  if ('transaction' in executor) {
    await executor.transaction(async (tx) => {
      await fn(tx);
    });
    return;
  }
  await fn(executor);
}

export function retrySucceededDedupeKey(issueId: string): string {
  return `retry_succeeded:${issueId}`;
}

export function createCorrectionTurnHooks(
  deps: CorrectionTurnHooksDeps,
): CorrectionTurnHooksWithRetry {
  async function prepareSurfacing(
    input: PrepareSurfacingInput,
  ): Promise<SurfacingDirective> {
    const session = await getSessionCorrectionContext(
      deps.executor,
      input.sessionId,
    );
    if (session === undefined) {
      throw new Error('correction hooks: session not found');
    }
    const [pending, turnsSinceLastSurface] = await Promise.all([
      listPending(deps.executor, session.learnerId),
      countSessionTurnsSinceLastSurface(deps.executor, input.sessionId),
    ]);
    return decideSurfacing({
      mode: session.mode,
      turnsSinceLastSurface,
      pending,
      explicitRequest: input.explicitRequest ?? false,
      sessionEnding: input.sessionEnding ?? false,
      config: deps.config,
    });
  }

  async function applySurfacing(
    tx: Executor,
    input: FinalizeSurfacingInput,
  ): Promise<void> {
    await insertMany(
      tx,
      input.detectedIssues.map((issue) => ({
        turnId: input.turnId,
        sessionId: input.sessionId,
        knowledgeKey: issue.knowledgeKey,
        original: issue.original,
        recommended: issue.recommended,
        reason: issue.reason,
        naturalAlternative: issue.naturalAlternative,
        importance: issue.importance,
      })),
    );
    if (input.directive.action === 'SURFACE') {
      await markSurfaced(
        tx,
        input.directive.issues.map((issue) => issue.id),
        undefined,
        { retryRequested: input.directive.requestRetry },
      );
    }
  }

  async function finalizeSurfacing(
    input: FinalizeSurfacingInput,
  ): Promise<void> {
    await inTransaction(deps.executor, async (tx) => {
      await applySurfacing(tx, input);
    });
  }

  async function prepareRetryEvaluation(
    input: PrepareRetryEvaluationInput,
  ): Promise<RetryEvaluationPreparation | undefined> {
    const session = await getSessionCorrectionContext(
      deps.executor,
      input.sessionId,
    );
    if (session === undefined) {
      throw new Error('correction hooks: session not found');
    }
    const issues = await listAwaitingRetry(deps.executor, session.learnerId);
    if (issues.length === 0) {
      return undefined;
    }
    return { learnerId: session.learnerId, issues };
  }

  async function applyRetryEvaluation(
    tx: Executor,
    input: FinalizeRetryEvaluationInput,
  ): Promise<void> {
    if (input.evaluation === null || input.preparation.issues.length === 0) {
      return;
    }
    const verdict = input.evaluation;
    const updated = await setRetryStatus(
      tx,
      input.preparation.issues.map((issue) => issue.id),
      verdict.succeeded ? 'SUCCEEDED' : 'FAILED',
    );
    if (!verdict.succeeded || updated.length === 0) {
      return;
    }
    await insertLearningEvents(
      tx,
      updated.map((issue) => ({
        learnerId: input.preparation.learnerId,
        turnId: input.turnId,
        ...(issue.knowledgeItemId !== null
          ? { knowledgeItemId: issue.knowledgeItemId }
          : {}),
        eventType: 'RETRY_SUCCEEDED' as const,
        evidence: {
          issueId: issue.id,
          knowledgeKey: issue.knowledgeKey,
          original: issue.original,
          recommended: issue.recommended,
          feedback: verdict.feedback,
        },
        dedupeKey: retrySucceededDedupeKey(issue.id),
      })),
    );
  }

  async function finalizeRetryEvaluation(
    input: FinalizeRetryEvaluationInput,
  ): Promise<void> {
    await inTransaction(deps.executor, async (tx) => {
      await applyRetryEvaluation(tx, input);
    });
  }

  async function finalizeTurnCorrections(
    input: FinalizeTurnCorrectionsInput,
  ): Promise<void> {
    await inTransaction(deps.executor, async (tx) => {
      await applyRetryEvaluation(tx, input.retryEvaluation);
      await applySurfacing(tx, input.surfacing);
    });
  }

  return {
    prepareSurfacing,
    finalizeSurfacing,
    prepareRetryEvaluation,
    finalizeRetryEvaluation,
    finalizeTurnCorrections,
  };
}
