import { sql } from 'drizzle-orm';
import { InputFile } from 'grammy';
import {
  createAnthropicClient,
  createMinimalTutor,
  explain,
} from './agent/index.js';
import { config } from './config/index.js';
import { createCorrectionTurnHooks } from './corrections/index.js';
import { closeDb, db, telegramUpdatesRepo, usageRecordsRepo } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { createKnowledgeKeyStore } from './db/repositories/knowledgeItems.js';
import { kanaOfKey } from './curriculum/kana.js';
import { conversationLevel } from './curriculum/stage.js';
import { streakOf } from './curriculum/render.js';
import * as learningEventsRepo from './db/repositories/learningEvents.js';
import * as reviewQueueRepo from './db/repositories/reviewQueue.js';
import { createKanaCommands } from './learning/kanaCommands.js';
import { ensureKanaSeeded } from './learning/kanaSeed.js';
import { ensureVocabSeeded } from './learning/vocabSeed.js';
import { ensureParticlesSeeded } from './learning/particleSeed.js';
import * as ttsCacheRepo from './db/repositories/ttsCache.js';
import { speak } from './speech/voiceCache.js';
import { collectReminderFacts } from './learning/reminderFacts.js';
import { createDailyReminder } from './scheduler/index.js';
import {
  localDateKey,
  partsInZone,
  zonedWallClockToInstant,
} from './scheduler/index.js';
import { createLogger } from './observability/index.js';
import {
  findLearnerId,
  loadCalendar,
  loadErrors,
  loadKanaTable,
  loadProgress,
  loadReading,
  judgeReading,
  markDueNow,
  startMiniAppServer,
} from './miniapp/index.js';
import { createAnalyzer, crossCheck } from './nlp/index.js';
import {
  createCommandHandlers,
  createHandleUpdate,
  type IncomingMessageContext,
  type OrchestratorVoiceDeps,
  type OutboundVoice,
  type Tutor,
} from './sessions/index.js';
import { isFfmpegAvailable } from './speech/index.js';
import { createSpeechProviders } from './speech/providerFactory.js';
import {
  createBot,
  publishCommandList,
  publishMenuButton,
  startWithRetry,
  type AppContext,
} from './telegram/index.js';
import { createVoiceDownloader } from './telegram/voice.js';
import { createRecorder, recordUsage, summarizeUsage } from './usage/index.js';
import pkg from '../package.json' with { type: 'json' };

const logger = createLogger({ level: config.logging.level });

export type ShutdownHook = () => void | Promise<void>;

const shutdownHooks: ShutdownHook[] = [];

export function onShutdown(hook: ShutdownHook): void {
  shutdownHooks.push(hook);
}

