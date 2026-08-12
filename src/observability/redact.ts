const SENSITIVE_KEY_PATTERN =
  /token|key|secret|password|authorization|connection_?string|database_?url/i;

const MAX_STRING_LENGTH = 200;
const MAX_DEPTH = 32;
const TRUNCATED_SUFFIX = '…(truncated)';
const REDACTED = '<redacted>';
const CIRCULAR = '<circular>';
const MAX_DEPTH_PLACEHOLDER = '<max-depth>';
const FUNCTION_PLACEHOLDER = '<function>';

export function redact(value: unknown): unknown {
  return redactValue(value, undefined, new WeakSet<object>(), 0);
}

function redactValue(
  value: unknown,
  key: string | undefined,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (key !== undefined && SENSITIVE_KEY_PATTERN.test(key)) {
    return REDACTED;
  }
  if (typeof value === 'function') {
    return FUNCTION_PLACEHOLDER;
  }
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH
      ? value.slice(0, MAX_STRING_LENGTH) + TRUNCATED_SUFFIX
      : value;
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) {
      return MAX_DEPTH_PLACEHOLDER;
    }
    if (seen.has(value)) {
      return CIRCULAR;
    }
    seen.add(value);
    try {
      return value.map((item) => redactValue(item, undefined, seen, depth + 1));
    } finally {
      seen.delete(value);
    }
  }
  if (value !== null && typeof value === 'object') {
    if (depth >= MAX_DEPTH) {
      return MAX_DEPTH_PLACEHOLDER;
    }
    return redactObject(value, seen, depth);
  }
  return value;
}

function redactObject(
  value: object,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (value instanceof Date) {
    return value;
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return `<binary:${value.byteLength} bytes>`;
  }
  if (seen.has(value)) {
    return CIRCULAR;
  }
  seen.add(value);
  try {
    if (value instanceof Map) {
      return redactMap(value, seen, depth);
    }
    if (value instanceof Set) {
      return [...value].map((item) =>
        redactValue(item, undefined, seen, depth + 1),
      );
    }
    if (value instanceof Error) {
      return redactError(value, seen, depth);
    }
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      result[childKey] = redactValue(childValue, childKey, seen, depth + 1);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function redactMap(
  value: Map<unknown, unknown>,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  const entries = [...value.entries()];
  if (entries.every(([entryKey]) => typeof entryKey === 'string')) {
    const result: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of entries) {
      const stringKey = entryKey as string;
      result[stringKey] = redactValue(entryValue, stringKey, seen, depth + 1);
    }
    return result;
  }
  return entries.map(([entryKey, entryValue]) => [
    redactValue(entryKey, undefined, seen, depth + 1),
    redactValue(entryValue, undefined, seen, depth + 1),
  ]);
}

function redactError(
  value: Error,
  seen: WeakSet<object>,
  depth: number,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    name: value.name,
    message: redactValue(value.message, undefined, seen, depth + 1),
  };
  if (value.stack !== undefined) {
    result['stack'] = redactValue(value.stack, undefined, seen, depth + 1);
  }
  if ('cause' in value) {
    result['cause'] = redactValue(
      (value as { cause?: unknown }).cause,
      'cause',
      seen,
      depth + 1,
    );
  }
  for (const [childKey, childValue] of Object.entries(value)) {
    if (childKey === 'cause') {
      continue;
    }
    result[childKey] = redactValue(childValue, childKey, seen, depth + 1);
  }
  return result;
}
