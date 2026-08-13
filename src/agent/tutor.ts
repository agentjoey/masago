import type Anthropic from '@anthropic-ai/sdk';
import type { PendingIssue } from '../corrections/index.js';
import type { HintLevel, ModePolicy } from '../sessions/modes.js';
import type {
  Tutor,
  TutorRequest,
  TutorResponse,
} from '../sessions/voiceTurn.js';
import type { AnthropicClientLike } from './llm/types.js';
import {
  TUTOR_OUTPUT_JSON_SCHEMA,
  tutorOutputSchema,
  type TutorOutput,
} from './schemas.js';

export const TUTOR_PROVIDER_NAME = 'anthropic';
export const DEFAULT_MAX_TOKENS = 16000;

export const TUTOR_POLICY = `あなたは日本人学習者のための日本語会話チューターです。学習者は中国語を母語とし、日本語は初級から中級（JLPT N5〜N3 相当）です。あなたの役割は、学習者が安心して日本語を口に出し続けられる会話相手になることです。

# 会話の基本姿勢

- 常に自然で簡潔な日本語で返答してください。一回の返答は1〜3文を目安にし、音声で聞いて自然な長さに保ちます。
- 学習者の発話内容に正面から応答し、会話が続くように軽い質問や相づちを添えてください。
- 学習者のレベルに合わせて語彙と文法を調整してください。難しい表現を使う場合は、より平易な言い換えを優先します。
- 敬語は丁寧体（です・ます調）を基本とし、堅すぎる表現は避けてください。
- 学習者が英語や中国語を混ぜてきた場合でも、責めずに日本語の会話へ自然に戻してください。
- 返答にローマ字は使わないでください。漢字には特別な指示がない限りふりがなを振らないでください。

# 誤りの検出と提示指示

学習者の発話に文法・語彙・助詞・活用・自然さの問題を見つけた場合は、毎ターン必ず detectedIssues に記録してください。提示のタイミングは別のシステム（Correction Scheduler）が管理し、ユーザーメッセージ内の <correction_directive> で毎ターン明示されます。

- 指示が HOLD の場合：返答テキスト（reply.japanese）の中で誤りを指摘したり、訂正を促したり、推奨表現を示したりしてはいけません。検出した問題は detectedIssues にのみ記録し、correctionCard は必ず null にしてください。あなたの返答はあくまで自然な会話の継続です。
- 指示が SURFACE の場合：指定された問題だけを correctionCard にレンダリングしてください。指定されていない問題は correctionCard に含めず、detectedIssues への記録は通常どおり行ってください。指示に言い直しの要求（requestRetry）が含まれる場合は、推奨表現でもう一度言ってもらうよう促してください。reply.japanese は通常どおり会話を続ける本文です。

各 issue には次を含めてください：
- original: 学習者が実際に言った問題の部分（原文のまま）
- recommended: 正しい、またはより自然な形
- reason: なぜそうなるかの簡潔な説明（日本語で）
- naturalAlternative: ネイティブが同じ場面でよく使う別の自然な言い方。なければ null
- knowledgeKey: 問題の種類を表す安定した snake_case のキー（例: verb_masu_past, particle_wa_ga, adjective_conjugation）
- importance: 学習者の理解にとっての重要度（LOW / MEDIUM / HIGH）

重要度の目安：
- HIGH: 意味が通じない、または大きく誤解される誤り
- MEDIUM: 意味は通じるが明らかに不自然・非文法的な誤り
- LOW: 細かな言い回しや好みの差

明確な誤りがない場合は detectedIssues を空配列にしてください。推測やこじつけで issue を作らないでください。

# 出力形式

出力は指定された JSON schema に厳密に従ってください。説明文やマークダウン、コードブロックは一切付けず、JSON だけを出力してください。

- reply.japanese: 学習者への日本語の返答本文。音声合成でそのまま読み上げられるため、記号の羅列や絵文字、URL、箇条書きは使わないでください。
- reply.translation: 通常は null です。学習者が明示的に意味を尋ねた場合のみ、中国語での簡潔な訳を入れてください。
- detectedIssues: 上記の形式で検出した問題の配列。提示の有無にかかわらず毎ターン出力してください。
- correctionCard: 提示指示が SURFACE の場合のみ、指定された問題を学習者向けに説明するテキスト（原句・推奨表現・理由を含む）。HOLD の場合は必ず null。
- retryEvaluation: 前のターンで言い直しを求めた場合のみ、今回の発話が改善したかの判定。それ以外は null。
- session.continue: 会話を続けられる状態であれば true。学習者が明確に会話を終わらせようとしている場合のみ false。

# 話題の進め方

- 日常生活、趣味、食べ物、旅行、季節の話題など、初級学習者が話しやすい題材を優先してください。
- 学習者が短い返事しかできないときは、答えやすい具体的な質問で助けてください。
- 同じ質問の繰り返しや、会話を打ち切るような素っ気ない返答は避けてください。
- 政治的・宗教的な話題、個人情報の詮索、医療・法律などの専門的助言には踏み込まず、穏やかに話題を変えてください。

# 音声会話であることへの配慮

- 学習者の入力は音声認識の結果です。認識誤りらしき不自然な部分があっても、文脈から意図を推測して自然に応答してください。「聞き取れませんでした」と安易に言わず、会話を前に進めることを優先してください。
- ただし文脈からも意味が全く取れない場合に限り、短く優しく聞き返してください。
- 返答は耳で聞いて理解できる平易さを最優先してください。書き言葉的な長文は禁物です。

# 一貫性

- 同じ会話の中では人物・話題・時制の前提を保ってください。
- 学習者が以前に話した内容を覚えている振る舞いは、その内容が会話履歴に存在する場合に限ります。
- あなたはAIであることを隠す必要はありませんが、会話の主役は常に学習者の日本語練習です。`;

