import type { importance, sessionMode } from '../db/schema/enums.js';
import type { DetectedIssue } from '../db/schema/session.js';

export type SessionMode = (typeof sessionMode.enumValues)[number];
export type Importance = (typeof importance.enumValues)[number];

export type PendingIssue = DetectedIssue;

export interface SurfacingConfig {
  surfaceAfterTurnsConversation: number;
  surfaceAfterTurnsCoach: number;
  surfaceMaxItems: number;
  highImportanceThreshold: number;
}

export type SurfacingDirective =
  | { action: 'HOLD' }
  | { action: 'SURFACE'; issues: PendingIssue[]; requestRetry: boolean };

export interface NewPendingIssue {
  knowledgeKey: string;
  original: string;
  recommended: string;
  reason: string | null;
  naturalAlternative: string | null;
  importance: Importance;
}

export interface PrepareSurfacingInput {
  turnId: string;
  sessionId: string;
  explicitRequest?: boolean;
  sessionEnding?: boolean;
}

export interface FinalizeSurfacingInput {
  turnId: string;
  sessionId: string;
  directive: SurfacingDirective;
  detectedIssues: NewPendingIssue[];
}

export interface CorrectionTurnHooks {
  prepareSurfacing(input: PrepareSurfacingInput): Promise<SurfacingDirective>;
  finalizeSurfacing(input: FinalizeSurfacingInput): Promise<void>;
}
