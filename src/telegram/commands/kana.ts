import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { InlineKeyboard, InputFile, type Bot } from 'grammy';
import type {
  KanaCommands,
  KanaReply,
} from '../../learning/kanaCommands.js';
import { kanaAudioFileName } from '../../learning/kanaCommands.js';
import type { SpokenAudio } from '../../speech/voiceCache.js';
import type { AppContext } from '../bot.js';

/**
 * 仮名コマンドの Telegram 側。
 *
 * ここは翻訳だけ：何を出すかは learning/ が決め、この層は送るだけ。
 * DB も出題ロジックも触らない（INTERFACES.md §1）。
 */

export interface KanaHandlerDeps {
  readonly commands: KanaCommands;
  /** 事前生成した仮名音声の置き場。 */
  readonly audioDir: string;
  /**
   * 単語の読み上げ。仮名は音库で足りるが、単語は数が多いので合成する。
   * 省略すると読み上げは黙って行われない（文字だけで学習は続けられる）。
   */
  readonly speak?: (text: string) => Promise<SpokenAudio>;
  readonly rememberVoice?: (text: string, fileId: string) => Promise<void>;
}

function keyboardOf(reply: KanaReply): InlineKeyboard | undefined {
  if (reply.buttons === undefined || reply.buttons.length === 0) {
    return undefined;
  }
  const keyboard = new InlineKeyboard();
  reply.buttons.forEach((button, index) => {
    keyboard.text(button.label, button.data);
    // 2 列。1 列だと縦に伸びすぎ、4 列だと文字が潰れる。
    if (index % 2 === 1) keyboard.row();
  });
  return keyboard;
}

/**
 * Telegram のメディア説明文の上限。超える本文は吹き出しに載せられない
 * ので、その時だけ文字と音を分けて出す。
 */
const CAPTION_LIMIT = 1024;

/** 音声に載せる付随情報（説明文とボタン）。 */
type Caption = Record<string, unknown>;

/**
 * 合成音を送る。**送れたら true**——呼び出し側は、false のときだけ
 * 文字を別の吹き出しで出し直す。
 */
async function sendSpoken(
  ctx: AppContext,
  text: string,
  deps: KanaHandlerDeps,
  caption: Caption,
): Promise<boolean> {
  if (deps.speak === undefined) return false;
  try {
    const spoken = await deps.speak(text);
    if (spoken.fileId !== undefined) {
      // 送信済みの音声。合成もアップロードもしない。
      await ctx.replyWithVoice(spoken.fileId, caption);
      return true;
    }
    if (spoken.bytes === undefined) return false;
    const sent = await ctx.replyWithVoice(new InputFile(spoken.bytes), caption);
    const fileId = sent.voice?.file_id;
    if (fileId !== undefined) {
      await deps.rememberVoice?.(text, fileId);
    }
    return true;
  } catch (error) {
    ctx.logger.warn('could not speak text', { text, error });
    return false;
  }
}

/** 事前生成した仮名の音。送れたら true。 */
async function sendKanaAudio(
  ctx: AppContext,
  kanaId: string,
  audioDir: string,
  ctxLogger: AppContext['logger'],
  caption: Caption,
): Promise<boolean> {
  const fileName = kanaAudioFileName(kanaId);
  if (fileName === undefined) return false;
  const path = join(audioDir, fileName);
  if (!existsSync(path)) {
    ctxLogger.warn('kana audio missing', { kanaId, path });
    return false;
  }
  // 音库は mp3。sendVoice は元々 OGG/opus 専用で、mp3 を受けるように
  // なったのは後から——実機で確かめるまで通る保証は無い。
  // 発音を聞かせることがこの機能の目的なので、形式で落ちるくらいなら
  // 見た目が音楽プレイヤーになっても音を届ける。
  try {
    await ctx.replyWithVoice(new InputFile(path), caption);
    return true;
  } catch (error) {
    ctxLogger.warn('sendVoice rejected the file, falling back to audio', {
      kanaId,
      error,
    });
    try {
      await ctx.replyWithAudio(new InputFile(path), caption);
      return true;
    } catch (fallbackError) {
      ctxLogger.warn('sendAudio also rejected the file', {
        kanaId,
        error: fallbackError,
      });
      return false;
    }
  }
}

