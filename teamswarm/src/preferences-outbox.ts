export type PreferencesPatch = Record<string, unknown>;
type PendingStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> &
  Partial<Pick<Storage, "key" | "length">>;
type Entry = {
  key: string;
  value: string;
  patch: PreferencesPatch;
  order: number;
};
const legacyKey = "teamswarm.preferences.pending";
const prefix = legacyKey + ".entry.";
const receiptKey = legacyKey + ".receipt";

// Each tab writes immutable field revisions, replacing only its own older entry.
// A receipt cannot delete another tab's edit, even if it arrives during cleanup.
export class PreferencesOutbox {
  private storage: PendingStorage;
  private owned = new Map<string, string>();
  private owner = crypto.randomUUID();
  private order = 0;
  constructor(storage: PendingStorage) {
    this.storage = storage;
  }
  append(patch: PreferencesPatch) {
    if (!Object.keys(patch).length) return;
    if (!this.storage.key) {
      // The desktop bridge has a single renderer and the legacy key/value API.
      const previous = JSON.parse(this.storage.getItem(legacyKey) ?? "{}");
      this.storage.setItem(
        legacyKey,
        JSON.stringify(mergePatch(previous, patch)),
      );
      return;
    }
    this.order = Math.max(
      Date.now(),
      this.order,
      ...this.snapshot().entries.map((entry) => entry.order),
    );
    const save = (path: string[], value: PreferencesPatch) => {
      const field = JSON.stringify(path);
      const key = prefix + this.owner + "." + ++this.order;
      this.storage.setItem(
        key,
        JSON.stringify({ order: this.order, patch: value }),
      );
      const previous = this.owned.get(field);
      this.owned.set(field, key);
      if (previous) this.storage.removeItem(previous);
    };
    for (const [field, value] of Object.entries(patch)) {
      if (field === "drafts") {
        for (const [id, draft] of Object.entries(
          value as Record<string, unknown>,
        ))
          save([field, id], { [field]: { [id]: draft } });
      } else if (["teams", "chats", "positions"].includes(field)) {
        for (const [id, fields] of Object.entries(
          value as Record<string, Record<string, unknown>>,
        ))
          for (const [name, item] of Object.entries(fields))
            save([field, id, name], { [field]: { [id]: { [name]: item } } });
      } else save([field], { [field]: value });
    }
  }
  snapshot() {
    const entries: Entry[] = [];
    const legacy = this.storage.getItem(legacyKey);
    if (legacy)
      entries.push({
        key: legacyKey,
        value: legacy,
        patch: JSON.parse(legacy),
        order: 0,
      });
    for (let i = 0; i < (this.storage.length ?? 0); i++) {
      const key = this.storage.key?.(i);
      if (!key?.startsWith(prefix)) continue;
      const value = this.storage.getItem(key);
      if (!value) continue;
      const entry = JSON.parse(value);
      entries.push({ key, value, patch: entry.patch, order: entry.order });
    }
    entries.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
    return {
      entries,
      patch: entries.reduce(
        (patch, entry) => mergePatch(patch, entry.patch),
        {} as PreferencesPatch,
      ),
    };
  }
  receiptVersion() {
    return this.storage.key ? this.storage.getItem(receiptKey) : null;
  }
  acknowledge(entries: Entry[]) {
    if (this.storage.key && entries.length)
      this.storage.setItem(receiptKey, crypto.randomUUID());
    for (const entry of entries)
      if (this.storage.getItem(entry.key) === entry.value)
        this.storage.removeItem(entry.key);
  }
}

export function mergePatch(left: PreferencesPatch, right: PreferencesPatch) {
  const result = { ...left, ...right };
  if (left.drafts || right.drafts)
    result.drafts = {
      ...((left.drafts as object) ?? {}),
      ...((right.drafts as object) ?? {}),
    };
  for (const field of ["teams", "chats", "positions"]) {
    const a = (left[field] ?? {}) as Record<string, object>,
      b = (right[field] ?? {}) as Record<string, object>;
    if (Object.keys(a).length || Object.keys(b).length) {
      const values = { ...a };
      for (const [id, value] of Object.entries(b))
        values[id] = { ...values[id], ...value };
      result[field] = values;
    }
  }
  return result;
}