export const REPAIR_INSTRUCTION =
  '直前の応答は指定された JSON schema を満たしていません。会話の内容は変えず、形式だけを修正して、schema に完全一致する JSON だけを出力してください。';

export const HOLD_DIRECTIVE_TEXT =
  '提示指示: HOLD。通常どおり会話を続けてください。検出した問題は detectedIssues にのみ記録し、reply.japanese の中で指摘・訂正・推奨表現の提示をしてはいけません。correctionCard は null にしてください。';

const CHINESE_USAGE_DIRECTIVE: Record<ModePolicy['chineseAllowed'], string> = {
  none: '中国語ポリシー: none。中国語は一切使わないでください。reply.translation は必ず null にし、説明も含めてすべて日本語で行ってください。',
  'nuance-only':
    '中国語ポリシー: nuance-only。中国語の使用は複雑なニュアンスの説明に限定し、それ以外はすべて日本語で返答してください。',
  'grammar-ok':
    '中国語ポリシー: grammar-ok。文法の説明には簡潔な中国語を使っても構いませんが、会話本文は日本語にしてください。',
  'as-needed':
    '中国語ポリシー: as-needed。学習者の理解を助けるため、必要に応じて短い中国語の説明を添えても構いません。',
};

const IMMERSIVE_DIRECTIVE =
  'このセッションは全日語イマージョンです。学習者が困っていても、原則として中国語に逃げず、平易な日本語で説明し直してください。';

export function buildModePolicyText(policy: ModePolicy): string {
  const lines = [CHINESE_USAGE_DIRECTIVE[policy.chineseAllowed]];
  if (policy.immersive) {
    lines.push(IMMERSIVE_DIRECTIVE);
  }
  return lines.join('\n');
}

const HINT_LEVEL_DIRECTIVE: Record<HintLevel, string> = {
  1: '学習者が「ヒント」を求めています。中国語は使わず、日本語で短いヒントを一つだけ返してください。答えそのものは教えないでください。',
  2: '学習者は前のヒントでもまだ解決できていません。キーワードまたは文型の枠組みを日本語で示してください。答えそのものは教えないでください。',
  3: '学習者は繰り返しつまずいています。最後の手段として、短い中国語の説明を一文だけ添えても構いません。それ以外は日本語で返答してください。',
};

export function buildHintRequestText(level: HintLevel): string {
  return HINT_LEVEL_DIRECTIVE[level];
}

export function buildRetryEvaluationText(issues: PendingIssue[]): string {
  const payload = issues.map((issue) => ({
    id: issue.id,
    original: issue.original,
    recommended: issue.recommended,
    knowledgeKey: issue.knowledgeKey,
  }));
  return [
    '前のターンで、次の問題について推奨表現での言い直しを求めました。今回の学習者の発話がこれらの問題について改善したかを判定し、retryEvaluation に結果を入れてください。改善が見られない場合は succeeded を false にしてください。',
    JSON.stringify(payload, null, 2),
  ].join('\n');
}

export function buildSurfacingDirectiveText(
  directive: NonNullable<TutorRequest['surfacingDirective']>,
): string {
  if (directive.action === 'HOLD') {
    return HOLD_DIRECTIVE_TEXT;
  }
  const issues = directive.issues.map((issue) => ({
    id: issue.id,
    original: issue.original,
    recommended: issue.recommended,
    reason: issue.reason,
    importance: issue.importance,
  }));
  const lines = [
    '提示指示: SURFACE。次の問題だけを correctionCard にレンダリングしてください。reply.japanese は通常どおり会話を続ける本文にしてください。',
    JSON.stringify(issues, null, 2),
  ];
  if (directive.requestRetry) {
    lines.push(
      'correctionCard の末尾で、推奨表現を使ってもう一度言ってもらうよう促してください。',
    );
  }
  return lines.join('\n');
}

export class TutorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TutorError';
  }
}

export class TutorRequestError extends TutorError {
  constructor() {
    super('tutor llm request failed');
    this.name = 'TutorRequestError';
  }
}

export class TutorOutputError extends TutorError {
  constructor() {
    super('tutor llm output failed schema validation after one repair attempt');
    this.name = 'TutorOutputError';
  }
}

