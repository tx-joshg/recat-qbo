// Browser storage for view preferences — never anything authoritative.
//
// `localStorage` is not safely reachable everywhere. Under strict privacy
// settings the property itself throws on access; it can be present as a
// partial stub without getItem/setItem; Safari rejects writes in private
// mode; and any browser rejects them once the quota is full. Optional
// chaining catches only the first of those.
//
// Every call degrades to "no saved preference" so a stored preference can
// never take a page down — least of all AppProvider, which wraps the whole
// app and would otherwise fail during initialisation.

export function readPreference(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writePreference(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // A rejected write must not block the change the user just made on screen.
  }
}
