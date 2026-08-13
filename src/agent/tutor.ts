import type Anthropic from '@anthropic-ai/sdk';
import type { PendingIssue } from '../corrections/index.js';
import type { KnowledgeKeyStore } from '../db/repositories/knowledgeItems.js';
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
  type DetectedIssueOutput,
  type TutorOutput,
} from './schemas.js';

export const TUTOR_PROVIDER_NAME = 'anthropic';
export const DEFAULT_MAX_TOKENS = 16000;

// MiniMax は output_config.format をサポートしない（黙って無視される）ため、
// 構造化出力は強制ツール呼び出しで実現する。tool_use.input がそのまま構造化結果。
export const TUTOR_TOOL_NAME = 'submit_tutor_turn';

const TUTOR_TOOL: Anthropic.Tool = {
  name: TUTOR_TOOL_NAME,
  description:
    'チューターの1ターン分の構造化応答を提出します。reply・detectedIssues・correctionCard・retryEvaluation・session をスキーマに厳密に従って含めてください。',
  input_schema: TUTOR_OUTPUT_JSON_SCHEMA as Anthropic.Tool.InputSchema,
};

// 初期キー空間は N5 頻出の誤り類型のみ。列挙で塞がず、
// 新しいキーは knowledge_items へ登録されて徐々に育つ。
export const INITIAL_KNOWLEDGE_KEYS: readonly string[] = [
  'verb_masu_past',
  'verb_te_form',
  'particle_ni_de',
  'particle_wa_ga',
  'adjective_i_negative',
  'counter_usage',
];

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

- 指示が HOLD の場合：返答テキスト（reply.japanese）の中で、誤りの指摘・訂正・推奨表現・正しい形の例示を一切してはいけません。「正しくは〜」「自然な日本語に直すと〜」「〜ではなく〜と言います」のように誤りへ言及する表現も禁止です。学習者の発話の内容にだけ応答し、あくまで自然な会話の継続だけを返してください。検出した問題は detectedIssues にのみ記録し、correctionCard は必ず null にしてください。
- 指示が SURFACE の場合：指定された問題だけを correctionCard にレンダリングしてください。指定されていない問題は correctionCard に含めず、detectedIssues への記録は通常どおり行ってください。指示に言い直しの要求（requestRetry）が含まれる場合は、推奨表現でもう一度言ってもらうよう促してください。reply.japanese は通常どおり会話を続ける本文です。

各 issue には次を含めてください：
- original: 学習者が実際に言った問題の部分（原文のまま）
- recommended: 正しい、またはより自然な形
- reason: なぜそうなるかの簡潔な説明（日本語で）
- naturalAlternative: ネイティブが同じ場面でよく使う別の自然な言い方。なければ null
- knowledgeKey: 問題の種類を表す安定した snake_case のキー。^[a-z][a-z0-9_]*$ の形式のみ許可され、空白・日本語・矢印を含む自由文は禁止です（例: verb_masu_past, particle_wa_ga, adjective_i_negative）。ユーザーメッセージ内の <known_knowledge_keys> に既知のキー一覧があります。同じ種類の誤りには必ずその一覧のキーを再利用し、一致するものが本当にない場合だけ新しいキーを作ってください
- importance: 学習者の理解にとっての重要度（LOW / MEDIUM / HIGH）

重要度の目安：
- HIGH: 意味が通じない、または大きく誤解される誤り
- MEDIUM: 意味は通じるが明らかに不自然・非文法的な誤り
- LOW: 細かな言い回しや好みの差

明確な誤りがない場合は detectedIssues を空配列にしてください。推測やこじつけで issue を作らないでください。

# 出力形式

応答は必ず submit_tutor_turn ツールの呼び出しで返してください。ツールの引数はスキーマに厳密に従ってください。ツールを呼ばずに本文テキストだけを返すことは禁止です。

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

