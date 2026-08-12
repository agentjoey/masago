import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/speech/ffmpeg.js', () => ({
  runFfmpeg: vi.fn(async () => ({ stdout: '', stderr: '' })),
  isFfmpegAvailable: vi.fn(async () => false),
}));

import { runFfmpeg } from '../../src/speech/ffmpeg.js';
import {
  buildRemuxArgs,
  normalizeForStt,
  UnsupportedAudioFormatError,
} from '../../src/speech/normalizer.js';
import { MOCK_STT_SUPPORTED_INPUT_FORMATS } from '../../src/speech/stt/mock.js';

const runFfmpegMock = vi.mocked(runFfmpeg);

const OPENAI_FORMATS = MOCK_STT_SUPPORTED_INPUT_FORMATS;

beforeEach(() => {
  runFfmpegMock.mockClear();
});

describe('buildRemuxArgs', () => {
  it('uses -c:a copy and never re-encodes', () => {
    const args = buildRemuxArgs('/tmp/t/input.oga', '/tmp/t/input.webm', 'webm');
    expect(args).toEqual([
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      '/tmp/t/input.oga',
      '-c:a',
      'copy',
      '-f',
      'webm',
      '/tmp/t/input.webm',
    ]);
    const codecIndex = args.indexOf('-c:a');
    expect(args[codecIndex + 1]).toBe('copy');
    const joined = args.join(' ');
    expect(joined).not.toMatch(/libmp3lame|libopus|libvorbis|aac|-b:a|-ar|-ac\s/);
  });
});

describe('normalizeForStt', () => {
  it('returns the input untouched when the container is already supported', async () => {
    const result = await normalizeForStt(
      { path: '/tmp/ws/input.webm', container: 'webm' },
      OPENAI_FORMATS,
    );
    expect(result.path).toBe('/tmp/ws/input.webm');
    expect(result.container).toBe('webm');
    expect(result.transcoded).toBe(false);
    expect(runFfmpegMock).not.toHaveBeenCalled();
  });

  it('normalizes container spelling before matching', async () => {
    const result = await normalizeForStt(
      { path: '/tmp/ws/input.WEBM', container: ' .WEBM ' },
      OPENAI_FORMATS,
    );
    expect(result.path).toBe('/tmp/ws/input.WEBM');
    expect(result.transcoded).toBe(false);
    expect(runFfmpegMock).not.toHaveBeenCalled();
  });

  it('remuxes ogg to webm with -c:a copy when ogg is unsupported', async () => {
    const result = await normalizeForStt(
      { path: '/tmp/ws/input.oga', container: 'ogg' },
      OPENAI_FORMATS,
    );
    expect(runFfmpegMock).toHaveBeenCalledTimes(1);
    const args = runFfmpegMock.mock.calls[0]?.[0] ?? [];
    expect(args).toContain('-c:a');
    expect(args[args.indexOf('-c:a') + 1]).toBe('copy');
    expect(args).toContain('-f');
    expect(args[args.indexOf('-f') + 1]).toBe('webm');
    expect(args.join(' ')).not.toMatch(/libmp3lame|libopus|libvorbis|aac|-b:a/);
    expect(result).toMatchObject({
      path: '/tmp/ws/input.webm',
      container: 'webm',
      codec: 'opus',
      transcoded: false,
    });
  });

  it('honours an explicit output path', async () => {
    const result = await normalizeForStt(
      { path: '/tmp/ws/input.ogg', container: 'ogg' },
      OPENAI_FORMATS,
      { outputPath: '/tmp/ws/custom.webm' },
    );
    expect(result.path).toBe('/tmp/ws/custom.webm');
  });

  it('passes ogg through untouched when the provider supports it', async () => {
    const result = await normalizeForStt(
      { path: '/tmp/ws/input.oga', container: 'ogg' },
      ['ogg', 'opus'],
    );
    expect(result.path).toBe('/tmp/ws/input.oga');
    expect(result.container).toBe('ogg');
    expect(result.transcoded).toBe(false);
    expect(runFfmpegMock).not.toHaveBeenCalled();
  });

  it('throws instead of transcoding when no remux-compatible target exists', async () => {
    await expect(
      normalizeForStt({ path: '/tmp/ws/input.oga', container: 'ogg' }, ['mp3', 'wav']),
    ).rejects.toBeInstanceOf(UnsupportedAudioFormatError);
    expect(runFfmpegMock).not.toHaveBeenCalled();
  });

  it('throws for containers that cannot be remuxed losslessly', async () => {
    await expect(
      normalizeForStt({ path: '/tmp/ws/input.aac', container: 'aac' }, OPENAI_FORMATS),
    ).rejects.toBeInstanceOf(UnsupportedAudioFormatError);
    expect(runFfmpegMock).not.toHaveBeenCalled();
  });
});
