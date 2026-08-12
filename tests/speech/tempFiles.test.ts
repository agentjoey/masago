import { mkdtemp, mkdir, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  cleanupStaleWorkspaces,
  createTurnWorkspace,
  withTurnWorkspace,
} from '../../src/speech/tempFiles.js';

const baseDir = await mkdtemp(join(tmpdir(), 'speech-tempfiles-test-'));

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

afterAll(async () => {
  const { rm } = await import('node:fs/promises');
  await rm(baseDir, { recursive: true, force: true });
});

describe('createTurnWorkspace', () => {
  it('creates an unguessable turn directory with mode 0700', async () => {
    const ws = await createTurnWorkspace({ baseDir });
    expect(ws.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(ws.dir).toBe(join(baseDir, ws.id));
    expect(await modeOf(ws.dir)).toBe(0o700);
    const other = await createTurnWorkspace({ baseDir });
    expect(other.id).not.toBe(ws.id);
    await ws.dispose();
    await other.dispose();
  });

  it('writes files with mode 0600', async () => {
    const ws = await createTurnWorkspace({ baseDir });
    const filePath = await ws.writeFile('input.oga', 'payload');
    expect(await modeOf(filePath)).toBe(0o600);
    await ws.dispose();
  });

  it('rejects unsafe file names', async () => {
    const ws = await createTurnWorkspace({ baseDir });
    expect(() => ws.path('../escape')).toThrow();
    expect(() => ws.path('a/b')).toThrow();
    expect(() => ws.path('')).toThrow();
    await ws.dispose();
  });
});

describe('dispose', () => {
  it('is idempotent and removes the directory', async () => {
    const ws = await createTurnWorkspace({ baseDir });
    await ws.writeFile('input.oga', 'payload');
    await ws.dispose();
    await ws.dispose();
    await expect(stat(ws.dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('withTurnWorkspace', () => {
  it('cleans up when the callback succeeds', async () => {
    let captured = '';
    await withTurnWorkspace(async (ws) => {
      captured = ws.dir;
      expect((await stat(ws.dir)).isDirectory()).toBe(true);
    }, { baseDir });
    await expect(stat(captured)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleans up when the callback throws', async () => {
    let captured = '';
    await expect(
      withTurnWorkspace(async (ws) => {
        captured = ws.dir;
        throw new Error('boom');
      }, { baseDir }),
    ).rejects.toThrow('boom');
    await expect(stat(captured)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('cleanupStaleWorkspaces', () => {
  it('removes only directories older than maxAgeMs', async () => {
    const staleDir = join(baseDir, '00000000-0000-0000-0000-000000000001');
    const freshDir = join(baseDir, '00000000-0000-0000-0000-000000000002');
    await mkdir(staleDir, { mode: 0o700 });
    await mkdir(freshDir, { mode: 0o700 });
    await writeFile(join(staleDir, 'input.oga'), 'old', { mode: 0o600 });
    const past = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(staleDir, past, past);

    const removed = await cleanupStaleWorkspaces(30 * 60 * 1000, { baseDir });
    expect(removed).toContain(staleDir);
    expect(removed).not.toContain(freshDir);
    await expect(stat(staleDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(freshDir)).isDirectory()).toBe(true);
  });

  it('returns an empty list when the base directory does not exist', async () => {
    const removed = await cleanupStaleWorkspaces(1000, {
      baseDir: join(baseDir, 'does-not-exist'),
    });
    expect(removed).toEqual([]);
  });

  it('does not treat fresh turn workspaces as stale', async () => {
    const ws = await createTurnWorkspace({ baseDir });
    const removed = await cleanupStaleWorkspaces(30 * 60 * 1000, { baseDir });
    expect(removed).not.toContain(ws.dir);
    expect((await readdir(baseDir)).length).toBeGreaterThan(0);
    await ws.dispose();
  });
});
