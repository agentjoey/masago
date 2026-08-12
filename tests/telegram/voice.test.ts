import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  containerFromMimeType,
  createVoiceDownloader,
  VoiceDownloadError,
  VoiceValidationError,
  type VoiceFetch,
} from '../../src/telegram/voice.js';

const TOKEN = 'ci-secret-token-123';
const LIMITS = { maxSizeMb: 1, maxDurationSeconds: 120 };
const MAX_BYTES = LIMITS.maxSizeMb * 1024 * 1024;

function fakeApi(overrides: { file_path?: string; file_size?: number; failure?: Error } = {}) {
  const getFile = vi.fn(async (fileId: string) => {
    void fileId;
    if (overrides.failure !== undefined) {
      throw overrides.failure;
    }
    return {
      file_path: overrides.file_path ?? 'voice/file_1.oga',
      file_size: overrides.file_size,
    };
  });
  return { getFile };
}

function fakeFetch(options: { bytes?: Uint8Array; status?: number; failure?: Error } = {}) {
  const bytes = options.bytes ?? new Uint8Array([1, 2, 3, 4]);
  const fetchImpl: VoiceFetch = vi.fn(async (url: string) => {
    void url;
    if (options.failure !== undefined) {
      throw options.failure;
    }
    const status = options.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      arrayBuffer: () =>
        Promise.resolve(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        ),
    };
  });
  return fetchImpl;
}

describe('containerFromMimeType', () => {
  it('maps known mime types to containers', () => {
    expect(containerFromMimeType('audio/ogg')).toBe('ogg');
    expect(containerFromMimeType('audio/mpeg')).toBe('mp3');
    expect(containerFromMimeType('audio/webm')).toBe('webm');
  });

  it('strips mime parameters and ignores case', () => {
    expect(containerFromMimeType('Audio/OGG; codecs=opus')).toBe('ogg');
  });

  it('defaults to ogg when mime type is missing', () => {
    expect(containerFromMimeType(undefined)).toBe('ogg');
  });

  it('rejects unknown mime types with an identifiable error', () => {
    expect(() => containerFromMimeType('video/mp4')).toThrow(VoiceValidationError);
    try {
      containerFromMimeType('application/pdf');
    } catch (error) {
      expect(error).toBeInstanceOf(VoiceValidationError);
      expect((error as VoiceValidationError).reason).toBe('mime');
    }
  });
});

describe('createVoiceDownloader', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'jp-coach-voice-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('downloads to destPath and reports bytes and container from mime type', async () => {
    const api = fakeApi();
    const fetchImpl = fakeFetch({ bytes: new Uint8Array([9, 8, 7]) });
    const downloader = createVoiceDownloader(
      { api, token: TOKEN, limits: LIMITS, fetchImpl },
      { mimeType: 'audio/ogg', fileSize: 3, durationSeconds: 5 },
    );

    const dest = join(dir, 'input.oga');
    const result = await downloader.download('file-id-1', dest);

    expect(result).toEqual({ bytes: 3, container: 'ogg' });
    expect(new Uint8Array(await readFile(dest))).toEqual(new Uint8Array([9, 8, 7]));
    expect(api.getFile).toHaveBeenCalledWith('file-id-1');
    const url = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(url).toContain('voice/file_1.oga');
  });

  it('rejects oversize files from message metadata before any network call', async () => {
    const api = fakeApi();
    const fetchImpl = fakeFetch();
    const downloader = createVoiceDownloader(
      { api, token: TOKEN, limits: LIMITS, fetchImpl },
      { mimeType: 'audio/ogg', fileSize: MAX_BYTES + 1 },
    );

    const error = await downloader.download('f', join(dir, 'x.oga')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VoiceValidationError);
    expect((error as VoiceValidationError).reason).toBe('size');
    expect(api.getFile).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects over-duration voice before any network call', async () => {
    const api = fakeApi();
    const fetchImpl = fakeFetch();
    const downloader = createVoiceDownloader(
      { api, token: TOKEN, limits: LIMITS, fetchImpl },
      { mimeType: 'audio/ogg', durationSeconds: LIMITS.maxDurationSeconds + 1 },
    );

    const error = await downloader.download('f', join(dir, 'x.oga')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VoiceValidationError);
    expect((error as VoiceValidationError).reason).toBe('duration');
    expect(api.getFile).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects unsupported mime before any network call', async () => {
    const api = fakeApi();
    const fetchImpl = fakeFetch();
    const downloader = createVoiceDownloader(
      { api, token: TOKEN, limits: LIMITS, fetchImpl },
      { mimeType: 'image/png' },
    );

    const error = await downloader.download('f', join(dir, 'x.oga')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VoiceValidationError);
    expect((error as VoiceValidationError).reason).toBe('mime');
    expect(api.getFile).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects when getFile reports an oversize file, before downloading', async () => {
    const api = fakeApi({ file_size: MAX_BYTES + 1 });
    const fetchImpl = fakeFetch();
    const downloader = createVoiceDownloader(
      { api, token: TOKEN, limits: LIMITS, fetchImpl },
      { mimeType: 'audio/ogg' },
    );

    const error = await downloader.download('f', join(dir, 'x.oga')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VoiceValidationError);
    expect((error as VoiceValidationError).reason).toBe('size');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects when the downloaded payload exceeds the size limit', async () => {
    const api = fakeApi();
    const fetchImpl = fakeFetch({ bytes: new Uint8Array(MAX_BYTES + 1) });
    const downloader = createVoiceDownloader(
      { api, token: TOKEN, limits: LIMITS, fetchImpl },
      { mimeType: 'audio/ogg' },
    );

    const error = await downloader.download('f', join(dir, 'x.oga')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VoiceValidationError);
    expect((error as VoiceValidationError).reason).toBe('size');
  });

  it('surfaces HTTP failures with status only, never the token', async () => {
    const api = fakeApi();
    const fetchImpl = fakeFetch({ status: 500 });
    const downloader = createVoiceDownloader(
      { api, token: TOKEN, limits: LIMITS, fetchImpl },
      { mimeType: 'audio/ogg' },
    );

    const error = await downloader.download('f', join(dir, 'x.oga')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VoiceDownloadError);
    expect((error as VoiceDownloadError).status).toBe(500);
    expect((error as Error).message).toContain('500');
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it('never leaks the bot token into error messages on any failure path', async () => {
    const scenarios: Array<() => Promise<unknown>> = [
      () =>
        createVoiceDownloader(
          { api: fakeApi({ failure: new Error(`upstream ${TOKEN}`) }), token: TOKEN, limits: LIMITS, fetchImpl: fakeFetch() },
          { mimeType: 'audio/ogg' },
        ).download('f', join(dir, 'a.oga')),
      () =>
        createVoiceDownloader(
          { api: fakeApi(), token: TOKEN, limits: LIMITS, fetchImpl: fakeFetch({ failure: new Error('conn reset') }) },
          { mimeType: 'audio/ogg' },
        ).download('f', join(dir, 'b.oga')),
      () =>
        createVoiceDownloader(
          { api: fakeApi({ file_path: '' }), token: TOKEN, limits: LIMITS, fetchImpl: fakeFetch() },
          { mimeType: 'audio/ogg' },
        ).download('f', join(dir, 'c.oga')),
    ];

    for (const run of scenarios) {
      const error = await run().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(TOKEN);
    }
  });
});
