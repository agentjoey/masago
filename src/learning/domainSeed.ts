import { and, eq, inArray } from 'drizzle-orm';
import {
  DOMAIN_VOCAB,
  domainKey,
  type DomainEntry,
} from '../curriculum/domainVocab.js';
import type { Executor } from '../db/repositories/executor.js';
import { knowledgeItems } from '../db/schema/learning.js';

/**
 * 分野別語彙を knowledge_items に流し込む（DOMAIN 型）。
 *
 * 仮名・語彙・助詞と同じく冪等。既にある行は触らない——mastery はそこから育つ。
 *
 * **VOCABULARY ではなく DOMAIN 型にしてある。** 型で引く問い合わせ
 * （`countDue(…, 'VOCABULARY')` など）に混ざると、/today や /vocab の件数が
 * 主線の分だけを指さなくなる。主線の進度は主線だけで数える。
 */

const DOMAIN_TYPE = 'DOMAIN' as const;

export interface DomainSeedResult {
  inserted: number;
  total: number;
  repaired: number;
}

function metadataOf(entry: DomainEntry): Record<string, unknown> {
  return {
    domain: entry.domain,
    expression: entry.expression,
    reading: entry.reading,
    meaning: entry.meaning,
    source: 'JMdict',
    license: 'CC BY-SA 4.0',
  };
}

export async function ensureDomainVocabSeeded(
  tx: Executor,
): Promise<DomainSeedResult> {
  const existing = await tx
    .select({ key: knowledgeItems.key, metadata: knowledgeItems.metadata })
    .from(knowledgeItems)
    .where(eq(knowledgeItems.type, DOMAIN_TYPE));

  // 冪等な seed は「無い行を足す」だけなので、語義を直しても既存行は
  // 古いまま残る。語彙側で実際に起きた（level が入らなかった）ので、
  // 同じ手当てを最初から入れておく。
  const stale = DOMAIN_VOCAB.filter((entry) => {
    const row = existing.find((item) => item.key === domainKey(entry.id));
    if (row === undefined) return false;
    const current = (row.metadata ?? {}) as Record<string, unknown>;
    return (
      current['meaning'] !== entry.meaning || current['reading'] !== entry.reading
    );
  });
  for (const entry of stale) {
    await tx
      .update(knowledgeItems)
      .set({ metadata: metadataOf(entry), updatedAt: new Date() })
      .where(
        and(
          eq(knowledgeItems.type, DOMAIN_TYPE),
          eq(knowledgeItems.key, domainKey(entry.id)),
        ),
      );
  }

  const have = new Set(existing.map((row) => row.key));
  const missing = DOMAIN_VOCAB.filter(
    (entry) => !have.has(domainKey(entry.id)),
  );
  if (missing.length === 0) {
    return { inserted: 0, total: DOMAIN_VOCAB.length, repaired: stale.length };
  }

  // 359 件を一度に入れると文が長くなりすぎるので分割する。
  const CHUNK = 200;
  for (let start = 0; start < missing.length; start += CHUNK) {
    const chunk = missing.slice(start, start + CHUNK);
    await tx
      .insert(knowledgeItems)
      .values(
        chunk.map((entry) => ({
          type: DOMAIN_TYPE,
          key: domainKey(entry.id),
          canonicalForm: entry.expression,
          metadata: metadataOf(entry),
        })),
      )
      .onConflictDoNothing({
        target: [knowledgeItems.type, knowledgeItems.key],
      });
  }

  return {
    inserted: missing.length,
    total: DOMAIN_VOCAB.length,
    repaired: stale.length,
  };
}

/** 分野語彙 id → knowledge_items.id。 */
export async function resolveDomainItemIds(
  tx: Executor,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: knowledgeItems.id, key: knowledgeItems.key })
    .from(knowledgeItems)
    .where(
      and(
        eq(knowledgeItems.type, DOMAIN_TYPE),
        inArray(knowledgeItems.key, ids.map(domainKey)),
      ),
    );

  const byId = new Map<string, string>();
  for (const row of rows) {
    byId.set(row.key.slice('domain_'.length), row.id);
  }
  return byId;
}