async function shutdown(signal: string): Promise<void> {
  logger.info('masago shutting down', { signal });
  for (const hook of shutdownHooks) {
    try {
      await hook();
    } catch (error) {
      logger.error('shutdown hook failed', { error });
    }
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

const { stt, tts } = createSpeechProviders(config);

// チューターと解説で同じ接続を使い回す。二つ作る理由が無い。
const llmClient = createAnthropicClient({
  apiKey: config.llm.apiKey,
  baseUrl: config.llm.baseUrl,
});

const tutor: Tutor = createMinimalTutor({
  client: llmClient,
  model: config.llm.model,
  provider: config.llm.provider,
  promptCacheEnabled: config.llm.promptCacheEnabled,
  knowledgeKeys: createKnowledgeKeyStore(db),
});

const usageRecorder = createRecorder({ executor: db, logger });

const corrections = createCorrectionTurnHooks({
  executor: db,
  config: config.correction,
});

const voice: OrchestratorVoiceDeps = {
  stt,
  tts,
  tutor,
  corrections,
  createDownloader: (api, meta) =>
    createVoiceDownloader(
      {
        api,
        token: config.telegram.botToken,
        limits: {
          maxSizeMb: config.audio.maxSizeMb,
          maxDurationSeconds: config.audio.maxDurationSeconds,
        },
      },
      meta,
    ),
  recordUsage: (input) => recordUsage(usageRecorder, input),
};

/**
 * 形態素解析。辞書が 400MB あるので子プロセスに置き、使わない間は落とす
 * （§8 / nlp/worker.ts）。常駐させると本体の 4 倍になり、Railway の
 * 月 $5 枠をほぼ使い切る。
 */
const analyzer = createAnalyzer({ logger });
onShutdown(() => {
  analyzer.shutdown();
});

const orchestratorDeps = {
  config,
  executor: db,
  logger,
  tutor,
  corrections,
  voice,
  // 水準は課程の進み具合から出す。プロフィールの文字列ではなく、
  // 実際に習った仮名の数で決める——読めない人に日本語で返さないため。
  grammarCheck: async (
    text: string,
    alreadyDetected: readonly { knowledgeKey: string; original: string }[],
  ) => {
    const result = await crossCheck(text, {
      analyzer,
      alreadyDetected,
      onError: (error) => {
        logger.warn('grammar cross-check unavailable', { error });
      },
    });
    return result.added.map((issue) => ({
      knowledgeKey: issue.knowledgeKey,
      original: issue.original,
      recommended: issue.recommended,
      explanation: issue.explanation,
    }));
  },
  resolveLevel: async (learnerId: string) => {
    const keys = await reviewQueueRepo.listIntroducedKeys(db, learnerId, 'KANA');
    const count = keys.filter((key) => kanaOfKey(key) !== undefined).length;
    return conversationLevel(count);
  },
};

const handleMessage = createHandleUpdate(orchestratorDeps);
const sessionCommands = createCommandHandlers(orchestratorDeps);

function adaptContext(ctx: AppContext): IncomingMessageContext {
  return {
    from: ctx.from,
    message: ctx.message,
    api: ctx.api,
    reply: async (text) => {
      await ctx.reply(text);
    },
    replyWithVoice: async (audio) => {
      const outbound = audio as OutboundVoice;
      const input =
        outbound.bytes !== undefined
          ? new InputFile(outbound.bytes, `reply.${outbound.format}`)
          : new InputFile(outbound.path as string);
      await ctx.replyWithVoice(input);
    },
  };
}

function keyFormatWarnings(): string[] {
  const warnings: string[] = [];
  if (!config.stt.openaiApiKey.startsWith('sk-')) {
    warnings.push('OPENAI_API_KEY does not match the expected sk- format');
  }
  if (config.tts.minimaxApiKey.trim().length < 20) {
    warnings.push('MINIMAX_API_KEY looks too short to be valid');
  }
  if (!config.llm.apiKey.startsWith('sk-ant-')) {
    warnings.push('LLM_API_KEY does not match the expected sk-ant- format');
  }
  return warnings;
}

async function runStartupChecks(): Promise<{ dbRoundTripMs: number }> {
  // ffmpeg が要るのは音声入力の正規化だけ（OGG/opus → STT が読める形）。
  // V2 は文字入力が主で音声入力は範囲外なので、無効なら要求しない。
  // ここを無条件の関門にしていると、使わない機能のために起動できなくなる。
  if (config.stt.inputEnabled && !(await isFfmpegAvailable())) {
    throw new Error(
      'startup check failed: VOICE_INPUT_ENABLED=true requires ffmpeg on PATH',
    );
  }
  // 往復時間を残す。Railway と Neon が同じ地域に居るかは設定画面を
  // 見ても分かりにくいが、この数字なら一目で分かる——同一地域なら
  // 数ミリ秒、大陸を跨げば数百ミリ秒になる（§10）。
  //
  // 一発目は TLS 握手と接続確立を含むので地域の判断には使えない。
  // 温めてから複数回測り、中央値を採る。ここは起動時の一度きりで、
  // 定期的に叩くわけではないので compute を起こし続ける心配は無い。
  // コードより先にスキーマを揃える。手で当て忘れた一回で機能ごと落ちる。
  await runMigrations({
    directUrl: config.db.urlDirect,
    connectionTimeoutMs: config.db.connectionTimeoutMs,
  });
  await db.execute(sql`select 1`);
  const samples: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const probeStart = performance.now();
    await db.execute(sql`select 1`);
    samples.push(performance.now() - probeStart);
  }
  samples.sort((a, b) => a - b);
  const dbRoundTripMs = Math.round(samples[1] ?? 0);
  // 仮名は 104 個で増えない。揃っていれば一件の SELECT で戻るので、
  // 起動ごとに呼んでも compute を無駄に起こさない（§9.1）。
  const seeded = await ensureKanaSeeded(db);
  if (seeded.inserted > 0) {
    logger.info('seeded kana knowledge items', { ...seeded });
  }
  const vocabSeeded = await ensureVocabSeeded(db);
  if (vocabSeeded.inserted > 0) {
    logger.info('seeded vocabulary knowledge items', { ...vocabSeeded });
  }
  const particlesSeeded = await ensureParticlesSeeded(db);
  if (particlesSeeded.inserted > 0) {
    logger.info('seeded particle knowledge items', { ...particlesSeeded });
  }
  for (const warning of keyFormatWarnings()) {
    logger.warn('provider key format looks unusual', { warning });
  }
  return { dbRoundTripMs };
}

const kanaCommands = createKanaCommands({
  executor: db,
  now: () => new Date(),
  random: Math.random,
  requestRetention: config.review.requestRetention,
  optionCount: config.kana.optionCount,
  newPerDay: config.kana.newPerDay,
  maxReviews: config.kana.maxReviews,
  backlogThreshold: config.kana.backlogThreshold,
  // 学習者の地域時間の 0 時。一日の新出上限をここで区切る。
  dayStart: (now: Date) => {
    const parts = partsInZone(now, config.session.userTimezone);
    return zonedWallClockToInstant(
      { ...parts, hour: 0, minute: 0 },
      config.session.userTimezone,
    );
  },
  activity: async (learnerId, now) => {
    const since = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
    const stamps = await learningEventsRepo.answerTimestampsSince(
      db,
      learnerId,
      since,
    );
    // 日界は学習者の時計で切る。試験済みの localDateKey に寄せて、
    // 同じ判断を SQL 側にも書かない。
    const counts = new Map<string, number>();
    for (const at of stamps) {
      const key = localDateKey(at, config.session.userTimezone);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const todayKey = localDateKey(now, config.session.userTimezone);
    const dayKeyBefore = (key: string, back: number): string => {
      const [y, m, d] = key.split('-').map((part) => Number.parseInt(part, 10));
      const at = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) - back));
      return `${String(at.getUTCFullYear())}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-${String(at.getUTCDate()).padStart(2, '0')}`;
    };
    const days = Array.from({ length: 7 }, (_, index) => {
      const key = dayKeyBefore(todayKey, 6 - index);
      return { day: key, count: counts.get(key) ?? 0 };
    });
    return { days, streak: streakOf(counts, todayKey, dayKeyBefore) };
  },
  dailyLimitUsd: config.budget.dailyCostSoftLimitUsd,
  monthlyLimitUsd: config.budget.monthlyCostSoftLimitUsd,
  explainItem: async (target) => {
    const result = await explain(target, {
      client: llmClient,
      model: config.llm.model,
    });
    return result.text;
  },
  costSummary: async (now) => {
    // 当月ぶんだけ読む。全期間を舐めると行が増えるほど遅くなる。
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const records = await usageRecordsRepo.findCreatedBetween(
      db,
      monthStart,
      new Date(now.getTime() + 60_000),
    );
    const summary = summarizeUsage(records, {
      timezone: config.session.userTimezone,
      now,
    });
    return {
      todayUsd: summary.today.costUsd,
      monthUsd: summary.thisMonth.costUsd,
      dailyLimitUsd: config.budget.dailyCostSoftLimitUsd,
      monthlyLimitUsd: config.budget.monthlyCostSoftLimitUsd,
      unknownCostCalls: summary.thisMonth.unknownCostCalls,
      topThisMonth: summary.breakdownThisMonth
        .slice(0, 5)
        .map((row) => ({
          label: `${row.provider}/${row.model}`,
          usd: row.costUsd,
        })),
    };
  },
});

