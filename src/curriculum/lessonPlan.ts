/**
 * 今日どの仮名をやるかを決める（V2 §2.4 の内容プール、S0 版）。
 *
 * 純粋関数。DB も時計も見ない——「新出を出すか抑えるか」は学習が続くか
 * 続かないかを分ける判断で、条件を並べて机上で確かめられる形にしておきたい。
 */
import { KANA, KANA_BY_ID, type Kana } from './kana.js';

export interface LessonPlanInput {
  /** 既に導入済みの仮名 id（順不同）。 */
  readonly introducedIds: readonly string[];
  /** いま復習期日が来ている仮名 id。期日の早い順で渡すこと。 */
  readonly dueIds: readonly string[];
  readonly newPerDay: number;
  readonly maxReviews: number;
  /**
   * 未復習がこの数を超えたら新出を止める。
   *
   * 溜まった復習を放って新出を足し続けると、雪だるまになって必ず破綻する。
   * ゼロから毎日続けることが最優先なので、遅れている日は追いつくことを選ぶ。
   */
  readonly backlogThreshold: number;
}

export interface LessonPlan {
  readonly newKana: readonly Kana[];
  readonly reviewKana: readonly Kana[];
  /** 新出を見送ったか。見送った事実は学習者に伝える価値がある。 */
  readonly newHeldBackForBacklog: boolean;
}

/**
 * 行の並び。KANA の並び順がそのまま指導順（あ→か→…→ん、濁音、半濁音、拗音）。
 */
function teachingRows(): { row: string; group: string; kana: Kana[] }[] {
  const rows: { row: string; group: string; kana: Kana[] }[] = [];
  for (const kana of KANA) {
    const last = rows[rows.length - 1];
    if (last !== undefined && last.row === kana.row && last.group === kana.group) {
      last.kana.push(kana);
    } else {
      rows.push({ row: kana.row, group: kana.group, kana: [kana] });
    }
  }
  return rows;
}

const ROWS = teachingRows();

/**
 * 次に導入する仮名を行単位で選ぶ。
 *
 * 平坦な並びから機械的に N 個取ると、あ行が「あいう」で切れて翌日
 * 「えお」から始まる。あいうえお は一組で覚えるものなので、行の途中で
 * 切らずに、残りが上限を超えるときだけその行の中で分ける。
 */
function nextNewKana(
  introduced: ReadonlySet<string>,
  limit: number,
): Kana[] {
  if (limit <= 0) return [];
  const picked: Kana[] = [];
  for (const row of ROWS) {
    const remaining = row.kana.filter((kana) => !introduced.has(kana.id));
    if (remaining.length === 0) continue;
    for (const kana of remaining) {
      if (picked.length >= limit) return picked;
      picked.push(kana);
    }
    // 一日に複数の行へ跨がない。行が変わると音の並びが変わり、
    // 一度に覚える塊としては大きすぎる。
    if (picked.length > 0) return picked;
  }
  return picked;
}

export function planLesson(input: LessonPlanInput): LessonPlan {
  const introduced = new Set(input.introducedIds);

  const reviewKana = input.dueIds
    .map((id) => KANA_BY_ID.get(id))
    .filter((kana): kana is Kana => kana !== undefined)
    .slice(0, Math.max(0, input.maxReviews));

  // 判断は「表示する件数」ではなく「溜まっている総量」で行う。
  // 上限で切った後の数を見ると、いくら溜まっても閾値に届かない。
  const backlog = input.dueIds.length;
  const newHeldBackForBacklog = backlog > input.backlogThreshold;

  const newKana = newHeldBackForBacklog
    ? []
    : nextNewKana(introduced, input.newPerDay);

  return { newKana, reviewKana, newHeldBackForBacklog };
}

/** 導入済みの仮名。誤答の候補をここから取る（未習の字を混ぜないため）。 */
export function taughtPool(introducedIds: readonly string[]): Kana[] {
  const introduced = new Set(introducedIds);
  return KANA.filter((kana) => introduced.has(kana.id));
}

/** S0 全体の進み具合。 */
export function kanaProgress(introducedIds: readonly string[]): {
  introduced: number;
  total: number;
} {
  const introduced = new Set(introducedIds);
  return {
    introduced: KANA.filter((kana) => introduced.has(kana.id)).length,
    total: KANA.length,
  };
}
