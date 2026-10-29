// Share observations between the composer and settings. Opening a menu is not
// a reason to start another native Harness process.
type Entry = { expires: number; promise: Promise<unknown> };
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
export function cachedCatalog<T>(
  key: string,
  read: () => Promise<T>,
  refresh = false,
): Promise<T> {
  const current = entries.get(key);
  if (
    current &&
    current.expires > Date.now() &&
    (!refresh || current.expires === Infinity)
  )
    return current.promise as Promise<T>;
  const entry: Entry = { expires: Infinity, promise: Promise.resolve() };
  entry.promise = read().then(
    (value) => {
      entry.expires = Date.now() + 300_000;
      return value;
    },
    (error) => {
      if (entries.get(key) === entry) entries.delete(key);
      throw error;
    },
  );
  entries.set(key, entry);
  return entry.promise as Promise<T>;
}
export function invalidateModelCatalog(teamId?: string) {
  for (const key of entries.keys())
    if (!teamId || key === `team:${teamId}`) entries.delete(key);
  notifyModelCatalog();
}
export function notifyModelCatalog() {
  for (const listener of listeners) listener();
}
export function subscribeModelCatalog(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