const bot = createBot({
  config,
  logger,
  handleUpdate: (ctx) => handleMessage(adaptContext(ctx)),
  recordUpdate: async (updateId, payload) => {
    const result = await telegramUpdatesRepo.insertIfAbsent(db, updateId, payload);
    return result.inserted;
  },
  commands: sessionCommands,
  kana: {
    commands: kanaCommands,
    audioDir: config.kana.audioDir,
    // 単語の読み上げ。一度送れば file_id で使い回すので、同じ語の
    // 二度目以降は合成費用がかからない（§5.3）。
    speak: (text) =>
      speak(text, {
        cache: {
          lookup: (value) =>
            ttsCacheRepo.lookup(
              db,
              ttsCacheRepo.ttsCacheKey(
                value,
                config.tts.minimaxVoiceId,
                config.tts.modelTeaching,
              ),
            ),
          remember: () => Promise.resolve(),
        },
        tts,
        voiceId: config.tts.minimaxVoiceId,
      }),
    rememberVoice: (text, fileId) =>
      ttsCacheRepo.remember(db, {
        cacheKey: ttsCacheRepo.ttsCacheKey(
          text,
          config.tts.minimaxVoiceId,
          config.tts.modelTeaching,
        ),
        text,
        voiceId: config.tts.minimaxVoiceId,
        model: config.tts.modelTeaching,
        telegramFileId: fileId,
      }),
  },
});

