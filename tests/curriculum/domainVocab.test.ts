import { describe, expect, it } from 'vitest';
import {
  DOMAINS,
  DOMAIN_VOCAB,
  DOMAIN_BY_ID,
  domainKey,
  domainVocabOf,
  domainVocabOfKey,
} from '../../src/curriculum/domainVocab.js';
import {
  buildDomainQuestion,
  domainKindFor,
  decodeDomainAnswer,
  encodeDomainAnswer,
} from '../../src/learning/domainSession.js';

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

describe('分野別語彙のデータ', () => {
  it('covers the three domains that were asked for', () => {
    expect(DOMAINS.map((d) => d.id)).toEqual(['business', 'golf', 'tech']);
    for (const domain of DOMAINS) {
      expect(domainVocabOf(domain.id).length, domain.id).toBeGreaterThan(50);
    }
  });

  it('has a unique id and a reading for every entry', () => {
    expect(new Set(DOMAIN_VOCAB.map((e) => e.id)).size).toBe(DOMAIN_VOCAB.length);
    for (const entry of DOMAIN_VOCAB) {
      expect(entry.reading, entry.expression).not.toBe('');
      expect(entry.meaning, entry.expression).not.toBe('');
      // 読みは仮名だけ。漢字が混じっていると振り仮名にも音声にも使えない。
      expect(entry.reading, entry.expression).toMatch(/^[ぁ-んァ-ヴー・]+$/u);
    }
  });

  it('round-trips through the knowledge_items key', () => {
    for (const entry of DOMAIN_VOCAB.slice(0, 40)) {
      expect(domainVocabOfKey(domainKey(entry.id))).toEqual(entry);
    }
    expect(domainVocabOfKey('vocab_x')).toBeUndefined();
    expect(domainVocabOfKey('domain_nope')).toBeUndefined();
  });

  /**
   * Telegram のコールバックは 64 バイトまで。id に表記を入れていた頃は
   * `business#グローバルバリューチェーン` のような語で **88 バイト**に達し、
   * 36 語が単独でも超えていた。
   */
  it('keeps every callback payload inside the 64-byte limit', () => {
    let worst = 0;
    for (const a of DOMAIN_VOCAB) {
      for (const b of domainVocabOf(a.domain).slice(0, 5)) {
        const size = Buffer.byteLength(encodeDomainAnswer(a.id, b.id), 'utf8');
        worst = Math.max(worst, size);
      }
    }
    expect(worst).toBeLessThanOrEqual(64);
  });

  /**
   * 語義はそのままボタンの札になる。JMdict には括弧書きの長い説明が
   * 付くことがあり（100 字超）、札に載せると読めない。
   */
  it('keeps every gloss short enough to be a button label', () => {
    const tooLong = DOMAIN_VOCAB.filter((e) => e.meaning.length > 60);
    expect(tooLong.map((e) => `${e.expression}: ${String(e.meaning.length)}`)).toEqual(
      [],
    );
  });

  it('names the three domains in Chinese, like the rest of the interface', () => {
    for (const domain of DOMAINS) {
      expect(DOMAIN_BY_ID.get(domain.id)?.name).toBe(domain.name);
      expect(domain.name).not.toMatch(/^[a-z]+$/);
    }
  });
});

describe('分野別の出題', () => {
  const golf = domainVocabOf('golf');
  const first = golf[0];
  if (first === undefined) throw new Error('no golf vocabulary');

  it('asks for the meaning first, then the word', () => {
    expect(domainKindFor(0)).toBe('WORD_TO_MEANING');
    expect(domainKindFor(1)).toBe('WORD_TO_MEANING');
    expect(domainKindFor(2)).toBe('MEANING_TO_WORD');
  });

  it('builds a four-option question', () => {
    const question = buildDomainQuestion(first, {
      kind: 'WORD_TO_MEANING',
      optionCount: 4,
      random: seeded(3),
    });
    expect(question?.options).toHaveLength(4);
    expect(question?.options.map((o) => o.entryId)).toContain(first.id);
    expect(question?.correctIds).toContain(first.id);
  });

  /**
   * 誤答は同じ分野から採る。分野を跨ぐと「ゴルフの話に商談の語が
   * 混じっている」だけで消去法が通ってしまう。
   */
  it('never mixes distractors from another domain', () => {
    for (const [index, target] of DOMAIN_VOCAB.slice(0, 120).entries()) {
      const question = buildDomainQuestion(target, {
        kind: 'WORD_TO_MEANING',
        optionCount: 4,
        random: seeded(index + 1),
      });
      if (question === undefined) continue;
      for (const option of question.options) {
        const entry = DOMAIN_VOCAB.find((e) => e.id === option.entryId);
        expect(entry?.domain, `${target.expression} / ${option.label}`).toBe(
          target.domain,
        );
      }
    }
  });

  /**
   * 同じ語義の語が同じ分野に居ることがある（`アプローチ` と
   * `アプローチショット` はどちらも approach shot）。並べたうえで
   * 片方だけを正解にすると、分かっている学習者に ❌ が出る。
   */
  it('never shows the same label twice in one question', () => {
    for (const kind of ['WORD_TO_MEANING', 'MEANING_TO_WORD'] as const) {
      for (const [index, target] of DOMAIN_VOCAB.slice(0, 150).entries()) {
        const question = buildDomainQuestion(target, {
          kind,
          optionCount: 4,
          random: seeded(index * 3 + 7),
        });
        if (question === undefined) continue;
        const labels = question.options.map((o) => o.label);
        expect(new Set(labels).size, labels.join(' | ')).toBe(labels.length);
      }
    }
  });

  it('shows the reading when the word is not already kana', () => {
    const kanji = DOMAIN_VOCAB.find((e) => e.reading !== e.expression);
    if (kanji === undefined) return;
    const question = buildDomainQuestion(kanji, {
      kind: 'WORD_TO_MEANING',
      optionCount: 4,
      random: seeded(5),
    });
    expect(question?.promptReading).toBe(kanji.reading);
  });

  it('round-trips the callback payload', () => {
    const data = encodeDomainAnswer('g1', 'g2');
    expect(decodeDomainAnswer(data)).toEqual({ targetId: 'g1', chosenId: 'g2' });
    expect(decodeDomainAnswer('dq:g1')).toBeUndefined();
    expect(decodeDomainAnswer('vq:1:2')).toBeUndefined();
  });
});
