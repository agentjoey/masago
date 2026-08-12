import { defineConfig } from 'drizzle-kit';

if (!process.env['DATABASE_URL_DIRECT']) {
  process.loadEnvFile();
}

const url = process.env['DATABASE_URL_DIRECT'];
if (!url) {
  throw new Error('DATABASE_URL_DIRECT is required for drizzle-kit');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dbCredentials: { url },
});
