import { sql } from 'drizzle-orm';
import { InputFile } from 'grammy';
import { createAnthropicClient, createMinimalTutor } from './agent/index.js';
import { config } from './config/index.js';
import { createCorrectionTurnHooks } from './corrections/index.js';
import { closeDb, db, telegramUpdatesRepo } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { createKnowledgeKeyStore } from './db/repositories/knowledgeItems.js';
import { createKanaCommands } from './learning/kanaCommands.js';
import { ensureKanaSeeded } from './learning/kanaSeed.js';
import { ensureVocabSeeded } from './learning/vocabSeed.js';
import * as ttsCacheRepo from './db/repositories/ttsCache.js';
import { speak } from './speech/voiceCache.js';
import { collectReminderFacts } from './learning/reminderFacts.js';
import { createDailyReminder } from './scheduler/index.js';
import { partsInZone, zonedWallClockToInstant } from './scheduler/index.js';
import { createLogger, startHealthServer } from './observability/index.js';
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
import { createBot, startWithRetry, type AppContext } from './telegram/index.js';
import { createVoiceDownloader } from './telegram/voice.js';
import { createRecorder, recordUsage } from './usage/index.js';
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

const tutor: Tutor = createMinimalTutor({
  client: createAnthropicClient({
    apiKey: config.llm.apiKey,
    baseUrl: config.llm.baseUrl,
  }),
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

const orchestratorDeps = {
  config,
  executor: db,
  logger,
  tutor,
  corrections,
  voice,
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

const healthServer = startHealthServer({
  port: config.server.port,
  version: pkg.version,
  logger,
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
