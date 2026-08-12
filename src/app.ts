import { sql } from 'drizzle-orm';
import { InputFile } from 'grammy';
import { createAnthropicClient, createMinimalTutor } from './agent/index.js';
import { config } from './config/index.js';
import { closeDb, db, telegramUpdatesRepo } from './db/index.js';
import { createLogger } from './observability/index.js';
import {
  createHandleUpdate,
  type IncomingMessageContext,
  type OrchestratorVoiceDeps,
  type OutboundVoice,
  type Tutor,
} from './sessions/index.js';
import { isFfmpegAvailable } from './speech/index.js';
import { createSpeechProviders } from './speech/providerFactory.js';
import { createBot, type AppContext } from './telegram/index.js';
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
  logger.info('jp-coach shutting down', { signal });
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
  client: createAnthropicClient({ apiKey: config.llm.apiKey }),
  model: config.llm.model,
  provider: config.llm.provider,
  promptCacheEnabled: config.llm.promptCacheEnabled,
});

const usageRecorder = createRecorder({ executor: db, logger });

const voice: OrchestratorVoiceDeps = {
  stt,
  tts,
  tutor,
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

const handleMessage = createHandleUpdate({
  config,
  executor: db,
  logger,
  voice,
});

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

async function runStartupChecks(): Promise<void> {
  if (!(await isFfmpegAvailable())) {
    throw new Error('startup check failed: ffmpeg is not available on PATH');
  }
  await db.execute(sql`select 1`);
  for (const warning of keyFormatWarnings()) {
    logger.warn('provider key format looks unusual', { warning });
  }
}

const bot = createBot({
  config,
  logger,
  handleUpdate: (ctx) => handleMessage(adaptContext(ctx)),
  recordUpdate: async (updateId, payload) => {
    const result = await telegramUpdatesRepo.insertIfAbsent(db, updateId, payload);
    return result.inserted;
  },
});

onShutdown(() => bot.stop());
onShutdown(closeDb);

async function main(): Promise<void> {
  await runStartupChecks();
  logger.info('startup checks passed', {
    sttProvider: stt.name,
    sttModel: stt.model,
    ttsProvider: tts.name,
    ttsModel: tts.model,
  });
  logger.info('jp-coach started', { version: pkg.version });
  await bot.start({
    onStart: (me) => {
      logger.info('telegram bot connected', { username: me.username });
    },
  });
}

void main().catch((error: unknown) => {
  logger.error('startup failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
