import type { AnthropicClientLike } from './llm/types.js';

/**
 * 直前に答えた項目の解説（V2 §4.4 の `/explain`）。
 *
 * チューター本体は日本語で会話するのが仕事で、出力も構造化されている。
 * 解説はそれとは別物——**中国語の自由文**でよく、検証すべき構造も無い。
 * 同じ経路に押し込むと、会話用の方針と schema に引きずられて、
 * 説明が日本語で返ってきたりする。
 *
 * ここが LLM を使ってよい理由：説明は「教え方」であって事実データでは
 * ない（§8 は語義・等級のような**事実**を模型に作らせるなと言っている）。
 * 語そのものは公開データから来ていて、模型は言い換えるだけ。
 */

export interface ExplainTarget {
  /** 「あ」「今」など、説明してほしい対象。 */
  readonly subject: string;
  /** 読み。仮名なら不要。 */
  readonly reading?: string;
  /** 出典どおりの語義。模型に意味を作らせないため必ず渡す。 */
  readonly meaning?: string;
  /** 直前に間違えた内容があれば。 */
  readonly mistake?: string;
}

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly requestId?: string;
}

export interface ExplainOptions {
  readonly client: AnthropicClientLike;
  readonly model: string;
  readonly maxTokens?: number;
  /**
   * 消費した token の通知。呼び出し側が usage_records に落とす。
   * ここで捨てると /explain の費用が /cost から消える（実測で消えていた）。
   */
  readonly onUsage?: (usage: LlmUsage) => void;
}

const SYSTEM = [
  '你是日语教师，学生是零基础的中文母语者。',
  '',
  '规则：',
  '1. 用中文解释。学生还读不懂日语说明。',
  '2. 只解释给定的词条。**不要新造词义**——释义已随输入给出，以它为准。',
  '3. 举例最多两句，必须是最基础的 N5 句子，且每句都要给假名读音。',
  '   拿不准的句子就不要写。学生无法分辨对错，错的例句会被照原样记住。',
  '4. 不要输出 JSON、Markdown 标题或列表符号，直接写成简短的几行。',
  '5. 全文控制在 150 字以内。',
].join('\n');

export interface Explanation {
  readonly text: string;
}

export async function explain(
  target: ExplainTarget,
  options: ExplainOptions,
): Promise<Explanation> {
  const lines = [`词条：${target.subject}`];
  if (target.reading !== undefined) lines.push(`读音：${target.reading}`);
  if (target.meaning !== undefined) lines.push(`释义（以此为准）：${target.meaning}`);
  if (target.mistake !== undefined) {
    lines.push(`学生刚才答错了，答成：${target.mistake}`);
    lines.push('请顺带说明容易混淆的地方。');
  }

  const response = await options.client.messages.create({
    model: options.model,
    max_tokens: options.maxTokens ?? 600,
    system: [{ type: 'text', text: SYSTEM }],
    messages: [{ role: 'user', content: lines.join('\n') }],
  });
  options.onUsage?.({
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    requestId: response.id,
  });

  const text = response.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter((chunk) => chunk !== '')
    .join('\n')
    .trim();

  return { text: stripMarkdown(text) };
}

/**
 * 強調記号を落とす。
 *
 * 方針で「Markdown を使うな」と書いてあっても、実測では `**し**` のように
 * 返ってくる（2026-08-14 確認）。素のテキストとして送ると記号がそのまま
 * 見えるので、指示に頼らず落とす。
 *
 * parse_mode を付けて解釈させる手もあるが、日本語には `_` や `*` を含む
 * 文が普通に出るうえ、解析に失敗すると**メッセージ自体が送れない**。
 * 記号を消すほうが壊れ方が穏やか。
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|\s)\*(\S(?:.*?\S)?)\*(?=\s|$)/g, '$1$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .trim();
}
