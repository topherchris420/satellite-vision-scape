import type { KeyValueStorage } from "../afterhours/progress";

/** Navigation destroys the live scene, so never travel on an unconfirmed save. */
export function confirmTravelCheckpoint<T>(
  storage: KeyValueStorage | null,
  key: string,
  active: T,
  parse: (raw: string | null) => T,
  revision: (record: T) => number,
  encode: (record: T) => string,
): boolean {
  if (!storage) return false;
  try {
    const raw = storage.getItem(key);
    const saved = parse(raw);
    const desired = encode(active);
    if (raw !== null && revision(saved) >= revision(active) && encode(saved) !== desired)
      return false;
    storage.setItem(key, desired);
    return storage.getItem(key) === desired;
  } catch {
    return false;
  }
}
