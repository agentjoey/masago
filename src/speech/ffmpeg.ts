import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 30_000;
const STDERR_MAX_LENGTH = 200;
const TRUNCATED_SUFFIX = '…(truncated)';

function truncateStderr(stderr: string): string {
  return stderr.length > STDERR_MAX_LENGTH
    ? stderr.slice(0, STDERR_MAX_LENGTH) + TRUNCATED_SUFFIX
    : stderr;
}

export interface FfmpegErrorOptions {
  exitCode: number | null;
  stderr: string;
}

export class FfmpegError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(message: string, options: FfmpegErrorOptions) {
    super(message);
    this.name = 'FfmpegError';
    this.exitCode = options.exitCode;
    this.stderr = options.stderr;
  }
}

export class FfmpegTimeoutError extends FfmpegError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, args: readonly string[]) {
    super(`ffmpeg timed out after ${timeoutMs}ms: ffmpeg ${args.join(' ')}`, {
      exitCode: null,
      stderr: '',
    });
    this.name = 'FfmpegTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export interface FfmpegRunResult {
  stdout: string;
  stderr: string;
}

export interface RunFfmpegOptions {
  timeoutMs?: number;
}

export function runFfmpeg(
  args: readonly string[],
  options?: RunFfmpegOptions,
): Promise<FfmpegRunResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<FfmpegRunResult>((resolve, reject) => {
    const child = spawn('ffmpeg', [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new FfmpegError(`failed to spawn ffmpeg: ${err.message}`, {
          exitCode: null,
          stderr: '',
        }),
      );
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (timedOut) {
        reject(new FfmpegTimeoutError(timeoutMs, args));
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new FfmpegError(
          `ffmpeg exited with code ${String(code)}: ${truncateStderr(stderr)}`,
          { exitCode: code, stderr: truncateStderr(stderr) },
        ),
      );
    });
  });
}

let availabilityCache: Promise<boolean> | undefined;

async function probeFfmpeg(): Promise<boolean> {
  try {
    await runFfmpeg(['-version'], { timeoutMs: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export function isFfmpegAvailable(): Promise<boolean> {
  availabilityCache ??= probeFfmpeg();
  return availabilityCache;
}