export const REPAIR_INSTRUCTION = `直前のツール呼び出しの引数がスキーマを満たしていません。会話の内容は変えず、形式だけを修正して ${TUTOR_TOOL_NAME} をもう一度呼び出してください。特に knowledgeKey は ^[a-z][a-z0-9_]*$ の snake_case のみ許可され、空白・日本語・記号を含む自由文は使えません。`;

// 実測（2026-08-14, MiniMax-M3）：モデルの既定挙動は reply 本文の中で
// その場で訂正することである。HOLD を守らせるには禁止を具体的に列挙し、
// 併せて「代わりに何をするか」を指示する必要がある。
export const HOLD_DIRECTIVE_TEXT = [
  '提示指示: HOLD。',
  '検出した問題は detectedIssues にのみ記録してください。correctionCard は null です。',
  '明らかな誤りがあっても、このターンでは一切指摘しません。以下はすべて禁止です：',
  '  - 「〜に直すと」「正しくは」「〜ではなく〜です」のような訂正表現',
  '  - 推奨表現・正しい形を reply.japanese の中に書くこと',
  '  - 誤りを婉曲に示唆すること（「もう一度言ってみて」等も含む）',
  '代わりに、学習者が言おうとした内容をそのまま受け取り、自然な相づちと、',
  '話題を続ける短い質問を返してください。訂正はあとで別のターンに行います。',
].join('\n');

const CHINESE_USAGE_DIRECTIVE: Record<ModePolicy['chineseAllowed'], string> = {
  none: '中国語ポリシー: none。中国語は一切使わないでください。reply.translation は必ず null にし、説明も含めてすべて日本語で行ってください。',
  'nuance-only':
    '中国語ポリシー: nuance-only。中国語の使用は複雑なニュアンスの説明に限定し、それ以外はすべて日本語で返答してください。',
  'grammar-ok':
    '中国語ポリシー: grammar-ok。文法の説明には簡潔な中国語を使っても構いませんが、会話本文は日本語にしてください。',
  'as-needed':
    '中国語ポリシー: as-needed。学習者の理解を助けるため、必要に応じて短い中国語の説明を添えても構いません。',
  // まだ仮名が読めない段階。日本語だけで返すと一文字も伝わらない。
  primary: [
    '中国語ポリシー: primary。学習者はまだ仮名を読めません。',
    '返答は**中国語を主体**にしてください。日本語は一度に一つの短い語句までとし、',
    '必ず仮名の読みと中国語訳を添えてください（例：「こんにちは（konnichiwa／你好）」）。',
    '漢字だけを読みなしで出さないでください。読めない文字は学べません。',
  ].join('\n'),
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
  /**
   * どのフィールドが検証に落ちたか。
   *
   * 以前は理由を捨てていた。本番で稀に出る失敗ほど再現が難しく、
   * 「schema validation failed」だけ残っても打つ手が無い——落ちた
   * 瞬間の情報が唯一の手がかりなので、必ず持って上がる。
   */
  readonly validationErrors: string | undefined;

  constructor(validationErrors?: string) {
    super('tutor llm output failed schema validation after one repair attempt');
    this.name = 'TutorOutputError';
    this.validationErrors = validationErrors;
  }
}

export interface MinimalTutorOptions {
  client: AnthropicClientLike;
  model: string;
  provider?: string;
  maxTokens?: number;
  promptCacheEnabled?: boolean;
  policy?: string;
  knowledgeKeys?: KnowledgeKeyStore;
}

interface AttemptSuccess {
  ok: true;
  output: TutorOutput;
  response: Anthropic.Message;
}