const dailyReminder = createDailyReminder({
  logger,
  localTime: config.session.dailyReminderLocalTime,
  timeZone: config.session.userTimezone,
  collect: (now) => {
    // その地域の「今日の 0 時」。サーバの UTC 日付で切ると、
    // シンガポールの夜に学習した記録が翌日ぶんに数えられる。
    const parts = partsInZone(now, config.session.userTimezone);
    const dayStart = zonedWallClockToInstant(
      { ...parts, hour: 0, minute: 0 },
      config.session.userTimezone,
    );
    return collectReminderFacts(
      {
        executor: db,
        telegramUserId: config.telegram.allowedUserId,
        newPerDay: config.kana.newPerDay,
        maxReviews: config.kana.maxReviews,
        backlogThreshold: config.kana.backlogThreshold,
      },
      now,
      dayStart,
    );
  },
  send: async (text) => {
    await bot.api.sendMessage(config.telegram.allowedUserId, text);
  },
});

/**
 * Mini App（V3）と健康確認を同じポートで出す。ruby 排版・進度・錯題本・
 * 復習日历は同じ後端から読む——別集計を作ると bot と数字が食い違う。
 */
const healthServer = startMiniAppServer({
  port: config.server.port,
  version: pkg.version,
  logger,
  botToken: config.telegram.botToken,
  allowedTelegramUserId: config.telegram.allowedUserId,
  kanaAudioDir: config.kana.audioDir,
  handlers: {
    progress: async (telegramUserId) => {
      const learnerId = await findLearnerId(db, telegramUserId);
      if (learnerId === undefined) return null;
      return loadProgress(db, learnerId, new Date(), config.session.userTimezone);
    },
    errors: async (telegramUserId) => {
      const learnerId = await findLearnerId(db, telegramUserId);
      if (learnerId === undefined) return [];
      return loadErrors(db, learnerId, 50);
    },
    kana: async (telegramUserId) => {
      const learnerId = await findLearnerId(db, telegramUserId);
      if (learnerId === undefined) return [];
      return loadKanaTable(db, learnerId, new Date());
    },
    practice: async (telegramUserId, key) => {
      const learnerId = await findLearnerId(db, telegramUserId);
      if (learnerId === undefined) return { ok: false };
      const ok = await markDueNow(db, learnerId, key, new Date());
      return { ok };
    },
    reading: async (telegramUserId, level) => {
      const learnerId = await findLearnerId(db, telegramUserId);
      if (learnerId === undefined) return null;
      return loadReading(db, learnerId, {
        optionCount: config.kana.optionCount,
        random: Math.random,
        level:
          level === 'UNKNOWN' || level === 'NONE' || level === 'ALL'
            ? level
            : 'ALL',
      });
    },
    readingAnswer: (_telegramUserId, targetId, chosenId) =>
      // 採点は文の対だけで決まるので DB を読まない。
      Promise.resolve(judgeReading(targetId, chosenId)),
    calendar: async (telegramUserId) => {
      const learnerId = await findLearnerId(db, telegramUserId);
      if (learnerId === undefined) return [];
      return loadCalendar(
        db,
        learnerId,
        new Date(),
        config.session.userTimezone,
        28,
      );
    },
  },
});

onShutdown(() => {
  dailyReminder.stop();
});
onShutdown(() => bot.stop());
onShutdown(
  () =>
    new Promise<void>((resolve) => {
      healthServer.close(() => {
        resolve();
      });
    }),
);
onShutdown(closeDb);

async function main(): Promise<void> {
  const { dbRoundTripMs } = await runStartupChecks();
  logger.info('startup checks passed', {
    dbRoundTripMs,
    sttProvider: stt.name,
    sttModel: stt.model,
    ttsProvider: tts.name,
    ttsModel: tts.model,
  });
  logger.info('masago started', { version: pkg.version });
  dailyReminder.start();
  await publishCommandList(bot, logger);
  await publishMenuButton(bot, logger, config.server.miniAppUrl);
  await startWithRetry(bot, {
    logger,
    onStart: (username) => {
      logger.info('telegram bot connected', { username });
    },
  });
}

void main().catch((error: unknown) => {
  logger.error('startup failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
