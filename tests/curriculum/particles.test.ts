import { describe, expect, it } from 'vitest';
import {
  PARTICLES,
  PARTICLE_BY_SURFACE,
  particleKey,
  particleOfKey,
} from '../../src/curriculum/particles.js';
import { SENTENCES } from '../../src/curriculum/sentences.js';
import {
  buildParticleBlank,
  usableForParticle,
} from '../../src/curriculum/writing.js';

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

function sentencesTesting(particleId: string): number {
  return SENTENCES.filter((sentence) => usableForParticle(sentence, particleId))
    .length;
}

describe('採録した助詞', () => {
  it('has a unique id and surface for each entry', () => {
    expect(new Set(PARTICLES.map((p) => p.id)).size).toBe(PARTICLES.length);
    expect(new Set(PARTICLES.map((p) => p.surface)).size).toBe(PARTICLES.length);
  });

  it('round-trips through the knowledge_items key', () => {
    for (const particle of PARTICLES) {
      expect(particleOfKey(particleKey(particle.id))).toEqual(particle);
    }
    expect(particleOfKey('vocab_x')).toBeUndefined();
    expect(particleOfKey('particle_nope')).toBeUndefined();
  });

  /**
   * 出せない問題を復習キューに積まない。
   *
   * 期限が来ても出す問題が無い項目は、学習者からは「/write が無反応」に
   * 見える。助詞は開放データの一覧が無く手で選んでいるので、材料の有無は
   * 機械で確かめる。ここが落ちたら、その助詞を消すかプールを増やす。
   */
  it('has enough sentences to drill every entry', () => {
    const thin: string[] = [];
    for (const particle of PARTICLES) {
      const count = sentencesTesting(particle.id);
      if (count < 20) thin.push(`${particle.surface} ${String(count)} 文`);
    }
    expect(thin).toEqual([]);
  });

  it('records a blankable count that matches the pool', () => {
    for (const particle of PARTICLES) {
      // 宣言した数と実測がずれたら、プールを作り直したのに
      // particles.ts を直し忘れている。
      expect(sentencesTesting(particle.id), particle.surface).toBe(
        particle.blankable,
      );
    }
  });
});

describe('複数文字の助詞', () => {
  /**
   * から・まで・より は二文字。答えの重複検査を一文字ずつで行っていた
   * ため、これらは**一度も出題されていなかった**——比較が常に不成立で
   * 候補から外れ、しかも誰にも見えなかった。
   */
  it.each(['kara', 'made', 'yori'])('can be asked about: %s', (id) => {
    const particle = PARTICLES.find((p) => p.id === id);
    expect(particle).toBeDefined();
    const sentence = SENTENCES.find((s) => usableForParticle(s, id));
    expect(sentence, `no sentence tests ${id}`).toBeDefined();
    if (sentence === undefined) return;

    const blank = buildParticleBlank(sentence, {
      optionCount: 4,
      random: seeded(11),
      particleId: id,
    });
    expect(blank?.answer).toBe(particle?.surface);
    expect(blank?.particleId).toBe(id);
    expect(blank?.prompt.match(/＿/g)).toHaveLength(1);
  });

  it('still refuses when the answer appears elsewhere in the sentence', () => {
    // 「今では」の で を隠しても「でも」の で が残る、という一文字の
    // 漏れも、部分文字列で数えれば同じ規則で防げる。
    for (const sentence of SENTENCES.slice(0, 600)) {
      const blank = buildParticleBlank(sentence, {
        optionCount: 4,
        random: seeded(31),
      });
      if (blank === undefined) continue;
      expect(blank.prompt.includes(blank.answer), sentence.text).toBe(false);
    }
  });
});

describe('選択肢', () => {
  /**
   * 誤答と正解が別の集合から来ていると、「見慣れない字が答え」という
   * 当て方が通ってしまう。
   */
  it('draws distractors from the same set as the answers', () => {
    for (const sentence of SENTENCES.slice(0, 400)) {
      const blank = buildParticleBlank(sentence, {
        optionCount: 5,
        random: seeded(4),
      });
      if (blank === undefined) continue;
      expect(blank.options).toHaveLength(5);
      expect(new Set(blank.options).size).toBe(5);
      for (const option of blank.options) {
        expect(PARTICLE_BY_SURFACE.has(option), option).toBe(true);
      }
      expect(blank.options).toContain(blank.answer);
    }
  });

  it('can ask about a specific particle when review is due', () => {
    for (const particle of PARTICLES) {
      const sentence = SENTENCES.find((s) => usableForParticle(s, particle.id));
      if (sentence === undefined) continue;
      const blank = buildParticleBlank(sentence, {
        optionCount: 4,
        random: seeded(17),
        particleId: particle.id,
      });
      expect(blank?.particleId, particle.surface).toBe(particle.id);
    }
  });
});
