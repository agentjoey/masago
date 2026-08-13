import { and, eq, inArray } from 'drizzle-orm';
import { VOCAB_N5, vocabKey } from '../curriculum/vocabN5.js';
import type { Executor } from '../db/repositories/executor.js';
import { knowledgeItems } from '../db/schema/learning.js';

/**
 * N5 語彙を knowledge_items に流し込む（V2 §8 / §2.1 の S1）。
 *
 * 仮名と同じく冪等。既にある行は触らない——mastery はそこから育つ。
 */

const VOCAB_TYPE = 'VOCABULARY' as const;

export interface VocabSeedResult {
  inserted: number;
  total: number;
}

export async function ensureVocabSeeded(
  tx: Executor,
): Promise<VocabSeedResult> {
  const existing = await tx
    .select({ key: knowledgeItems.key })
    .from(knowledgeItems)
    .where(eq(knowledgeItems.type, VOCAB_TYPE));

  const have = new Set(existing.map((row) => row.key));
  const missing = VOCAB_N5.filter((entry) => !have.has(vocabKey(entry.id)));

  if (missing.length === 0) {
    return { inserted: 0, total: VOCAB_N5.length };
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
          metadata: {
            expression: entry.expression,
            reading: entry.reading,
            meaning: entry.meaning,
            ...(entry.genkiLesson === undefined
              ? {}
              : { genkiLesson: entry.genkiLesson }),
            ...(entry.isAffix === true ? { isAffix: true } : {}),
          },
        })),
      )
      .onConflictDoNothing({
        target: [knowledgeItems.type, knowledgeItems.key],
      });
  }

  return { inserted: missing.length, total: VOCAB_N5.length };
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
