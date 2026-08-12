import { writeFile } from 'node:fs/promises';
import type {
  VoiceDownloader,
  VoiceFileApi,
  VoiceFileMeta,
} from '../sessions/voiceTurn.js';

export type {
  VoiceDownloader,
  VoiceFileApi,
  VoiceFileMeta,
} from '../sessions/voiceTurn.js';

export type VoiceValidationReason = 'mime' | 'size' | 'duration';

export class VoiceValidationError extends Error {
  readonly reason: VoiceValidationReason;

  constructor(reason: VoiceValidationReason, message: string) {
    super(message);
    this.name = 'VoiceValidationError';
    this.reason = reason;
  }
}

export class VoiceDownloadError extends Error {
  readonly status?: number;

  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(message);
    this.name = 'VoiceDownloadError';
    this.status = options?.status;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export interface VoiceDownloadResponse {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type VoiceFetch = (url: string) => Promise<VoiceDownloadResponse>;

export interface VoiceDownloadLimits {
  maxSizeMb: number;
  maxDurationSeconds: number;
}

export interface CreateVoiceDownloaderDeps {
  api: VoiceFileApi;
  token: string;
  limits: VoiceDownloadLimits;
  fetchImpl?: VoiceFetch;
}

const MIME_CONTAINER: Readonly<Record<string, string>> = {
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
};

export function containerFromMimeType(mimeType: string | undefined): string {
  if (mimeType === undefined) {
    return 'ogg';
  }
  const base = mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const container = MIME_CONTAINER[base];
  if (container === undefined) {
    throw new VoiceValidationError(
      'mime',
      `unsupported voice mime type: ${base}`,
    );
  }
  return container;
}

export function createVoiceDownloader(
  deps: CreateVoiceDownloaderDeps,
  meta: VoiceFileMeta,
): VoiceDownloader {
  const maxBytes = deps.limits.maxSizeMb * 1024 * 1024;

  return {
    async download(fileId, destPath) {
      const container = containerFromMimeType(meta.mimeType);
      if (meta.fileSize !== undefined && meta.fileSize > maxBytes) {
        throw new VoiceValidationError(
          'size',
          `voice file size exceeds ${String(deps.limits.maxSizeMb)}MB limit`,
        );
      }
      if (
        meta.durationSeconds !== undefined &&
        meta.durationSeconds > deps.limits.maxDurationSeconds
      ) {
        throw new VoiceValidationError(
          'duration',
          `voice duration exceeds ${String(deps.limits.maxDurationSeconds)}s limit`,
        );
      }

      let file;
      try {
        file = await deps.api.getFile(fileId);
      } catch (cause) {
        throw new VoiceDownloadError('failed to resolve telegram file', {
          cause,
        });
      }
      if (file.file_size !== undefined && file.file_size > maxBytes) {
        throw new VoiceValidationError(
          'size',
          `voice file size exceeds ${String(deps.limits.maxSizeMb)}MB limit`,
        );
      }
      if (file.file_path === undefined || file.file_path === '') {
        throw new VoiceDownloadError('telegram file has no download path');
      }

      const url = `https://api.telegram.org/file/bot${deps.token}/${file.file_path}`;
      const fetchImpl = deps.fetchImpl ?? fetch;
      let response;
      try {
        response = await fetchImpl(url);
      } catch (cause) {
        throw new VoiceDownloadError('voice download request failed', {
          cause,
        });
      }
      if (!response.ok) {
        throw new VoiceDownloadError(
          `voice download failed with HTTP status ${String(response.status)}`,
          { status: response.status },
        );
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > maxBytes) {
        throw new VoiceValidationError(
          'size',
          `voice file size exceeds ${String(deps.limits.maxSizeMb)}MB limit`,
        );
      }
      await writeFile(destPath, buffer, { mode: 0o600 });
      return { bytes: buffer.byteLength, container };
    },
  };
}
