/**
 * 語彙の入り口。N5 → N4 の順に並べた一本の列を配る（V2 §2.1 の S1 → S2）。
 *
 * 生成物（vocabN5.ts / vocabN4.ts）を直接読まないこと。等級をまたぐ
 * 重複の処理と教える順序をここに集めてある。
 */
import { VOCAB_N4 } from './vocabN4.js';
import { VOCAB_N5 } from './vocabN5.js';
import type { JlptLevel, VocabEntry } from './vocabTypes.js';

export type { JlptLevel, VocabEntry };

/**
 * 等級をまたいで同じ語が出ることがある（実測では「そう」1 件）。
 *
 * 先に教えるほう＝N5 を残す。両方入れると、同じ語に学習履歴が二本でき、
 * 掌握度がどちらにも溜まらない。
 */
function mergeByLevel(): VocabEntry[] {
  const seen = new Set<string>();
  const merged: VocabEntry[] = [];
  for (const entry of [...VOCAB_N5, ...VOCAB_N4]) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push(entry);
  }
  return merged;
}

/** 教える順に並んだ全語彙。N5 を終えてから N4。 */
export const VOCAB: readonly VocabEntry[] = mergeByLevel();

export const VOCAB_BY_ID: ReadonlyMap<string, VocabEntry> = new Map(
  VOCAB.map((entry) => [entry.id, entry]),
);

export function vocabOfLevel(level: JlptLevel): VocabEntry[] {
  return VOCAB.filter((entry) => entry.level === level);
}

/** knowledge_items.key に入る形。型が VOCABULARY なので接頭辞で衝突しない。 */
export function vocabKey(id: string): string {
  return `vocab_${id}`;
}

export function vocabOfKey(key: string): VocabEntry | undefined {
  return key.startsWith('vocab_')
    ? VOCAB_BY_ID.get(key.slice('vocab_'.length))
    : undefined;
}
