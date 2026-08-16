import { describe, expect, it } from 'vitest';
import type { SurfacingConfig } from '../../src/corrections/index.js';
import type { LearnerProfile } from '../../src/db/schema/learner.js';
import {
  hintLevelFor,
  isHintRequest,
  learnerLevel,
  policyFor,
} from '../../src/sessions/modes.js';

function fakeProfile(levels: unknown = null): LearnerProfile {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    telegramUserId: 1,
    levels: levels as LearnerProfile['levels'],
    goals: null,
    preferences: null,
    profileSummary: null,
  roundStartedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

const DEFAULT_CONFIG: SurfacingConfig = {
  surfaceAfterTurnsConversation: 4,
  surfaceAfterTurnsCoach: 1,
  surfaceMaxItems: 3,
  highImportanceThreshold: 2,
};

describe('policyFor', () => {
  it('Conversation: 4 轮呈现、无 hint ladder、非沉浸', () => {
    const policy = policyFor('CONVERSATION', fakeProfile());
    expect(policy).toEqual({
      surfaceAfterTurns: 4,
      chineseAllowed: 'as-needed',
      hintLadder: false,
      immersive: false,
    });
  });

  it('Coach: 1 轮呈现、无 hint ladder、非沉浸', () => {
    const policy = policyFor('COACH', fakeProfile());
    expect(policy).toEqual({
      surfaceAfterTurns: 1,
      chineseAllowed: 'as-needed',
      hintLadder: false,
      immersive: false,
    });
  });

  it('Challenge: 4 轮呈现、hint ladder、沉浸、默认不出现中文', () => {
    const policy = policyFor('CHALLENGE', fakeProfile());
    expect(policy).toEqual({
      surfaceAfterTurns: 4,
      chineseAllowed: 'none',
      hintLadder: true,
      immersive: true,
    });
  });

  it('Challenge 对任何水平都不允许中文（数据表，无代码分支）', () => {
    for (const levels of [
      { overall: 'N5' },
      { overall: 'N3' },
      { overall: 'N1' },
      null,
    ]) {
      expect(policyFor('CHALLENGE', fakeProfile(levels)).chineseAllowed).toBe(
        'none',
      );
    }
  });

  it('中文策略由 profile.level × mode 决定', () => {
    expect(
      policyFor('CONVERSATION', fakeProfile({ overall: 'N5' })).chineseAllowed,
    ).toBe('as-needed');
    expect(
      policyFor('CONVERSATION', fakeProfile({ overall: 'N3' })).chineseAllowed,
    ).toBe('grammar-ok');
    expect(
      policyFor('CONVERSATION', fakeProfile({ overall: 'N1' })).chineseAllowed,
    ).toBe('nuance-only');
    expect(
      policyFor('COACH', fakeProfile({ grammar: 'intermediate' }))
        .chineseAllowed,
    ).toBe('grammar-ok');
  });

  it('surfaceAfterTurns 可由 config 覆盖，与 scheduler 同源', () => {
    const config: SurfacingConfig = {
      ...DEFAULT_CONFIG,
      surfaceAfterTurnsConversation: 2,
      surfaceAfterTurnsCoach: 3,
    };
    expect(
      policyFor('CONVERSATION', fakeProfile(), config).surfaceAfterTurns,
    ).toBe(2);
    expect(policyFor('COACH', fakeProfile(), config).surfaceAfterTurns).toBe(3);
    expect(
      policyFor('CHALLENGE', fakeProfile(), config).surfaceAfterTurns,
    ).toBe(2);
  });
});

describe('learnerLevel', () => {
  it('JLPT 映射', () => {
    expect(learnerLevel(fakeProfile({ speaking: 'N4' }))).toBe('beginner');
    expect(learnerLevel(fakeProfile({ reading: 'n3' }))).toBe('intermediate');
    expect(learnerLevel(fakeProfile({ reading: 'N1' }))).toBe('advanced');
  });

  it('显式阶段标签', () => {
    expect(learnerLevel(fakeProfile({ level: 'beginner' }))).toBe('beginner');
    expect(learnerLevel(fakeProfile({ level: 'advanced' }))).toBe('advanced');
  });

  it('无画像时默认 beginner', () => {
    expect(learnerLevel(fakeProfile(null))).toBe('beginner');
    expect(learnerLevel(fakeProfile({ foo: 42 }))).toBe('beginner');
  });
});

describe('hint ladder', () => {
  it('识别ヒント请求', () => {
    expect(isHintRequest('ヒント')).toBe(true);
    expect(isHintRequest(' ヒント ')).toBe(true);
    expect(isHintRequest('ヒントください')).toBe(false);
    expect(isHintRequest('hint')).toBe(false);
  });

  it('连续失败两次后才给关键词：第 1 次日语提示，第 2 次关键词，之后允许简短中文', () => {
    expect(hintLevelFor(0)).toBe(1);
    expect(hintLevelFor(1)).toBe(2);
    expect(hintLevelFor(2)).toBe(3);
    expect(hintLevelFor(5)).toBe(3);
  });
});

describe('zero level — 还读不出假名的人', () => {
  const profile = { levels: null } as unknown as Parameters<typeof policyFor>[1];

  // 实测：初日に「Hi」と送ったら全文日本語が返り、一文字も読めなかった。
  // beginner の as-needed は「必要なら中国語を添えてもよい」でしかない。
  it('makes chinese the main language, not an optional aside', () => {
    expect(
      policyFor('CONVERSATION', profile, undefined, 'zero').chineseAllowed,
    ).toBe('primary');
    expect(
      policyFor('CONVERSATION', profile, undefined, 'beginner').chineseAllowed,
    ).toBe('as-needed');
  });

  it('applies in coach mode too', () => {
    expect(policyFor('COACH', profile, undefined, 'zero').chineseAllowed).toBe(
      'primary',
    );
  });

  // 仮名が読めない段階で全日語没入は成立しない。
  it('overrides full immersion in challenge mode', () => {
    expect(
      policyFor('CHALLENGE', profile, undefined, 'zero').chineseAllowed,
    ).toBe('primary');
    expect(
      policyFor('CHALLENGE', profile, undefined, 'beginner').chineseAllowed,
    ).toBe('none');
  });

  it('falls back to the profile when no level is derived', () => {
    expect(policyFor('CONVERSATION', profile).chineseAllowed).toBe('as-needed');
  });
});
