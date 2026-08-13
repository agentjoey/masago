import { and, eq, inArray } from 'drizzle-orm';
import { KANA, kanaKey } from '../curriculum/kana.js';
import type { Executor } from '../db/repositories/executor.js';
import { knowledgeItems } from '../db/schema/learning.js';

/**
 * 五十音を knowledge_items に流し込む（V2 §2.1）。
 *
 * 冪等。`(type, key)` の一意制約に委ねて、既にある行は触らない——
 * mastery はここから育つので、再実行で上書きすると学習履歴が消える。
 *
 * 起動時に一度だけ呼ぶ。仮名は 104 個で増えないので、揃っていれば
 * 一件の count で早期に戻り、Neon の compute を無駄に起こさない（§9.1）。
 */

const KANA_TYPE = 'KANA' as const;

export interface KanaSeedResult {
  inserted: number;
  total: number;
}

export async function ensureKanaSeeded(
  tx: Executor,
): Promise<KanaSeedResult> {
  const keys = KANA.map((kana) => kanaKey(kana.id));

  const existing = await tx
    .select({ key: knowledgeItems.key })
    .from(knowledgeItems)
    .where(eq(knowledgeItems.type, KANA_TYPE));

  const have = new Set(existing.map((row) => row.key));
  const missing = KANA.filter((kana) => !have.has(kanaKey(kana.id)));

  if (missing.length === 0) {
    return { inserted: 0, total: keys.length };
  }

  await tx
    .insert(knowledgeItems)
    .values(
      missing.map((kana) => ({
        type: KANA_TYPE,
        key: kanaKey(kana.id),
        // 表示に使うのは平仮名。片仮名や読みは metadata に持つ。
        canonicalForm: kana.hiragana,
        metadata: {
          hiragana: kana.hiragana,
          katakana: kana.katakana,
          romaji: kana.romaji,
          row: kana.row,
          group: kana.group,
        },
      })),
    )
    .onConflictDoNothing({
      target: [knowledgeItems.type, knowledgeItems.key],
    });

  return { inserted: missing.length, total: keys.length };
}

/** 仮名 id → knowledge_items.id。出題と復習キューを繋ぐのに要る。 */
export async function resolveKanaItemIds(
  tx: Executor,
  kanaIds: readonly string[],
): Promise<Map<string, string>> {
  if (kanaIds.length === 0) {
    return new Map();
  }
  const keys = kanaIds.map(kanaKey);
  const rows = await tx
    .select({ id: knowledgeItems.id, key: knowledgeItems.key })
    .from(knowledgeItems)
    .where(
      and(
        eq(knowledgeItems.type, KANA_TYPE),
        inArray(knowledgeItems.key, keys),
      ),
    );

  const byKanaId = new Map<string, string>();
  for (const row of rows) {
    byKanaId.set(row.key.slice('kana_'.length), row.id);
  }
  return byKanaId;
}
