export type { Logger } from './logger.js';
export { createLogger } from './logger.js';
export { redact } from './redact.js';
export { getCorrelationId, withCorrelationId } from './correlation.js';

import { createLogger } from './logger.js';
import type { Logger } from './logger.js';

export const logger: Logger = createLogger({
  level: process.env['LOG_LEVEL'] ?? 'info',
});