/**
 * 一つの返事は**一つの吹き出し**にする。
 *
 * 音のある返事は、本文をその説明文に、ボタンをその吹き出しに載せる。
 * 字と音が別々の吹き出しに割れていると、読み方を確かめるのに二つを
 * 往復することになるし、履歴も倍の長さになる。
 *
 * **文字は何があっても届ける。** 元々は「先に文字、後から音」にして
 * 音の失敗から本文を守っていた。順序が逆になったぶん、音が送れなかった
 * ときは文字だけを出し直す——ここを外すと、音库の欠けや形式の相性で
 * 講評ごと消える。
 */
export async function send(
  ctx: AppContext,
  replies: readonly KanaReply[],
  deps: KanaHandlerDeps,
): Promise<void> {
  const { audioDir } = deps;
  for (const reply of replies) {
    const keyboard = keyboardOf(reply);
    // 打ち込みで答える問題は ForceReply を付ける。返信にしておけば
    // 「どの問題への答えか」が返信元から辿れて、直前の出題を
    // どこかに覚えておかずに済む。
    const markup =
      keyboard !== undefined
        ? { reply_markup: keyboard }
        : reply.expectsReply === true
          ? { reply_markup: { force_reply: true as const } }
          : {};

    const fits = reply.text.length <= CAPTION_LIMIT;
    const caption: Caption = fits
      ? { caption: reply.text, ...markup }
      : { ...markup };

    let delivered = false;
    if (fits) {
      if (reply.speakText !== undefined) {
        delivered = await sendSpoken(ctx, reply.speakText, deps, caption);
      } else if (reply.audioKanaId !== undefined) {
        delivered = await sendKanaAudio(
          ctx,
          reply.audioKanaId,
          audioDir,
          ctx.logger,
          caption,
        );
      }
    }
    if (delivered) continue;

    await ctx.reply(reply.text, markup);
    // 説明文に載せられない長さだったときだけ、音を別の吹き出しで足す。
    // 音の送信に失敗していた場合はここには来ない（もう諦めている）。
    if (!fits) {
      if (reply.speakText !== undefined) {
        await sendSpoken(ctx, reply.speakText, deps, {});
      } else if (reply.audioKanaId !== undefined) {
        await sendKanaAudio(ctx, reply.audioKanaId, audioDir, ctx.logger, {});
      }
    }
  }
}

/**
 * 何が起きても学習者に一言返す。
 *
 * 既定では例外は bot.catch まで上がってログが残るだけで、送信側からは
 * **何も返ってこない**。コマンドを叩いたのに沈黙するのは、壊れていることすら
 * 分からない壊れ方——チューター側で直したのと同じ問題なので、
 * 学習コマンドの入口にも同じ手当てをする。
 */
const FAILED_REPLY = '刚才没能处理，请再试一次。';