export interface MinimalTutorOptions {
  client: AnthropicClientLike;
  model: string;
  provider?: string;
  maxTokens?: number;
  promptCacheEnabled?: boolean;
  policy?: string;
}

interface AttemptSuccess {
  ok: true;
  output: TutorOutput;
  response: Anthropic.Message;
}

interface AttemptFailure {
  ok: false;
  rawText?: string;
}

type Attempt = AttemptSuccess | AttemptFailure;

function buildSystem(
  policy: string,
  cacheEnabled: boolean,
): Anthropic.TextBlockParam[] {
  return [
    {
      type: 'text',
      text: policy,
      ...(cacheEnabled
        ? { cache_control: { type: 'ephemeral' as const } }
        : {}),
    },
  ];
}

function buildUserMessage(request: TutorRequest): string {
  const parts: string[] = [];
  if (request.modePolicy !== undefined) {
    parts.push('<mode_policy>', buildModePolicyText(request.modePolicy), '</mode_policy>');
  }
  parts.push(
    '<learner_input>',
    `<raw_transcript>${request.rawTranscript}</raw_transcript>`,
    `<normalized_transcript>${request.normalizedTranscript}</normalized_transcript>`,
    '</learner_input>',
  );
  if (request.surfacingDirective !== undefined) {
    parts.push(
      '<correction_directive>',
      buildSurfacingDirectiveText(request.surfacingDirective),
      '</correction_directive>',
    );
  }
  if (request.retryEvaluationRequest !== undefined) {
    parts.push(
      '<retry_evaluation_request>',
      buildRetryEvaluationText(request.retryEvaluationRequest.issues),
      '</retry_evaluation_request>',
    );
  }
  if (request.hint !== undefined) {
    parts.push(
      '<hint_request>',
      buildHintRequestText(request.hint.level),
      '</hint_request>',
    );
  }
  return parts.join('\n');
}

function parseOutput(text: string): TutorOutput | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const validated = tutorOutputSchema.safeParse(parsed);
  return validated.success ? validated.data : undefined;
}

function sumUsage(
  responses: readonly Anthropic.Message[],
): TutorResponse['usage'] {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  for (const response of responses) {
    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;
    cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
    cacheWriteTokens += response.usage.cache_creation_input_tokens ?? 0;
  }
  const last = responses[responses.length - 1];
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    requestId: last?.id,
  };
}

export function createMinimalTutor(options: MinimalTutorOptions): Tutor {
  const provider = options.provider ?? TUTOR_PROVIDER_NAME;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const cacheEnabled = options.promptCacheEnabled ?? true;
  const policy = options.policy ?? TUTOR_POLICY;

  async function callOnce(
    system: Anthropic.TextBlockParam[],
    messages: Anthropic.MessageParam[],
  ): Promise<{ attempt: Attempt; response?: Anthropic.Message }> {
    let response: Anthropic.Message;
    try {
      response = await options.client.messages.create({
        model: options.model,
        max_tokens: maxTokens,
        system,
        messages,
        output_config: {
          format: { type: 'json_schema', schema: TUTOR_OUTPUT_JSON_SCHEMA },
        },
      });
    } catch {
      throw new TutorRequestError();
    }
    const textBlock = response.content.find((block) => block.type === 'text');
    if (textBlock === undefined) {
      return { attempt: { ok: false }, response };
    }
    const output = parseOutput(textBlock.text);
    if (output === undefined) {
      return {
        attempt: { ok: false, rawText: textBlock.text },
        response,
      };
    }
    return { attempt: { ok: true, output, response }, response };
  }

  return {
    name: provider,
    model: options.model,
    async respond(request: TutorRequest): Promise<TutorResponse> {
      const system = buildSystem(policy, cacheEnabled);
      const responses: Anthropic.Message[] = [];
      const baseMessages: Anthropic.MessageParam[] = [
        { role: 'user', content: buildUserMessage(request) },
      ];

      const first = await callOnce(system, baseMessages);
      if (first.response !== undefined) {
        responses.push(first.response);
      }
      let attempt = first.attempt;

      if (!attempt.ok) {
        const repairMessages: Anthropic.MessageParam[] = [
          ...baseMessages,
          {
            role: 'assistant',
            content:
              attempt.ok === false && attempt.rawText !== undefined
                ? attempt.rawText
                : '(empty response)',
          },
          { role: 'user', content: REPAIR_INSTRUCTION },
        ];
        const second = await callOnce(system, repairMessages);
        if (second.response !== undefined) {
          responses.push(second.response);
        }
        attempt = second.attempt;
      }

      if (!attempt.ok) {
        throw new TutorOutputError();
      }

      const correctionCard =
        request.surfacingDirective?.action === 'HOLD'
          ? null
          : attempt.output.correctionCard;

      return {
        replyText: attempt.output.reply.japanese,
        ttsText: attempt.output.reply.japanese,
        detectedIssues: attempt.output.detectedIssues,
        correctionCard,
        retryEvaluation: attempt.output.retryEvaluation,
        provider,
        model: options.model,
        usage: sumUsage(responses),
      };
    },
  };
}
