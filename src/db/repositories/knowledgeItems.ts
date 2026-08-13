import { and, eq, inArray } from 'drizzle-orm';
import { knowledgeItems } from '../schema/learning.js';
import type { Executor } from './executor.js';

/**
 * Tutor が返す knowledgeKey を安定させるための最小ストア。
 *
 * mastery は §3.3 のとおり learning events から知識項目ごとに集計される。
 * 同じ誤り類型が毎回違うキーで返ると集計が成立しないため、既知キーを
 * モデルに提示して再利用させ、新しく現れたキーだけを登録する。
 */
export interface KnowledgeKeyStore {
  listKeys(): Promise<readonly string[]>;
  registerKeys(keys: readonly string[]): Promise<void>;
}

const ERROR_PATTERN = 'ERROR_PATTERN' as const;

export async function listErrorPatternKeys(
  tx: Executor,
): Promise<readonly string[]> {
  const rows = await tx
    .select({ key: knowledgeItems.key })
    .from(knowledgeItems)
    .where(eq(knowledgeItems.type, ERROR_PATTERN));
  return rows.map((row) => row.key);
}

/**
 * `(type, key)` の一意制約に委ねて冪等にする。先に SELECT してから INSERT
 * すると競合するため、onConflictDoNothing で書き切る。
 */
export async function registerErrorPatternKeys(
  tx: Executor,
  keys: readonly string[],
): Promise<void> {
  const unique = [...new Set(keys)].filter((key) => key.length > 0);
  if (unique.length === 0) {
    return;
  }
  await tx
    .insert(knowledgeItems)
    .values(unique.map((key) => ({ type: ERROR_PATTERN, key })))
    .onConflictDoNothing({
      target: [knowledgeItems.type, knowledgeItems.key],
    });
}

export async function findErrorPatternKeys(
  tx: Executor,
  keys: readonly string[],
): Promise<readonly string[]> {
  if (keys.length === 0) {
    return [];
  }
  const rows = await tx
    .select({ key: knowledgeItems.key })
    .from(knowledgeItems)
    .where(
      and(
        eq(knowledgeItems.type, ERROR_PATTERN),
        inArray(knowledgeItems.key, [...keys]),
      ),
    );
  return rows.map((row) => row.key);
}

export function createKnowledgeKeyStore(tx: Executor): KnowledgeKeyStore {
  return {
    listKeys: () => listErrorPatternKeys(tx),
    registerKeys: (keys) => registerErrorPatternKeys(tx, keys),
  };
}
