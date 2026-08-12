import type { Executor } from '../db/repositories/executor.js';
import {
  countSessionTurnsSinceLastSurface,
  getSessionCorrectionContext,
  insertMany,
  listPending,
  markSurfaced,
} from '../db/repositories/detectedIssues.js';
import { decideSurfacing } from './scheduler.js';
import type {
  CorrectionTurnHooks,
  FinalizeSurfacingInput,
  PrepareSurfacingInput,
  SurfacingConfig,
  SurfacingDirective,
} from './types.js';

export interface CorrectionTurnHooksDeps {
  executor: Executor;
  config: SurfacingConfig;
}

export function createCorrectionTurnHooks(
  deps: CorrectionTurnHooksDeps,
): CorrectionTurnHooks {
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

  async function finalizeSurfacing(
    input: FinalizeSurfacingInput,
  ): Promise<void> {
    await insertMany(
      deps.executor,
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
        deps.executor,
        input.directive.issues.map((issue) => issue.id),
        undefined,
        { retryRequested: input.directive.requestRetry },
      );
    }
  }

  return { prepareSurfacing, finalizeSurfacing };
}
