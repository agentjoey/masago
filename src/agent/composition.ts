import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { AnthropicClientLike } from './llm/types.js';

/**
 * 作文の判定（docs/scenario-learning.md §5 書 第 3–4 档）。
 *
 * 同じ意味に正しい言い方は何通りもあるので、唯一の答えと突き合わせる
 * やり方では通らない。ここだけは模型の判断が要る。
 *
 * **模型は判定だけで、作らない。** 手本の文は人が書いたもの（Tatoeba）を
 * 必ず渡す。模型に「正しい日本語を書いて」と頼めば §8 に触れるが、
 * 「この二つは同じ意味か」を訊くのは判断であって事実の捏造ではない。
 *
 * ## 呼ぶ前に規則層を通す
 *
 * 助詞の誤用や活用の誤りは `nlp/grammar.ts` が確定的に判定できる。
 * 先に落とせば模型を呼ぶ回数が減り、しかも**同じ入力に同じ答え**が返る
 * （§1.5）。模型に回すのは規則で決められなかった分だけ。
 *
 * ## 誤判定をどちらに倒すか
 *
 * どちらにも倒さない。**判定にかかわらず必ず手本の文を見せる**ことで、
 * 取り違えの害を抑える：
 *
 * - 誤って ✕ にしても、学習者は正しい別の言い方を目にする
 * - 誤って ○ にしても、手本が並ぶので canonical な形は見える
 *
 * 判定そのものを完璧にはできないので、**外した時に何が残るか**で設計する。
 */

export const COMPOSITION_VERDICT = z.object({
  /** 学習者の文が中国語の意味を表しているか。 */
  ok: z.boolean(),
  /**
   * 直すべき点（中国語、一行）。ok が true でも自然さの助言を入れてよい。
   * 無ければ空文字。
   */
  note: z.string(),
});

export type CompositionVerdict = z.infer<typeof COMPOSITION_VERDICT>;

const TOOL_NAME = 'submit_verdict';

const TOOL: Anthropic.Tool = {
  name: TOOL_NAME,
  description:
    '学生の作文が指定の意味を表しているかの判定を提出します。ok と note を必ず含めてください。',
  input_schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean', description: '意味が通っていれば true' },
      note: { type: 'string', description: '中文の短い助言。無ければ空文字' },
    },
    required: ['ok', 'note'],
  } as Anthropic.Tool.InputSchema,
};

const SYSTEM = [
  '你在批改零基础日语学习者写的一句话。',
  '',
  '判断标准：',
  '1. **只看意思是否表达出来，以及语法是否成立**。不要求和参考句一模一样',
  '   ——同一个意思有很多种正确说法，把正确的说法判成错的，比放过一个',
  '   小毛病更糟：学生会把自己写对的地方改错。',
  '2. 助词、活用有明确错误 → ok=false，note 里用中文指出错在哪。',
  '3. 只是不够自然、但语法正确且意思对 → ok=true，note 里写更自然的说法。',
  '4. 拿不准就判 ok=true。',
  '5. note 用中文，一行，最多 40 字。没有要说的就留空。',
  '6. **不要新造日语例句**。要举例只能引用给你的参考句。',
].join('\n');

export interface JudgeCompositionInput {
  /** 出題に使った中国語。 */
  readonly meaning: string;
  /** 人が書いた手本（Tatoeba）。模型の作文ではない。 */
  readonly reference: string;
  /** 学習者が書いた日本語。 */
  readonly written: string;
  /** 規則層が既に見つけた誤り。同じことを二度言わせない。 */
  readonly ruleFindings?: readonly string[];
}

export interface JudgeCompositionOptions {
  readonly client: AnthropicClientLike;
  readonly model: string;
  readonly maxTokens?: number;
  /**
   * 一度きりの再試行を許すか（既定 true）。
   *
   * 実測（240 件の評価）で、5 並列に投げると 3 分の 1 が返らなかった。
   * 同じ入力を単発で投げ直すと 4 秒で返ったので、原因は判定の失敗ではなく
   * 送信側の詰まり。**一回だけ**やり直す——それ以上粘ると、学習者を
   * 待たせるほうが害になる。
   */
  readonly retry?: boolean;
  /**
   * 落ちた理由の通知。返り値は undefined のままなので、呼び出し側は
   * 「判定できなかった」として扱えばよい。運用で原因を見るための口。
   */
  readonly onError?: (error: unknown, willRetry: boolean) => void;
}

/**
 * 判定を一件。失敗したら undefined を返す。
 *
 * 呼び出し側は undefined を「判定できなかった」として扱い、手本を見せて
 * 先へ進める——模型が落ちたからといって練習を止めない。
 */
export async function judgeComposition(
  input: JudgeCompositionInput,
  options: JudgeCompositionOptions,
): Promise<CompositionVerdict | undefined> {
  const lines = [
    `要表达的意思（中文）：${input.meaning}`,
    `参考句（母语者写的，仅供参考）：${input.reference}`,
    `学生写的：${input.written}`,
  ];
  if (input.ruleFindings !== undefined && input.ruleFindings.length > 0) {
    lines.push(
      `程序已经查出：${input.ruleFindings.join('；')}（不用重复，可补充别的）`,
    );
  }

  const ask = async (): Promise<Anthropic.Message> =>
    options.client.messages.create({
      model: options.model,
      max_tokens: options.maxTokens ?? 300,
      system: [{ type: 'text', text: SYSTEM }],
      messages: [{ role: 'user', content: lines.join('\n') }],
      tools: [TOOL],
      // 強制呼び出し。MiniMax は output_config.format を黙って無視するので、
      // スキーマ強制はツールの input_schema に委ねる（tutor.ts と同じ）。
      tool_choice: { type: 'tool', name: TOOL_NAME },
    });

  const mayRetry = options.retry ?? true;
  let response: Anthropic.Message;
  try {
    response = await ask();
  } catch (error) {
    options.onError?.(error, mayRetry);
    if (!mayRetry) return undefined;
    try {
      response = await ask();
    } catch (again) {
      options.onError?.(again, false);
      return undefined;
    }
  }

  // text ブロックと tool_use が同時に返ることがある（実測）。
  // content[0] を仮定せず探す。
  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock =>
      block.type === 'tool_use' && block.name === TOOL_NAME,
  );
  if (toolUse === undefined) return undefined;

  const parsed = COMPOSITION_VERDICT.safeParse(toolUse.input);
  if (!parsed.success) return undefined;
  return { ok: parsed.data.ok, note: cleanNote(parsed.data.note) };
}

/**
 * 助言を学習者に見せられる形にする。
 *
 * 実測（2026-08-14、MiniMax-M3）で、note に `</note>` という閉じタグだけが
 * 入って返ってきたことがある。素のテキストとして送ると、そのまま画面に
 * 出る。方針に「タグを書くな」と足しても防げない類なので、出口で落とす
 * ——`explain.ts` の Markdown 除去と同じ考え方。
 *
 * **判定そのものは直せない。** 同じ実測で「把「赤い」改成「赤い」」という
 * 意味の通らない助言も出た（判定は正しかった）。だから採点結果に
 * かかわらず手本の文を必ず並べる（`compositionSession.ts`）——助言が
 * 崩れても、学習者の手元には正しい日本語が残る。
 */
export function cleanNote(note: string): string {
  const cleaned = note
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  // 記号だけになったものは助言ではない。
  return /[\p{L}\p{N}]/u.test(cleaned) ? cleaned : '';
}
