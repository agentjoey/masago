import { describe, expect, it } from 'vitest';
import {
  SCENES,
  SCENE_BY_ID,
  matchFormsOf,
  sceneProgress,
  sceneSentences,
  sceneVocab,
  scenesOfVocab,
} from '../../src/curriculum/scenes.js';
import { VOCAB } from '../../src/curriculum/vocab.js';

describe('場面の定義', () => {
  it('has a unique id and name for each scene', () => {
    expect(new Set(SCENES.map((s) => s.id)).size).toBe(SCENES.length);
    expect(new Set(SCENES.map((s) => s.name)).size).toBe(SCENES.length);
    for (const scene of SCENES) {
      expect(SCENE_BY_ID.get(scene.id)).toBe(scene);
    }
  });

  /**
   * 場面のまとめ方は手書きだが、まとめている語は語彙表のものに限る。
   *
   * ここが落ちるのは、語彙表に無い表記を書いたとき（「ご飯」は
   * 表では「御飯」、「円」は「～円」）。黙って一語欠けると、その語だけ
   * 場面から漏れて誰も気づかない。
   */
  it('only names words that exist in the vocabulary list', () => {
    const known = new Set(VOCAB.map((entry) => entry.expression));
    const missing: string[] = [];
    for (const scene of SCENES) {
      for (const word of scene.words) {
        if (!known.has(word)) missing.push(`${scene.id}: ${word}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('never lists the same word twice in one scene', () => {
    for (const scene of SCENES) {
      expect(new Set(scene.words).size, scene.id).toBe(scene.words.length);
    }
  });

  /**
   * 表記が同じで読みの違う項目が語彙表に 13 組ある（「～時」は じ と とき、
   * 「明日」は あした と あす）。どちらも同じ場面の語なので、
   * 引ける項目数は語数以上になる——一対一を期待しない。
   */
  it('resolves every word to at least one vocabulary entry', () => {
    for (const scene of SCENES) {
      const found = new Set(
        sceneVocab(scene).map((entry) => entry.expression),
      );
      for (const word of scene.words) {
        expect(found.has(word), `${scene.id}: ${word}`).toBe(true);
      }
      expect(sceneVocab(scene).length).toBeGreaterThanOrEqual(
        scene.words.length,
      );
    }
  });

  /** 接尾辞は表では `～円`。文中には `円` としか出ないので落とす。 */
  it('strips the affix marker before matching sentences', () => {
    const shopping = SCENE_BY_ID.get('shopping');
    expect(shopping).toBeDefined();
    if (shopping === undefined) return;
    const forms = matchFormsOf(shopping);
    expect(forms.has('円')).toBe(true);
    expect(forms.has('～円')).toBe(false);
  });
});

describe('場面の例文', () => {
  /**
   * どの場面にも読める文がある。
   *
   * Genki の課をそのまま場面にすると 6 課分が 0 文になった——場面を
   * 選んだのに何も出ない、という状態を作らないための検査。
   */
  it('finds sentences for every scene', () => {
    const thin: string[] = [];
    for (const scene of SCENES) {
      const count = sceneSentences(scene).length;
      if (count < 60) thin.push(`${scene.name} ${String(count)} 文`);
    }
    expect(thin).toEqual([]);
  });

  it('has translated sentences for every scene', () => {
    const thin: string[] = [];
    for (const scene of SCENES) {
      const count = sceneSentences(scene).filter(
        (sentence) => sentence.zh !== undefined,
      ).length;
      if (count < 20) thin.push(`${scene.name} ${String(count)} 文`);
    }
    expect(thin).toEqual([]);
  });

  it('puts the sentences that use the scene most at the front', () => {
    for (const scene of SCENES) {
      const forms = matchFormsOf(scene);
      const sentences = sceneSentences(scene);
      const hitsOf = (index: number): number => {
        const sentence = sentences[index];
        if (sentence === undefined) return 0;
        const seen = new Set<string>();
        for (const token of sentence.tokens) {
          if (forms.has(token.s)) seen.add(token.s);
        }
        return seen.size;
      };
      // 先頭のほうが末尾より当たりが多い（同じことはあっても逆は無い）
      expect(hitsOf(0), scene.id).toBeGreaterThanOrEqual(
        hitsOf(sentences.length - 1),
      );
    }
  });

  it('only returns sentences that contain at least one scene word', () => {
    for (const scene of SCENES.slice(0, 4)) {
      const forms = matchFormsOf(scene);
      for (const sentence of sceneSentences(scene).slice(0, 50)) {
        const hit = sentence.tokens.some((token) => forms.has(token.s));
        expect(hit, `${scene.id}: ${sentence.text}`).toBe(true);
      }
    }
  });
});

describe('場面の進み具合', () => {
  it('counts nothing learned for a fresh learner', () => {
    const progress = sceneProgress(new Set<string>());
    expect(progress).toHaveLength(SCENES.length);
    for (const entry of progress) {
      expect(entry.learned).toBe(0);
      expect(entry.total).toBeGreaterThan(0);
    }
  });

  it('counts the words the learner has met', () => {
    const meal = SCENE_BY_ID.get('meal');
    if (meal === undefined) throw new Error('no meal scene');
    const first = sceneVocab(meal)[0];
    if (first === undefined) throw new Error('no words');
    const progress = sceneProgress(new Set([first.id]));
    const mealProgress = progress.find((p) => p.scene.id === 'meal');
    expect(mealProgress?.learned).toBe(1);
  });

  it('maps a word back to the scenes it belongs to', () => {
    const meal = SCENE_BY_ID.get('meal');
    if (meal === undefined) throw new Error('no meal scene');
    const word = sceneVocab(meal)[0];
    if (word === undefined) throw new Error('no words');
    expect(scenesOfVocab(word.id).map((s) => s.id)).toContain('meal');
    expect(scenesOfVocab('does-not-exist')).toEqual([]);
  });
});

describe('場面で絞った出題', () => {
  it('only draws sentences from the chosen scene', async () => {
    const { buildReadingQuestion } = await import(
      '../../src/learning/readingSession.js'
    );
    const seeded = (seed: number) => {
      let state = seed;
      return () => {
        state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
        return state / 4_294_967_296;
      };
    };

    for (const scene of SCENES) {
      const forms = matchFormsOf(scene);
      let asked = 0;
      for (let seed = 1; seed <= 8; seed += 1) {
        const next = buildReadingQuestion(new Set<string>(), {
          optionCount: 4,
          random: seeded(seed * 13),
          sceneId: scene.id,
        });
        if (next === undefined) continue;
        asked += 1;
        const hit = next.sentence.tokens.some((token) => forms.has(token.s));
        expect(hit, `${scene.name}: ${next.sentence.text}`).toBe(true);
        // 訳が無いと意味を問えない
        expect(next.sentence.zh, next.sentence.text).toBeDefined();
      }
      expect(asked, `${scene.name} produced no questions`).toBeGreaterThan(0);
    }
  });

  it('falls back to the whole pool for an unknown scene id', async () => {
    const { buildReadingQuestion } = await import(
      '../../src/learning/readingSession.js'
    );
    const next = buildReadingQuestion(new Set<string>(), {
      optionCount: 4,
      random: () => 0.5,
      sceneId: 'not-a-scene',
    });
    expect(next).toBeDefined();
  });
});

describe('進度の分母は一箇所から', () => {
  /**
   * 実機で Mini App が 1301、週報が 1374 と違う数字を出していた。
   * 原因は片方が `VOCAB.length` を直接使っていたこと——接尾辞
   * （`～円`『～分』など）は単独では教えないので分母に入らない。
   *
   * 数え方を二箇所に書くと必ずずれる。ここで固定する。
   */
  it('never counts affixes as teachable vocabulary', async () => {
    const { vocabProgress } = await import('../../src/curriculum/stage.js');
    const { VOCAB } = await import('../../src/curriculum/vocab.js');
    const teachable = vocabProgress([]).total;
    const affixes = VOCAB.filter((entry) => entry.isAffix === true).length;
    expect(affixes).toBeGreaterThan(0);
    expect(teachable).toBe(VOCAB.length - affixes);
  });

  it('gives the report and the mini app the same denominator', async () => {
    const { vocabProgress } = await import('../../src/curriculum/stage.js');
    // loadProgress（Mini App）も collectReportFacts（週報）も
    // この一つの関数を通ること。直接 VOCAB.length を読んでいないか、
    // ソースを見て確かめる。
    const { readFileSync } = await import('node:fs');
    // 註釈は外してから見る。「使ってはいけない」と書いた文まで拾って
    // しまうと、規則を説明できなくなる。
    const stripComments = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const path of [
      'src/miniapp/data.ts',
      'src/learning/reportFacts.ts',
    ]) {
      const code = stripComments(readFileSync(path, 'utf8'));
      expect(code, `${path} 内で VOCAB.length を直接使っている`).not.toMatch(
        /VOCAB\.length/,
      );
    }
    expect(vocabProgress([]).total).toBeGreaterThan(1000);
  });
});
