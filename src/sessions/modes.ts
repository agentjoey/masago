import type { SessionMode, SurfacingConfig } from '../corrections/index.js';
import type { LearnerProfile } from '../db/schema/learner.js';

export type ChineseUsage = 'none' | 'nuance-only' | 'grammar-ok' | 'as-needed';
export type LearnerLevel = 'beginner' | 'intermediate' | 'advanced';
export type HintLevel = 1 | 2 | 3;

export interface ModePolicy {
  surfaceAfterTurns: number;
  chineseAllowed: ChineseUsage;
  hintLadder: boolean;
  immersive: boolean;
}

export const HINT_REQUEST_MARKER = 'ヒント';

export function isHintRequest(text: string): boolean {
  return text.trim() === HINT_REQUEST_MARKER;
}

export function hintLevelFor(previousHintCount: number): HintLevel {
  if (previousHintCount <= 0) return 1;
  if (previousHintCount === 1) return 2;
  return 3;
}

const CHINESE_USAGE_BY_MODE: Record<
  SessionMode,
  Record<LearnerLevel, ChineseUsage>
> = {
  CONVERSATION: {
    beginner: 'as-needed',
    intermediate: 'grammar-ok',
    advanced: 'nuance-only',
  },
  COACH: {
    beginner: 'as-needed',
    intermediate: 'grammar-ok',
    advanced: 'nuance-only',
  },
  CHALLENGE: {
    beginner: 'none',
    intermediate: 'none',
    advanced: 'none',
  },
};

const MODE_TRAITS: Record<
  SessionMode,
  { surfaceAfterTurns: number; hintLadder: boolean; immersive: boolean }
> = {
  CONVERSATION: { surfaceAfterTurns: 4, hintLadder: false, immersive: false },
  COACH: { surfaceAfterTurns: 1, hintLadder: false, immersive: false },
  CHALLENGE: { surfaceAfterTurns: 4, hintLadder: true, immersive: true },
};

function levelFromToken(token: string): LearnerLevel | undefined {
  const normalized = token.trim().toLowerCase();
  if (normalized === 'beginner' || normalized === 'n5' || normalized === 'n4') {
    return 'beginner';
  }
  if (
    normalized === 'intermediate' ||
    normalized === 'n3' ||
    normalized === 'n2'
  ) {
    return 'intermediate';
  }
  if (normalized === 'advanced' || normalized === 'n1') {
    return 'advanced';
  }
  return undefined;
}

export function learnerLevel(profile: LearnerProfile): LearnerLevel {
  const levels = profile.levels;
  if (levels !== null && typeof levels === 'object' && !Array.isArray(levels)) {
    for (const value of Object.values(levels)) {
      if (typeof value !== 'string') continue;
      const level = levelFromToken(value);
      if (level !== undefined) {
        return level;
      }
    }
  }
  return 'beginner';
}

export function policyFor(
  mode: SessionMode,
  profile: LearnerProfile,
  config?: SurfacingConfig,
): ModePolicy {
  const traits = MODE_TRAITS[mode];
  const surfaceAfterTurns =
    config === undefined
      ? traits.surfaceAfterTurns
      : mode === 'COACH'
        ? config.surfaceAfterTurnsCoach
        : config.surfaceAfterTurnsConversation;
  return {
    surfaceAfterTurns,
    chineseAllowed: CHINESE_USAGE_BY_MODE[mode][learnerLevel(profile)],
    hintLadder: traits.hintLadder,
    immersive: traits.immersive,
  };
}
