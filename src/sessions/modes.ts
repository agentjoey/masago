import type { SessionMode, SurfacingConfig } from '../corrections/index.js';
import type { LearnerProfile } from '../db/schema/learner.js';

export type ChineseUsage =
  | 'none'
  | 'nuance-only'
  | 'grammar-ok'
  | 'as-needed'
  /** 中国語が主。日本語は短い一言だけ添える。 */
  | 'primary';

/**
 * `zero` は「まだ仮名が読めない」段階。
 *
 * これが無いと、初日の学習者に日本語だけの返事が届く（実測：初回の
 * 「Hi」に対して全文日本語が返り、一文字も読めなかった）。beginner の
 * as-needed は「必要なら中国語を添えてもよい」でしかなく、本文は日本語の
 * ままなので、読めない人には何も伝わらない。
 */
export type LearnerLevel = 'zero' | 'beginner' | 'intermediate' | 'advanced';
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
    zero: 'primary',
    beginner: 'as-needed',
    intermediate: 'grammar-ok',
    advanced: 'nuance-only',
  },
  COACH: {
    zero: 'primary',
    beginner: 'as-needed',
    intermediate: 'grammar-ok',
    advanced: 'nuance-only',
  },
  CHALLENGE: {
    // 仮名が読めない段階では全日語没入は成立しない。挑戦モードでも
    // 読めるものを出す。
    zero: 'primary',
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
  /**
   * 課程の進み具合から出した水準。渡された場合はプロフィールより優先する。
   *
   * 水準は本来「何をどこまで習ったか」の関数で、プロフィールに書いた文字列
   * ではない。仮名を一つも知らない人に日本語で返せば、そこに何が書いてあっても
   * 読めない。
   */
  levelOverride?: LearnerLevel,
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
    chineseAllowed:
      CHINESE_USAGE_BY_MODE[mode][levelOverride ?? learnerLevel(profile)],
    hintLadder: traits.hintLadder,
    immersive: traits.immersive,
  };
}
