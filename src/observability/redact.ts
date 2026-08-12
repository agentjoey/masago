const SENSITIVE_KEY_PATTERN =
  /token|key|secret|password|authorization|connection_?string|database_?url/i;

const MAX_STRING_LENGTH = 200;
const TRUNCATED_SUFFIX = '…(truncated)';
const REDACTED = '<redacted>';
const CIRCULAR = '<circular>';
const FUNCTION_PLACEHOLDER = '<function>';

export function redact(value: unknown): unknown {
  return redactValue(value, undefined, new WeakSet<object>());
}

function redactValue(
  value: unknown,
  key: string | undefined,
  seen: WeakSet<object>,
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
    if (seen.has(value)) {
      return CIRCULAR;
    }
    seen.add(value);
    try {
      return value.map((item) => redactValue(item, undefined, seen));
    } finally {
      seen.delete(value);
    }
  }
  if (value !== null && typeof value === 'object') {
    return redactObject(value, seen);
  }
  return value;
}

function redactObject(value: object, seen: WeakSet<object>): unknown {
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
      return redactMap(value, seen);
    }
    if (value instanceof Set) {
      return [...value].map((item) => redactValue(item, undefined, seen));
    }
    if (value instanceof Error) {
      return redactError(value, seen);
    }
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      result[childKey] = redactValue(childValue, childKey, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function redactMap(value: Map<unknown, unknown>, seen: WeakSet<object>): unknown {
  const entries = [...value.entries()];
  if (entries.every(([entryKey]) => typeof entryKey === 'string')) {
    const result: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of entries) {
      const stringKey = entryKey as string;
      result[stringKey] = redactValue(entryValue, stringKey, seen);
    }
    return result;
  }
  return entries.map(([entryKey, entryValue]) => [
    redactValue(entryKey, undefined, seen),
    redactValue(entryValue, undefined, seen),
  ]);
}

function redactError(value: Error, seen: WeakSet<object>): Record<string, unknown> {
  const result: Record<string, unknown> = {
    name: value.name,
    message: redactValue(value.message, undefined, seen),
  };
  if (value.stack !== undefined) {
    result['stack'] = redactValue(value.stack, undefined, seen);
  }
  if ('cause' in value) {
    result['cause'] = redactValue(
      (value as { cause?: unknown }).cause,
      'cause',
      seen,
    );
  }
  for (const [childKey, childValue] of Object.entries(value)) {
    if (childKey === 'cause') {
      continue;
    }
    result[childKey] = redactValue(childValue, childKey, seen);
  }
  return result;
}
