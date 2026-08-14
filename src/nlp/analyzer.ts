import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '../observability/index.js';
import type { WorkerRequest, WorkerResponse } from './worker.js';

/**
 * 形態素解析の窓口。子プロセスの生き死にをここで面倒みる。
 *
 * 使う時だけ起こし、しばらく使わなければ落とす。辞書が 400MB あるので、
 * 常駐させると本体の 4 倍になる（§8 / worker.ts の注記）。
 */

export interface Token {
  readonly surface: string;
  /** 品詞（名詞・動詞・助詞…）。 */
  readonly pos: string;
  readonly posDetail: string;
  /** 活用型・活用形。動詞の変形誤りを見るのに使う。 */
  readonly conjugatedType: string;
  readonly conjugatedForm: string;
  /** 終止形。「見まし」→「見る」。 */
  readonly basicForm: string;
  /** 片仮名の読み。振り仮名に使う（V3）。 */
  readonly reading: string | undefined;
}

export interface AnalyzerOptions {
  readonly logger: Logger;
  /** 最後の利用からこの時間が経ったら子プロセスを落とす。 */
  readonly idleMs?: number;
  /** 一回の解析を待つ上限。 */
  readonly timeoutMs?: number;
}

export interface Analyzer {
  tokenize(text: string): Promise<Token[]>;
  /** 起動中なら落とす。終了処理から呼ぶ。 */
  shutdown(): void;
  /** テスト用：いま子プロセスが生きているか。 */
  isRunning(): boolean;
}

function workerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const built = join(here, 'worker.js');
  if (existsSync(built)) return built;
  // 開発時は tsx が .ts を直接読む。
  return join(here, 'worker.ts');
}

const DEFAULT_IDLE_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;

export function createAnalyzer(options: AnalyzerOptions): Analyzer {
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let child: ChildProcess | undefined;
  let ready: Promise<void> | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (tokens: Token[]) => void; reject: (error: Error) => void }
  >();

  function stop(): void {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    if (child !== undefined) {
      child.kill();
      child = undefined;
      ready = undefined;
    }
    // 落とす瞬間に飛んでいた要求は諦める。黙って宙吊りにしない。
    for (const waiter of pending.values()) {
      waiter.reject(new Error('analyzer stopped'));
    }
    pending.clear();
  }

  function touch(): void {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      options.logger.debug('analyzer idle, releasing the dictionary');
      stop();
    }, idleMs);
    idleTimer.unref?.();
  }

  function start(): Promise<void> {
    if (ready !== undefined) return ready;
    ready = new Promise<void>((resolve, reject) => {
      const spawned = fork(workerPath(), [], {
        // dist からも src からも同じ形で動かす。
        execArgv: workerPath().endsWith('.ts') ? ['--import', 'tsx'] : [],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      child = spawned;

      spawned.once('message', () => {
        // 最初の一通は「辞書を読み終えた」の合図。
        resolve();
      });
      spawned.on('message', (message: WorkerResponse) => {
        if (message.id === 0) return;
        const waiter = pending.get(message.id);
        if (waiter === undefined) return;
        pending.delete(message.id);
        if (message.error !== undefined) {
          waiter.reject(new Error(message.error));
        } else {
          waiter.resolve((message.tokens ?? []).map(toToken));
        }
      });
      spawned.on('error', (error) => {
        options.logger.warn('analyzer worker failed', { error });
        reject(error instanceof Error ? error : new Error(String(error)));
        stop();
      });
      spawned.on('exit', (code) => {
        if (code !== null && code !== 0) {
          options.logger.warn('analyzer worker exited', { code });
        }
        // 落ちたら次回また立ち上げ直す。
        child = undefined;
        ready = undefined;
      });
    });
    return ready;
  }

  return {
    async tokenize(text) {
      if (text.trim() === '') return [];
      await start();
      touch();
      const id = nextId;
      nextId += 1;

      return new Promise<Token[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('analyzer timed out'));
        }, timeoutMs);
        timer.unref?.();

        pending.set(id, {
          resolve: (tokens) => {
            clearTimeout(timer);
            resolve(tokens);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        child?.send({ id, text } satisfies WorkerRequest);
      });
    },
    shutdown: stop,
    isRunning: () => child !== undefined,
  };
}

function toToken(raw: {
  surface_form: string;
  pos: string;
  pos_detail_1: string;
  conjugated_type: string;
  conjugated_form: string;
  basic_form: string;
  reading?: string;
}): Token {
  return {
    surface: raw.surface_form,
    pos: raw.pos,
    posDetail: raw.pos_detail_1,
    conjugatedType: raw.conjugated_type,
    conjugatedForm: raw.conjugated_form,
    basicForm: raw.basic_form,
    // 辞書に無い語は読みが付かない。`*` は「不明」の意なので落とす。
    reading:
      raw.reading === undefined || raw.reading === '*' ? undefined : raw.reading,
  };
}
