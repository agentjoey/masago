import { pino } from 'pino';
import type { DestinationStream, Logger as PinoLogger } from 'pino';
import { getCorrelationId } from './correlation.js';
import { redact } from './redact.js';

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface CreateLoggerOptions {
  level: string;
  destination?: DestinationStream;
}

function redactFields(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  return redact(fields ?? {}) as Record<string, unknown>;
}

function wrap(base: PinoLogger): Logger {
  return {
    debug: (msg, fields) => base.debug(redactFields(fields), msg),
    info: (msg, fields) => base.info(redactFields(fields), msg),
    warn: (msg, fields) => base.warn(redactFields(fields), msg),
    error: (msg, fields) => base.error(redactFields(fields), msg),
    child: (bindings) => wrap(base.child(redactFields(bindings))),
  };
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const pinoOptions = {
    level: options.level,
    mixin() {
      const correlationId = getCorrelationId();
      return correlationId === undefined ? {} : { correlationId };
    },
  };
  const base =
    options.destination !== undefined
      ? pino(pinoOptions, options.destination)
      : process.env['NODE_ENV'] === 'production'
        ? pino(pinoOptions)
        : pino({ ...pinoOptions, transport: { target: 'pino-pretty' } });
  return wrap(base);
}
