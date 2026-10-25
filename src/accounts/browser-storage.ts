import type { KeyValue } from "./local-backend";

/** localStorage, or memory when the browser blocks it (a private window, a sandboxed preview). */
export function browserStorage(): KeyValue {
  try {
    const probe = "nitya-probe";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    const map = new Map<string, string>();
    return { getItem: k => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
  }
}
