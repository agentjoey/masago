import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<string>();

export function getCorrelationId(): string | undefined {
  return storage.getStore();
}

export function withCorrelationId<T>(id: string, fn: () => Promise<T>): Promise<T> {
  return storage.run(id, fn);
}
