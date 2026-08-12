import { basename, dirname, join } from 'node:path';
import { runFfmpeg } from './ffmpeg.js';
import type { AudioFileRef } from './types.js';
import { canonicalContainer } from './types.js';

export interface NormalizedAudio {
  path: string;
  container: string;
  codec: string;
  transcoded: boolean;
  durationMs?: number;
}

export class UnsupportedAudioFormatError extends Error {
  readonly container: string;

  constructor(container: string, detail: string) {
    super(`unsupported audio container "${container}": ${detail}`);
    this.name = 'UnsupportedAudioFormatError';
    this.container = container;
  }
}

const REMUXABLE_OPUS_CONTAINERS = new Set(['ogg', 'oga', 'opus']);

export interface NormalizeOptions {
  outputPath?: string;
}

export function buildRemuxArgs(
  inputPath: string,
  outputPath: string,
  targetContainer: string,
): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    inputPath,
    '-c:a',
    'copy',
    '-f',
    targetContainer,
    outputPath,
  ];
}

function deriveOutputPath(inputPath: string, targetContainer: string): string {
  const base = basename(inputPath);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return join(dirname(inputPath), `${stem}.${targetContainer}`);
}

function pickRemuxTarget(supported: readonly string[]): string {
  const canonical = supported.map(canonicalContainer);
  if (canonical.includes('webm')) {
    return 'webm';
  }
  throw new UnsupportedAudioFormatError(
    'ogg',
    `no remux-compatible target found in supportedInputFormats [${supported.join(', ')}]`,
  );
}

export async function normalizeForStt(
  input: AudioFileRef,
  supportedInputFormats: readonly string[],
  options?: NormalizeOptions,
): Promise<NormalizedAudio> {
  const container = canonicalContainer(input.container);
  const supported = supportedInputFormats.map(canonicalContainer);

  if (supported.includes(container)) {
    return {
      path: input.path,
      container,
      codec: 'unknown',
      transcoded: false,
    };
  }

  if (!REMUXABLE_OPUS_CONTAINERS.has(container)) {
    throw new UnsupportedAudioFormatError(
      container,
      'container is not supported by the provider and is not remuxable without re-encoding; refusing to transcode',
    );
  }

  const target = pickRemuxTarget(supportedInputFormats);
  const outputPath =
    options?.outputPath ?? deriveOutputPath(input.path, target);
  await runFfmpeg(buildRemuxArgs(input.path, outputPath, target));
  return {
    path: outputPath,
    container: target,
    codec: 'opus',
    transcoded: false,
  };
}
