import { ConfigError, parseConfig } from './schema.js';
import type { AppConfig } from './schema.js';

export type { AppConfig } from './schema.js';
export { ConfigError, parseConfig } from './schema.js';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function loadConfig(): AppConfig {
  try {
    return parseConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write('Invalid configuration:\n');
      for (const issue of error.issues) {
        process.stderr.write(`  ${issue.field}: ${issue.message}\n`);
      }
      process.exit(1);
    }
    throw error;
  }
}

export const config: AppConfig = deepFreeze(loadConfig());
