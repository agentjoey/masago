import { and, eq, inArray } from 'drizzle-orm';
import { VOCAB, vocabKey } from '../curriculum/vocab.js';
import type { Executor } from '../db/repositories/executor.js';
import { knowledgeItems } from '../db/schema/learning.js';

/**
 * N5・N4 語彙を knowledge_items に流し込む（V2 §8 / §2.1 の S1・S2）。
 *
 * 仮名と同じく冪等。既にある行は触らない——mastery はそこから育つ。
 */

const VOCAB_TYPE = 'VOCABULARY' as const;

export interface VocabSeedResult {
  inserted: number;
  total: number;
  /** metadata が古くて直した行数。 */
  repaired: number;
}

function metadataOf(entry: (typeof VOCAB)[number]): Record<string, unknown> {
  return {
    expression: entry.expression,
    reading: entry.reading,
    meaning: entry.meaning,
    level: entry.level,
    ...(entry.genkiLesson === undefined
      ? {}
      : { genkiLesson: entry.genkiLesson }),
    ...(entry.isAffix === true ? { isAffix: true } : {}),
  };
}

export async function ensureVocabSeeded(
  tx: Executor,
): Promise<VocabSeedResult> {
  const existing = await tx
    .select({
      key: knowledgeItems.key,
      metadata: knowledgeItems.metadata,
    })
    .from(knowledgeItems)
    .where(eq(knowledgeItems.type, VOCAB_TYPE));

  // 既存行の metadata が古い場合は直す。
  //
  // 冪等な seed は「無い行を足す」だけなので、後から項目を増やしても
  // 既にある行は古いまま残る（実測：N4 を足したとき、先に入っていた
  // N5 の 717 行に level が付いていなかった）。metadata は表示や
  // MCP から読む前提なので、黙って古いままにしない。
  const stale = VOCAB.filter((entry) => {
    const row = existing.find((item) => item.key === vocabKey(entry.id));
    if (row === undefined) return false;
    const current = (row.metadata ?? {}) as Record<string, unknown>;
    return current['level'] !== entry.level;
  });
  for (const entry of stale) {
    await tx
      .update(knowledgeItems)
      .set({ metadata: metadataOf(entry), updatedAt: new Date() })
      .where(eq(knowledgeItems.key, vocabKey(entry.id)));
  }

  const have = new Set(existing.map((row) => row.key));
  const missing = VOCAB.filter((entry) => !have.has(vocabKey(entry.id)));

  if (missing.length === 0) {
    return { inserted: 0, total: VOCAB.length, repaired: stale.length };
  }

  // 700 件強を一度に入れると文が長くなりすぎるので分割する。
  const CHUNK = 200;
  for (let start = 0; start < missing.length; start += CHUNK) {
    const chunk = missing.slice(start, start + CHUNK);
    await tx
      .insert(knowledgeItems)
      .values(
        chunk.map((entry) => ({
          type: VOCAB_TYPE,
          key: vocabKey(entry.id),
          canonicalForm: entry.expression,
          metadata: metadataOf(entry),
        })),
      )
      .onConflictDoNothing({
        target: [knowledgeItems.type, knowledgeItems.key],
      });
  }

  return { inserted: missing.length, total: VOCAB.length, repaired: stale.length };
}

/** 語彙 id → knowledge_items.id。 */
export async function resolveVocabItemIds(
  tx: Executor,
  vocabIds: readonly string[],
): Promise<Map<string, string>> {
  if (vocabIds.length === 0) return new Map();
  const keys = vocabIds.map(vocabKey);
  const rows = await tx
    .select({ id: knowledgeItems.id, key: knowledgeItems.key })
    .from(knowledgeItems)
    .where(
      and(
        eq(knowledgeItems.type, VOCAB_TYPE),
        inArray(knowledgeItems.key, keys),
      ),
    );

  const byVocabId = new Map<string, string>();
  for (const row of rows) {
    byVocabId.set(row.key.slice('vocab_'.length), row.id);
  }
  return byVocabId;
}
