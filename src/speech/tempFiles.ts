import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_BASE_DIR = join(tmpdir(), 'masago');

export interface TempFileOptions {
  baseDir?: string;
}

function resolveBaseDir(options?: TempFileOptions): string {
  return options?.baseDir ?? DEFAULT_BASE_DIR;
}

export interface Workspace {
  readonly id: string;
  readonly dir: string;
  path(name: string): string;
  writeFile(name: string, data: string | Buffer): Promise<string>;
  dispose(): Promise<void>;
}

function assertSafeName(name: string): void {
  if (
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  ) {
    throw new Error(`unsafe workspace file name: ${JSON.stringify(name)}`);
  }
}

export async function createTurnWorkspace(
  options?: TempFileOptions,
): Promise<Workspace> {
  const baseDir = resolveBaseDir(options);
  await mkdir(baseDir, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const dir = join(baseDir, id);
  await mkdir(dir, { mode: 0o700 });

  let disposed = false;

  return {
    id,
    dir,
    path(name: string): string {
      assertSafeName(name);
      return join(dir, name);
    },
    async writeFile(name: string, data: string | Buffer): Promise<string> {
      assertSafeName(name);
      const filePath = join(dir, name);
      await writeFile(filePath, data, { mode: 0o600 });
      return filePath;
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function withTurnWorkspace<T>(
  fn: (workspace: Workspace) => Promise<T>,
  options?: TempFileOptions,
): Promise<T> {
  const workspace = await createTurnWorkspace(options);
  try {
    return await fn(workspace);
  } finally {
    await workspace.dispose();
  }
}

export async function cleanupStaleWorkspaces(
  maxAgeMs: number,
  options?: TempFileOptions,
): Promise<string[]> {
  const baseDir = resolveBaseDir(options);
  let entries;
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }
  const cutoff = Date.now() - maxAgeMs;
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(baseDir, entry.name);
    const info = await stat(dir);
    if (info.mtimeMs <= cutoff) {
      await rm(dir, { recursive: true, force: true });
      removed.push(dir);
    }
  }
  return removed;
}
