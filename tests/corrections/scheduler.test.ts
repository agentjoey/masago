import { describe, expect, it } from 'vitest';
import {
  compareByPriority,
  decideSurfacing,
  type DecideSurfacingInput,
  type PendingIssue,
  type SurfacingConfig,
  type SurfacingDirective,
} from '../../src/corrections/index.js';

const DEFAULT_CONFIG: SurfacingConfig = {
  surfaceAfterTurnsConversation: 4,
  surfaceAfterTurnsCoach: 1,
  surfaceMaxItems: 3,
  highImportanceThreshold: 2,
};

let seq = 0;

function makeIssue(overrides: Partial<PendingIssue> = {}): PendingIssue {
  seq += 1;
  return {
    id: overrides.id ?? `issue-${seq}`,
    turnId: 'turn-1',
    sessionId: 'session-1',
    knowledgeItemId: null,
    knowledgeKey: 'verb_masu_past',
    original: `original-${seq}`,
    recommended: `recommended-${seq}`,
    reason: null,
    naturalAlternative: null,
    importance: 'MEDIUM',
    surfacedAt: null,
    retryStatus: 'NONE',
  source: 'LLM' as const,
    createdAt: new Date(Date.UTC(2026, 7, 1, 0, 0, seq)),
    ...overrides,
  };
}

function decide(overrides: Partial<DecideSurfacingInput>): SurfacingDirective {
  return decideSurfacing({
    mode: 'CONVERSATION',
    turnsSinceLastSurface: 0,
    pending: [makeIssue()],
    explicitRequest: false,
    sessionEnding: false,
    config: DEFAULT_CONFIG,
    ...overrides,
  });
}

function expectHold(directive: SurfacingDirective): void {
  expect(directive.action).toBe('HOLD');
}

function expectSurface(directive: SurfacingDirective): void {
  expect(directive.action).toBe('SURFACE');
}

describe('decideSurfacing', () => {
  it('HOLDs when below the turns threshold with no other trigger', () => {
    expectHold(decide({ turnsSinceLastSurface: 1 }));
    expectHold(decide({ turnsSinceLastSurface: 3 }));
  });

  it('SURFACEs when the turns threshold is reached', () => {
    expectSurface(decide({ turnsSinceLastSurface: 4 }));
    expectSurface(decide({ turnsSinceLastSurface: 5 }));
  });

  it('treats Coach mode as the same mechanism with threshold 1: first turn SURFACEs', () => {
    expectSurface(decide({ mode: 'COACH', turnsSinceLastSurface: 1 }));
  });

  it('has no Coach-specific branch: a different Coach threshold changes the rhythm via config only', () => {
    const config: SurfacingConfig = { ...DEFAULT_CONFIG, surfaceAfterTurnsCoach: 2 };
    expectHold(decide({ mode: 'COACH', turnsSinceLastSurface: 1, config }));
    expectSurface(decide({ mode: 'COACH', turnsSinceLastSurface: 2, config }));
  });

  it('SURFACEs early when HIGH-importance pending reaches the threshold, even below the turns threshold', () => {
    const pending = [
      makeIssue({ importance: 'HIGH' }),
      makeIssue({ importance: 'HIGH' }),
    ];
    expectSurface(decide({ turnsSinceLastSurface: 1, pending }));
  });

  it('HOLDs when HIGH-importance pending is below the threshold', () => {
    const pending = [
      makeIssue({ importance: 'HIGH' }),
      makeIssue({ importance: 'LOW' }),
    ];
    expectHold(decide({ turnsSinceLastSurface: 1, pending }));
  });

  it('SURFACEs immediately on an explicit user request', () => {
    expectSurface(decide({ explicitRequest: true, turnsSinceLastSurface: 0 }));
  });

  it('SURFACEs remaining issues when the session is ending, without requesting retry', () => {
    const directive = decide({ sessionEnding: true, turnsSinceLastSurface: 0 });
    expectSurface(directive);
    if (directive.action === 'SURFACE') {
      expect(directive.requestRetry).toBe(false);
    }
  });

  it('requests retry on a regular SURFACE', () => {
    const directive = decide({ turnsSinceLastSurface: 4 });
    if (directive.action !== 'SURFACE') {
      throw new Error('expected SURFACE');
    }
    expect(directive.requestRetry).toBe(true);
  });

  it('surfaces at most SURFACE_MAX_ITEMS, ordered by importance then oldest first', () => {
    const pending = [
      makeIssue({ id: 'low-1', importance: 'LOW' }),
      makeIssue({ id: 'medium-1', importance: 'MEDIUM' }),
      makeIssue({ id: 'high-1', importance: 'HIGH' }),
      makeIssue({ id: 'high-2', importance: 'HIGH' }),
      makeIssue({ id: 'medium-2', importance: 'MEDIUM' }),
    ];
    const directive = decide({ turnsSinceLastSurface: 4, pending });
    if (directive.action !== 'SURFACE') {
      throw new Error('expected SURFACE');
    }
    expect(directive.issues.map((issue) => issue.id)).toEqual([
      'high-1',
      'high-2',
      'medium-1',
    ]);
    const surfacedIds = new Set(directive.issues.map((issue) => issue.id));
    const unselected = pending
      .filter((issue) => !surfacedIds.has(issue.id))
      .sort(compareByPriority);
    expect(unselected.map((issue) => issue.id)).toEqual(['medium-2', 'low-1']);
  });

  it('HOLDs when pending is empty even if the turns condition is met', () => {
    expectHold(decide({ turnsSinceLastSurface: 4, pending: [] }));
    expectHold(
      decide({ turnsSinceLastSurface: 99, pending: [], explicitRequest: true }),
    );
  });
});
