/**
 * 「毎日 20:30（利用者の地域時間）」を UTC の瞬間に直す。
 *
 * 純粋関数。時計も設定も読まない——リマインダが一日ずれても翌日まで
 * 気づけない種類の不具合なので、境界を机上で固定できる形にしておく。
 *
 * サーバは UTC で動き、利用者は自分の時計で暮らしている。両者を
 * 素朴に足し引きすると、夏時間のある地域で年二回だけ一時間ずれる。
 */

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = FORMATTERS.get(timeZone);
  if (cached !== undefined) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  FORMATTERS.set(timeZone, formatter);
  return formatter;
}

/** ある瞬間が、その地域では何年何月何日の何時何分に見えるか。 */
export function partsInZone(instant: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const value = (type: string): number => {
    const found = parts.find((part) => part.type === type)?.value ?? '0';
    // 24 時制でも深夜が "24" になる実装があるため、正規化しておく。
    const parsed = Number.parseInt(found, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  const hour = value('hour');
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: hour === 24 ? 0 : hour,
    minute: value('minute'),
  };
}

/**
 * その地域の壁時計時刻を UTC の瞬間に直す。
 *
 * 一度 UTC とみなして置いてみて、その瞬間が現地で何時に見えるかを測り、
 * ずれた分だけ戻す。夏時間の切り替わりでは一度では収束しないので、
 * もう一度だけ測り直す。
 */
export function zonedWallClockToInstant(
  wall: ZonedParts,
  timeZone: string,
): Date {
  const asIfUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
  );

  let instant = asIfUtc;
  for (let pass = 0; pass < 2; pass += 1) {
    const shown = partsInZone(new Date(instant), timeZone);
    const shownAsUtc = Date.UTC(
      shown.year,
      shown.month - 1,
      shown.day,
      shown.hour,
      shown.minute,
    );
    const drift = shownAsUtc - asIfUtc;
    if (drift === 0) break;
    instant -= drift;
  }
  return new Date(instant);
}

export interface DailyTimeOptions {
  /** "HH:MM"（24 時制、利用者の地域時間）。 */
  readonly localTime: string;
  readonly timeZone: string;
}

export function parseLocalTime(
  localTime: string,
): { hour: number; minute: number } | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(localTime.trim());
  if (match === null) return undefined;
  const hour = Number.parseInt(match[1] ?? '', 10);
  const minute = Number.parseInt(match[2] ?? '', 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;
  return { hour, minute };
}

/**
 * `now` より後で最初に来る、その地域時間の指定時刻。
 *
 * ちょうど同時刻のときは翌日にする。発火直後に次回を計算するので、
 * 「以上」にすると同じ瞬間を拾って一日に二度鳴る。
 */
export function nextDailyOccurrence(
  now: Date,
  options: DailyTimeOptions,
): Date | undefined {
  const parsed = parseLocalTime(options.localTime);
  if (parsed === undefined) return undefined;

  const today = partsInZone(now, options.timeZone);
  const candidate = zonedWallClockToInstant(
    { ...today, hour: parsed.hour, minute: parsed.minute },
    options.timeZone,
  );
  if (candidate.getTime() > now.getTime()) return candidate;

  // 翌日。月末・年末は Date.UTC が繰り上げてくれる。
  const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
  const parts = {
    year: tomorrow.getUTCFullYear(),
    month: tomorrow.getUTCMonth() + 1,
    day: tomorrow.getUTCDate(),
    hour: parsed.hour,
    minute: parsed.minute,
  };
  return zonedWallClockToInstant(parts, options.timeZone);
}

/** その地域での暦日（"2026-08-14"）。同じ日に二度出さないための鍵。 */
export function localDateKey(instant: Date, timeZone: string): string {
  const parts = partsInZone(instant, timeZone);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(parts.year)}-${pad(parts.month)}-${pad(parts.day)}`;
}

export interface WeeklyTimeOptions extends DailyTimeOptions {
  /** 0 = 日曜。利用者の地域時間での曜日。 */
  readonly weekday: number;
}

/**
 * `now` より後で最初に来る、その地域時間の「曜日 + 時刻」。
 *
 * 日次と同じく、ちょうど同時刻なら次の週に送る——発火直後に次回を
 * 計算するので、「以上」にすると同じ瞬間を拾って二度鳴る。
 *
 * 曜日は**その地域での**曜日で数える。UTC の曜日で決めると、
 * 時差の大きい地域では狙った曜日から一日ずれる。
 */
export function nextWeeklyOccurrence(
  now: Date,
  options: WeeklyTimeOptions,
): Date | undefined {
  const parsed = parseLocalTime(options.localTime);
  if (parsed === undefined) return undefined;
  if (!Number.isInteger(options.weekday) || options.weekday < 0 || options.weekday > 6) {
    return undefined;
  }

  // 今日から 7 日先までを順に見る。夏時間の切り替えを跨いでも、
  // 一日ずつ組み立てれば壁時計の時刻は保たれる。
  const today = partsInZone(now, options.timeZone);
  for (let ahead = 0; ahead <= 7; ahead += 1) {
    const day = new Date(
      Date.UTC(today.year, today.month - 1, today.day + ahead),
    );
    const candidate = zonedWallClockToInstant(
      {
        year: day.getUTCFullYear(),
        month: day.getUTCMonth() + 1,
        day: day.getUTCDate(),
        hour: parsed.hour,
        minute: parsed.minute,
      },
      options.timeZone,
    );
    if (candidate.getTime() <= now.getTime()) continue;
    if (weekdayInZone(candidate, options.timeZone) !== options.weekday) continue;
    return candidate;
  }
  return undefined;
}

const WEEKDAY_FORMATTERS = new Map<string, Intl.DateTimeFormat>();
const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** その瞬間が、その地域では何曜日か（0 = 日曜）。 */
export function weekdayInZone(instant: Date, timeZone: string): number {
  let formatter = WEEKDAY_FORMATTERS.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' });
    WEEKDAY_FORMATTERS.set(timeZone, formatter);
  }
  const name = formatter.format(instant);
  return WEEKDAY_INDEX[name] ?? 0;
}
