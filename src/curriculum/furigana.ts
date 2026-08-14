/**
 * 振り仮名の割り当て（V3）。
 *
 * Telegram のメッセージは ruby を出せないので、これまで「見(み)ました」の
 * ように括弧で添えるしかなかった（§4.2）。Mini App は普通の Web ページなので
 * `<ruby>` が使える——V3 の主目的はここ。
 *
 * **難しいのは送り仮名の切り分け。** 形態素解析が返す読みは語全体のもので、
 * 「食べる」なら タベル。そのまま振ると「食べる(たべる)」になり、
 * 送り仮名の「べる」にまで読みが被る。正しくは 食(た)べる。
 * だから漢字の部分にだけ読みを当てる。
 */

const KATAKANA_START = 0x30a1;
const KATAKANA_END = 0x30f6;
const HIRAGANA_OFFSET = 0x30a1 - 0x3041;

/** 片仮名の読みを平仮名に直す。振り仮名は平仮名で出す。 */
export function katakanaToHiragana(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    out +=
      code >= KATAKANA_START && code <= KATAKANA_END
        ? String.fromCodePoint(code - HIRAGANA_OFFSET)
        : char;
  }
  return out;
}

const KANJI = /[一-鿿㐀-䶿々]/;

export function hasKanji(text: string): boolean {
  return KANJI.test(text);
}

export interface RubySegment {
  readonly text: string;
  /** 振る読み。仮名だけの部分は undefined。 */
  readonly ruby: string | undefined;
}

/**
 * 表層形と読みから、漢字の部分にだけ読みを当てる。
 *
 * 「食べる」+「タベル」→ [食:た][べる]
 * 「見」+「ミ」→ [見:み]
 * 「自転車」+「ジテンシャ」→ [自転車:じてんしゃ]
 * 「お茶」+「オチャ」→ [お][茶:ちゃ]
 *
 * 前後の仮名は表層形と読みで一致するはずなので、両端から削って
 * 残った芯（漢字を含む部分）に残りの読みを当てる。読みが合わない場合は
 * 何も振らない——**間違った読みを振るくらいなら振らないほうがよい**。
 * ゼロ初級者はそれが誤りだと気づけない。
 */
export function assignRuby(surface: string, reading: string): RubySegment[] {
  if (!hasKanji(surface)) {
    return [{ text: surface, ruby: undefined }];
  }
  const kana = katakanaToHiragana(reading);
  if (kana === '') {
    return [{ text: surface, ruby: undefined }];
  }

  const surfaceChars = [...surface];
  const kanaChars = [...kana];

  // 先頭の一致する仮名を分ける（「お茶」の「お」）。
  let head = 0;
  while (
    head < surfaceChars.length &&
    head < kanaChars.length &&
    !KANJI.test(surfaceChars[head] ?? '') &&
    surfaceChars[head] === kanaChars[head]
  ) {
    head += 1;
  }

  // 末尾の一致する仮名を分ける（「食べる」の「べる」）。
  let tail = 0;
  while (
    tail < surfaceChars.length - head &&
    tail < kanaChars.length - head &&
    !KANJI.test(surfaceChars[surfaceChars.length - 1 - tail] ?? '') &&
    surfaceChars[surfaceChars.length - 1 - tail] ===
      kanaChars[kanaChars.length - 1 - tail]
  ) {
    tail += 1;
  }

  const coreSurface = surfaceChars.slice(head, surfaceChars.length - tail).join('');
  const coreReading = kanaChars.slice(head, kanaChars.length - tail).join('');

  // 芯に漢字が無い、または読みが空なら、当てどころが定まらない。
  if (coreSurface === '' || coreReading === '' || !hasKanji(coreSurface)) {
    return [{ text: surface, ruby: undefined }];
  }

  const segments: RubySegment[] = [];
  const headText = surfaceChars.slice(0, head).join('');
  if (headText !== '') segments.push({ text: headText, ruby: undefined });
  segments.push({ text: coreSurface, ruby: coreReading });
  const tailText = surfaceChars.slice(surfaceChars.length - tail).join('');
  if (tailText !== '') segments.push({ text: tailText, ruby: undefined });
  return segments;
}

export interface RubyToken {
  readonly surface: string;
  readonly reading: string | undefined;
}

/** 解析済みの一文を ruby 区間の列にする。 */
export function toRubySegments(
  tokens: readonly RubyToken[],
): RubySegment[] {
  const out: RubySegment[] = [];
  for (const token of tokens) {
    if (token.reading === undefined || !hasKanji(token.surface)) {
      out.push({ text: token.surface, ruby: undefined });
      continue;
    }
    out.push(...assignRuby(token.surface, token.reading));
  }
  return out;
}

/** `<ruby>` に組む。属性値は必ず逃がす——本文は利用者の入力を含む。 */
export function renderRubyHtml(segments: readonly RubySegment[]): string {
  return segments
    .map((segment) =>
      segment.ruby === undefined
        ? escapeHtml(segment.text)
        : `<ruby>${escapeHtml(segment.text)}<rt>${escapeHtml(segment.ruby)}</rt></ruby>`,
    )
    .join('');
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
