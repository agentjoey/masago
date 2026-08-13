/**
 * 在线验证脚本（手动运行，不进 pnpm test / CI）：用真实 API 验证
 * MiniMax M3 在 HOLD 指令下不把纠正写进 reply.japanese 正文。
 *
 * 背景（W11 §3）：实测发现 M3 的默认倾向是在正文里直接纠错
 * （「自然な日本語に直すと、…」）。程序级防护只强制清空 correctionCard，
 * 管不到正文泄漏，所以必须用真模型连续多次实测泄漏率。
 *
 * 运行：pnpm verify:llm（需要 .env 中的 LLM_API_KEY 等真实配置）
 * 退出码：泄漏或调用失败为非零时 exit 1。结果必须如实报告。
 */
import {
  createAnthropicClient,
  createMinimalTutor,
  replyContainsCorrection,
} from '../src/agent/index.js';
import { config } from '../src/config/index.js';

interface Case {
  name: string;
  utterance: string;
}

// 每个用例都含明显错误，足以诱发模型「顺手纠正」的默认行为。
const out = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};

const CASES: Case[] = [
  {
    name: '动词过去形误用',
    utterance: '昨日、友達と映画を見るました',
  },
  {
    name: '助词 に/で 混用',
    utterance: '毎朝七時に学校で起きます',
  },
  {
    name: 'イ形容词否定误用',
    utterance: 'このりんごはおいしくないです。でもあれはおいしいじゃないです',
  },
  {
    name: '助数词误用',
    utterance: '犬を三匹あります',
  },
  {
    name: 'て形误用',
    utterance: '図書館へ行って、本を読みますました',
  },
  {
    name: 'が/を 混用',
    utterance: '日本語を話すことが好きです。でも漢字を読むことができません',
  },
];

async function main(): Promise<void> {
  out('verify:llm — HOLD 正文泄漏在线验证');
  out(
    `provider=${config.llm.provider} model=${config.llm.model} baseUrl=${config.llm.baseUrl}`,
  );
  out(`runs=${CASES.length}（每个用例：明显错误输入 + HOLD 指令）\n`);

  const client = createAnthropicClient({
    apiKey: config.llm.apiKey,
    baseUrl: config.llm.baseUrl,
  });
  const tutor = createMinimalTutor({
    client,
    model: config.llm.model,
    provider: config.llm.provider,
    promptCacheEnabled: config.llm.promptCacheEnabled,
  });

  let clean = 0;
  let leaked = 0;
  let failed = 0;

  for (const [index, testCase] of CASES.entries()) {
    const label = `[${index + 1}/${CASES.length}] ${testCase.name}`;
    try {
      const response = await tutor.respond({
        rawTranscript: testCase.utterance,
        normalizedTranscript: testCase.utterance,
        surfacingDirective: { action: 'HOLD' },
      });
      const issues = response.detectedIssues ?? [];
      const replyLeaked = replyContainsCorrection(response.replyText, issues);
      // correctionCard 由程序强制清空，这里只是再次确认程序级保证成立。
      const cardLeaked =
        response.correctionCard !== null &&
        response.correctionCard !== undefined;

      out(`${label}`);
      out(`  input:  ${testCase.utterance}`);
      out(`  reply:  ${response.replyText}`);
      out(
        `  issues: ${issues
          .map((issue) => `${issue.knowledgeKey}(${issue.original}→${issue.recommended})`)
          .join(', ') || '(none)'}`,
      );
      out(`  correctionCard(程序强制): ${response.correctionCard ?? 'null'}`);
      if (replyLeaked || cardLeaked) {
        leaked += 1;
        out(
          `  => LEAK（${[
            replyLeaked ? 'reply.japanese 含推荐表达' : '',
            cardLeaked ? 'correctionCard 非 null' : '',
          ]
            .filter(Boolean)
            .join('；')}）\n`,
        );
      } else {
        clean += 1;
        out('  => OK\n');
      }
    } catch (error) {
      failed += 1;
      const name = error instanceof Error ? error.name : 'UnknownError';
      out(`${label}\n  input:  ${testCase.utterance}`);
      out(`  => CALL FAILED (${name})\n`);
    }
  }

  const total = CASES.length;
  const leakRate = ((leaked / total) * 100).toFixed(1);
  out('──────── 结果 ────────');
  out(`clean:  ${clean}/${total}`);
  out(`leaked: ${leaked}/${total}`);
  out(`failed: ${failed}/${total}`);
  out(`HOLD 泄漏率: ${leakRate}%`);
  if (leaked > 0 || failed > 0) {
    out(
      '\n结论：泄漏率不为零（或存在调用失败）。这是真实产品风险，请如实上报 orchestrator。',
    );
    process.exitCode = 1;
  } else {
    out('\n结论：本次运行未观察到泄漏。');
  }
}

await main();