export function registerKanaCommands(
  bot: Bot<AppContext>,
  deps: KanaHandlerDeps,
): void {
  const { commands } = deps;

  const run = (
    handler: (userId: number) => Promise<KanaReply[]>,
  ): ((ctx: AppContext) => Promise<void>) => {
    return async (ctx) => {
      const userId = ctx.from?.id;
      if (userId === undefined) return;
      try {
        await send(ctx, await handler(userId), deps);
      } catch (error) {
        ctx.logger.error('kana command failed', { error });
        await ctx.reply(FAILED_REPLY);
      }
    };
  };

  // Telegram は bot を開いた時点で /start を送る。ここを拾わないと
  // 初対面が「未知命令」になる。
  //
  // payload 付き（`/start kana` など）は Mini App の「続きから」ボタンの
  // 着地点。t.me/<bot>?start=<cmd> の深リンクが既存コマンドに流れる。
  // 未知の payload は普通の /start として扱う——壊れたリンクで沈黙しない。
  const startTargets: Record<string, (userId: number) => Promise<KanaReply[]>> =
    {
      kana: (userId) => commands.drill(userId),
      review: (userId) => commands.review(userId),
      vocab: (userId) => commands.vocab(userId),
      write: (userId) => commands.write(userId),
      read: (userId) => commands.read(userId),
      domain: (userId) => commands.domain(userId),
      today: (userId) => commands.today(userId),
    };
  bot.command('start', (ctx) => {
    const payload = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    const target = startTargets[payload];
    return run(target ?? ((userId) => commands.start(userId)))(ctx);
  });
  bot.command('help', run((userId) => commands.start(userId)));
  bot.command('today', run((userId) => commands.today(userId)));
  bot.command('kana', run((userId) => commands.drill(userId)));
  bot.command('review', run((userId) => commands.review(userId)));
  bot.command('progress', run((userId) => commands.progress(userId)));
  bot.command('vocab', run((userId) => commands.vocab(userId)));
  bot.command('write', run((userId) => commands.write(userId)));
  bot.command('read', run((userId) => commands.read(userId)));
  bot.command('compose', run((userId) => commands.compose(userId)));
  bot.command('domain', run((userId) => commands.domain(userId)));
  bot.command('cost', run((userId) => commands.cost(userId)));
  bot.command('explain', run((userId) => commands.explain(userId)));

  // 分野の選択。採点ではないので別経路——ここを採点側に混ぜると
  // 「答えを選んだ」と誤って解釈される。
  bot.callbackQuery(/^dp:/, async (ctx) => {
    const userId = ctx.from.id;
    await ctx.answerCallbackQuery();
    const domainId = ctx.callbackQuery.data.slice('dp:'.length);
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    } catch (error) {
      ctx.logger.debug('could not clear keyboard', { error });
    }
    try {
      await send(ctx, await commands.domain(userId, domainId), deps);
    } catch (error) {
      ctx.logger.error('domain command failed', { error });
      await ctx.reply(FAILED_REPLY);
    }
  });

  /**
   * 出題への返信を、通常の会話より先に受け取る。
   *
   * 返信元が出題でなければ `answerTyped` は undefined を返すので、
   * その場合は次の middleware（＝チューターとの会話）へ流す。
   * 「今どの問題に答えているか」を保持しないので、途中で会話を
   * 挟まれても取り違えない。
   */
  bot.on('message:text', async (ctx, next) => {
    const replyTo = ctx.message.reply_to_message;
    const questionText = replyTo?.text;
    const userId = ctx.from?.id;
    if (replyTo === undefined || questionText === undefined || userId === undefined) {
      await next();
      return;
    }

    const askedAt = new Date(replyTo.date * 1000);
    let replies;
    try {
      replies = await commands.answerTyped(
        userId,
        questionText,
        ctx.message.text,
        askedAt,
      );
    } catch (error) {
      ctx.logger.error('grading a typed answer failed', { error });
      await ctx.reply(FAILED_REPLY);
      return;
    }
    if (replies === undefined) {
      // 出題への返信ではなかった。通常の会話として次へ流す。
      await next();
      return;
    }
    await send(ctx, replies, deps);
  });

    // 仮名 kq:、単語 vq:、助詞 wp:、読解 rq:、分野 dq:。同じ経路で採点する。
  bot.callbackQuery(/^(kq|vq|wp|rq|dq):/, async (ctx) => {
    const userId = ctx.from.id;
    // 先に応答しないと、Telegram はボタンを押しっぱなしの表示にする。
    await ctx.answerCallbackQuery();

    const message = ctx.callbackQuery.message;
    // date は秒。出題から解答までの時間は評定に使う（§3.2）。
    const askedAt =
      message !== undefined && 'date' in message
        ? new Date(message.date * 1000)
        : undefined;

    // 押された選択肢のキーボードは消す。押し直しで二重採点されるのを防ぐ。
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    } catch (error) {
      ctx.logger.debug('could not clear keyboard', { error });
    }

    try {
      await send(
        ctx,
        await commands.answer(userId, ctx.callbackQuery.data, askedAt),
        deps,
      );
    } catch (error) {
      ctx.logger.error('grading a tapped answer failed', { error });
      await ctx.reply(FAILED_REPLY);
    }
  });
}
