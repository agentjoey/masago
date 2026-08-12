import type {
  PendingIssue,
  SessionMode,
  SurfacingConfig,
  SurfacingDirective,
} from './types.js';

export interface DecideSurfacingInput {
  mode: SessionMode;
  turnsSinceLastSurface: number;
  pending: PendingIssue[];
  explicitRequest: boolean;
  sessionEnding: boolean;
  config: SurfacingConfig;
}

const IMPORTANCE_RANK: Record<PendingIssue['importance'], number> = {
  HIGH: 0,
  MEDIUM: 1,
  LOW: 2,
};

export function compareByPriority(
  a: PendingIssue,
  b: PendingIssue,
): number {
  const rankDiff = IMPORTANCE_RANK[a.importance] - IMPORTANCE_RANK[b.importance];
  if (rankDiff !== 0) return rankDiff;
  const timeDiff = a.createdAt.getTime() - b.createdAt.getTime();
  if (timeDiff !== 0) return timeDiff;
  return a.id.localeCompare(b.id);
}

function turnsThreshold(mode: SessionMode, config: SurfacingConfig): number {
  return mode === 'COACH'
    ? config.surfaceAfterTurnsCoach
    : config.surfaceAfterTurnsConversation;
}

export function decideSurfacing(input: DecideSurfacingInput): SurfacingDirective {
  const { pending, config } = input;
  if (pending.length === 0) {
    return { action: 'HOLD' };
  }

  const turnsDue =
    input.turnsSinceLastSurface >= turnsThreshold(input.mode, config);
  const highCount = pending.filter((issue) => issue.importance === 'HIGH').length;
  const highImportanceDue = highCount >= config.highImportanceThreshold;

  const shouldSurface =
    turnsDue || highImportanceDue || input.explicitRequest || input.sessionEnding;
  if (!shouldSurface) {
    return { action: 'HOLD' };
  }

  const issues = [...pending]
    .sort(compareByPriority)
    .slice(0, config.surfaceMaxItems);
  return {
    action: 'SURFACE',
    issues,
    requestRetry: !input.sessionEnding,
  };
}
