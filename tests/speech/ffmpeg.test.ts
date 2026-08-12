import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FfmpegError,
  FfmpegTimeoutError,
  isFfmpegAvailable,
  runFfmpeg,
} from '../../src/speech/ffmpeg.js';
import { normalizeForStt } from '../../src/speech/normalizer.js';
import { MOCK_STT_SUPPORTED_INPUT_FORMATS } from '../../src/speech/stt/mock.js';
import { withTurnWorkspace } from '../../src/speech/tempFiles.js';

const HAS_FFMPEG = await isFfmpegAvailable();

describe.skipIf(!HAS_FFMPEG)('ffmpeg (real binary)', () => {
  it('runs ffmpeg -version', async () => {
    const { stdout } = await runFfmpeg(['-version']);
    expect(stdout).toContain('ffmpeg version');
  });

  it('includes stderr in the error on failure', async () => {
    await expect(
      runFfmpeg(['-i', '/nonexistent/input.oga', '-c:a', 'copy', '-f', 'webm', '/tmp/x.webm']),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof FfmpegError && err.stderr.length > 0,
    );
  });

  it('kills the process on timeout with a recognizable error', async () => {
    await expect(
      runFfmpeg(
        ['-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '30', '-f', 'null', '-'],
        { timeoutMs: 300 },
      ),
    ).rejects.toBeInstanceOf(FfmpegTimeoutError);
  }, 10_000);

  it('remuxes a real ogg/opus file to webm without re-encoding', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'speech-ffmpeg-test-'));
    await withTurnWorkspace(async (ws) => {
      const oggPath = ws.path('input.oga');
      await runFfmpeg([
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=1',
        '-c:a',
        'libopus',
        oggPath,
      ]);
      const result = await normalizeForStt(
        { path: oggPath, container: 'ogg' },
        MOCK_STT_SUPPORTED_INPUT_FORMATS,
      );
      expect(result.transcoded).toBe(false);
      expect(result.container).toBe('webm');
      const info = await stat(result.path);
      expect(info.size).toBeGreaterThan(0);
    }, { baseDir });
  }, 30_000);
});
