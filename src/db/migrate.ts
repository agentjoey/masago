import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

/**
 * 起動時にマイグレーションを当てる。
 *
 * これが無いと、新しい列を使うコードだけが先に本番へ出る——手で当て忘れた
 * その一回で、機能ごと落ちる。「忘れないようにする」で防げる類ではない。
 *
 * **プール接続ではなく直結を使う。** Neon のプーラ経由では DDL が
 * 通らないことがある。マイグレーションは起動時の一度きりなので、
 * ここだけ別に繋いですぐ閉じる。
 *
 * 単一インスタンス前提（§10 の numReplicas=1）。drizzle は適用済みを
 * 記録するので、再起動で二度当たることはない。
 */
export interface MigrateOptions {
  readonly directUrl: string;
  readonly connectionTimeoutMs: number;
}

/** ビルド後は dist/src/db/、開発時は src/db/ から見た移行ファイルの場所。 */
export function migrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const local = join(here, 'migrations');
  if (existsSync(local)) return local;
  // tsc は .sql を出力に含めない。ビルド後はリポジトリ側を指す。
  return join(process.cwd(), 'src', 'db', 'migrations');
}

export async function runMigrations(options: MigrateOptions): Promise<void> {
  const pool = new Pool({
    connectionString: options.directUrl,
    max: 1,
    connectionTimeoutMillis: options.connectionTimeoutMs,
  });
  try {
    await migrate(drizzle(pool), {
      migrationsFolder: migrationsFolder(),
    });
  } finally {
    await pool.end();
  }
}
