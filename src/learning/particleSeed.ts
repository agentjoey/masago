import { and, eq, inArray } from 'drizzle-orm';
import { PARTICLES, particleKey } from '../curriculum/particles.js';
import type { Executor } from '../db/repositories/executor.js';
import { knowledgeItems } from '../db/schema/learning.js';

/**
 * 助詞を knowledge_items に流し込む（GRAMMAR 型）。
 *
 * 仮名・語彙と同じく冪等。既にある行は触らない——mastery はそこから育つ。
 *
 * 行数は十数件で、実測した一行あたり 216 B から見て索引込みでも 10 KB 前後。
 * 増える一方の `learning_events`（毎回一行）と比べれば無視してよい大きさで、
 * 粒度をどう切るかは容量ではなく教え方で決めた（一助詞＝一項目）。
 */

const GRAMMAR_TYPE = 'GRAMMAR' as const;

export interface ParticleSeedResult {
  inserted: number;
  total: number;
  /** metadata が古くて直した行数。 */
  repaired: number;
}

function metadataOf(entry: (typeof PARTICLES)[number]): Record<string, unknown> {
  return {
    surface: entry.surface,
    reading: entry.reading,
    label: entry.label,
    // 出題材料がどれだけあるか。少ない項目は同じ文が繰り返される。
    blankable: entry.blankable,
  };
}

export async function ensureParticlesSeeded(
  tx: Executor,
): Promise<ParticleSeedResult> {
  const existing = await tx
    .select({ key: knowledgeItems.key, metadata: knowledgeItems.metadata })
    .from(knowledgeItems)
    .where(eq(knowledgeItems.type, GRAMMAR_TYPE));

  // 冪等な seed は「無い行を足す」だけなので、後からラベルを直しても
  // 既存行は古いまま残る。語彙側で実際に起きた（level が入らなかった）ので
  // 同じ手当てを最初から入れておく。
  const stale = PARTICLES.filter((entry) => {
    const row = existing.find((item) => item.key === particleKey(entry.id));
    if (row === undefined) return false;
    const current = (row.metadata ?? {}) as Record<string, unknown>;
    return current['label'] !== entry.label || current['reading'] !== entry.reading;
  });
  for (const entry of stale) {
    await tx
      .update(knowledgeItems)
      .set({ metadata: metadataOf(entry), updatedAt: new Date() })
      .where(
        and(
          eq(knowledgeItems.type, GRAMMAR_TYPE),
          eq(knowledgeItems.key, particleKey(entry.id)),
        ),
      );
  }

  const have = new Set(existing.map((row) => row.key));
  const missing = PARTICLES.filter((entry) => !have.has(particleKey(entry.id)));
  if (missing.length === 0) {
    return { inserted: 0, total: PARTICLES.length, repaired: stale.length };
  }

  await tx
    .insert(knowledgeItems)
    .values(
      missing.map((entry) => ({
        type: GRAMMAR_TYPE,
        key: particleKey(entry.id),
        canonicalForm: entry.surface,
        metadata: metadataOf(entry),
      })),
    )
    .onConflictDoNothing({
      target: [knowledgeItems.type, knowledgeItems.key],
    });

  return {
    inserted: missing.length,
    total: PARTICLES.length,
    repaired: stale.length,
  };
}

/** 助詞 id → knowledge_items.id。 */
export async function resolveParticleItemIds(
  tx: Executor,
  particleIds: readonly string[],
): Promise<Map<string, string>> {
  if (particleIds.length === 0) return new Map();
  const rows = await tx
    .select({ id: knowledgeItems.id, key: knowledgeItems.key })
    .from(knowledgeItems)
    .where(
      and(
        eq(knowledgeItems.type, GRAMMAR_TYPE),
        inArray(knowledgeItems.key, particleIds.map(particleKey)),
      ),
    );

  const byParticleId = new Map<string, string>();
  for (const row of rows) {
    byParticleId.set(row.key.slice('particle_'.length), row.id);
  }
  return byParticleId;
}