interface AttemptFailure {
  ok: false;
  /** 検証に失敗した tool_use ブロック。repair の tool_result で参照する。 */
  toolUse?: Anthropic.ToolUseBlock;
  /** Zod の検証エラー。モデルに何を直すか具体的に伝える。 */
  errors?: string;
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

export function buildKnownKeysText(keys: readonly string[]): string {
  return [
    '既知の knowledgeKey 一覧です。同じ種類の誤りには必ずこの中のキーを再利用してください。',
    '一致するものが本当にない場合だけ、^[a-z][a-z0-9_]*$ の新しいキーを作ってください。',
    keys.join(', '),
  ].join('\n');
}

function buildUserMessage(
  request: TutorRequest,
  knownKnowledgeKeys: readonly string[],
): string {
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
  parts.push(
    '<known_knowledge_keys>',
    buildKnownKeysText(knownKnowledgeKeys),
    '</known_knowledge_keys>',
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

/**
 * 強制ツール呼び出しでは tool_use.input がそのまま構造化結果になる。
 * 文字列ではなくオブジェクトを直接検証するため JSON.parse は不要。
 */
function parseToolInput(
  input: unknown,
): { ok: true; output: TutorOutput } | { ok: false; errors: string } {
  const validated = tutorOutputSchema.safeParse(input);
  if (validated.success) {
    return { ok: true, output: validated.data };
  }
  const errors = validated.error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  return { ok: false, errors };
}

/**
 * 訂正を明示する定型表現。これらが本文にあれば訂正とみなす。
 */
const CORRECTION_MARKERS: readonly string[] = [
  '正しく',
  '正しい形',
  '直す',
  '直し',
  'ではなく',
  '間違',
  '誤り',
  'と言います',
  'と言うほうが',
  'が正解',
  '訂正',
];

/**
 * HOLD 時に reply.japanese へ訂正が漏れていないかを調べる。
 *
 * 実測で判明した落とし穴：recommended の部分一致だけで判定すると誤検出する。
 * 例）「読みますました」→ recommended「読みました」に対し、本文が
 * 「どんな本を読みましたか」という自然な問い返しでも一致してしまう。
 * 一般的な活用形は通常の会話文にそのまま現れるため、部分一致は使えない。
 *
 * そこで二つの信号で判定する：
 *   1. 訂正の定型表現が含まれる
 *   2. 学習者の誤った原形をそのまま引用している（誤りを指し示す強い兆候）
 *
 * プログラム側は検出までで本文の改変はしない。改変すると会話が壊れるため、
 * 対処はプロンプト側で行い、ここは計測と監視のために用いる（W11 §3）。
 */
export function replyContainsCorrection(
  replyText: string,
  issues: readonly Pick<DetectedIssueOutput, 'recommended' | 'original'>[],
): boolean {
  if (CORRECTION_MARKERS.some((marker) => replyText.includes(marker))) {
    return true;
  }
  return issues.some(
    (issue) => issue.original.length >= 3 && replyText.includes(issue.original),
  );
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
        tools: [TUTOR_TOOL],
        // 強制呼び出し。MiniMax は output_config.format を黙って無視するため、
        // スキーマ強制はツールの input_schema に委ねる。
        tool_choice: { type: 'tool', name: TUTOR_TOOL_NAME },
      });
    } catch {
      throw new TutorRequestError();
    }
    // 応答には text ブロックと tool_use ブロックが同時に含まれうる（実測）。
    // content[0] を仮定せず tool_use を探す。
    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock =>
        block.type === 'tool_use' && block.name === TUTOR_TOOL_NAME,
    );
    if (toolUse === undefined) {
      return { attempt: { ok: false }, response };
    }
    const parsed = parseToolInput(toolUse.input);
    if (!parsed.ok) {
      return {
        attempt: { ok: false, toolUse, errors: parsed.errors },
        response,
      };
    }
    return { attempt: { ok: true, output: parsed.output, response }, response };
  }

  // 既知キーの提示と新規キーの登録は補助処理であり、失敗でターンを落とさない。
  // 登録は (type, key) 一意制約で冪等なので、次ターンに自然に再試行される。
  async function listKnownKeys(): Promise<readonly string[]> {
    const store = options.knowledgeKeys;
    if (store === undefined) {
      return INITIAL_KNOWLEDGE_KEYS;
    }
    try {
      const stored = await store.listKeys();
      return [...new Set([...INITIAL_KNOWLEDGE_KEYS, ...stored])];
    } catch {
      return INITIAL_KNOWLEDGE_KEYS;
    }
  }

  async function registerNewKeys(
    output: TutorOutput,
    knownKeys: readonly string[],
  ): Promise<void> {
    const store = options.knowledgeKeys;
    if (store === undefined) {
      return;
    }
    const known = new Set(knownKeys);
    const newKeys = [
      ...new Set(output.detectedIssues.map((issue) => issue.knowledgeKey)),
    ].filter((key) => !known.has(key));
    if (newKeys.length === 0) {
      return;
    }
    try {
      await store.registerKeys(newKeys);
    } catch {
      // 上記のとおり、登録失敗はターンを落とさない。
    }
  }

  return {
    name: provider,
    model: options.model,
    async respond(request: TutorRequest): Promise<TutorResponse> {
      const system = buildSystem(policy, cacheEnabled);
      // 呼び出し側が既知キーを渡してきた場合はそれも既知として扱う。
      const knownKeys = [
        ...new Set([
          ...(await listKnownKeys()),
          ...(request.knownKnowledgeKeys ?? []),
        ]),
      ];
      const responses: Anthropic.Message[] = [];
      const baseMessages: Anthropic.MessageParam[] = [
        { role: 'user', content: buildUserMessage(request, knownKeys) },
      ];

      const first = await callOnce(system, baseMessages);
      if (first.response !== undefined) {
        responses.push(first.response);
      }
      let attempt = first.attempt;

      if (!attempt.ok) {
        // ツール呼び出しの失敗は tool_result で差し戻すのが Anthropic 系の
        // プロトコル。tool_use が返らなかった場合だけ通常のテキストで促す。
        const repairMessages: Anthropic.MessageParam[] =
          attempt.toolUse !== undefined
            ? [
                ...baseMessages,
                { role: 'assistant', content: [attempt.toolUse] },
                {
                  role: 'user',
                  content: [
                    {
                      type: 'tool_result' as const,
                      tool_use_id: attempt.toolUse.id,
                      is_error: true,
                      content: `${REPAIR_INSTRUCTION}\n検証エラー: ${attempt.errors ?? '(不明)'}`,
                    },
                  ],
                },
              ]
            : [...baseMessages, { role: 'user', content: REPAIR_INSTRUCTION }];
        const second = await callOnce(system, repairMessages);
        if (second.response !== undefined) {
          responses.push(second.response);
        }
        attempt = second.attempt;
      }

      if (!attempt.ok) {
        throw new TutorOutputError(attempt.errors);
      }

      // 実測（2026-08-14）：recommended が original と同一の「訂正のない issue」を
      // 返すことがある。そのまま通すと Error Bank に誤りでないものが溜まり、
      // §3.3 の mastery を歪めるため、プログラム側で落とす。
      const detectedIssues = attempt.output.detectedIssues.filter(
        (issue: DetectedIssueOutput) => issue.recommended !== issue.original,
      );

      // 新しく現れた knowledgeKey を登録する。§3.3 の mastery は知識項目ごとの
      // 集計なので、キーが登録されないと以降のターンで再利用させられない。
      await registerNewKeys(attempt.output, knownKeys);

      const correctionCard =
        request.surfacingDirective?.action === 'HOLD'
          ? null
          : attempt.output.correctionCard;

      return {
        replyText: attempt.output.reply.japanese,
        ttsText: attempt.output.reply.japanese,
        detectedIssues,
        correctionCard,
        retryEvaluation: attempt.output.retryEvaluation,
        provider,
        model: options.model,
        usage: sumUsage(responses),
      };
    },
  };
}
