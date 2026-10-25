/**
 * The parent PIN. It keeps a child from switching profiles, editing them or
 * opening settings on a shared device; it is not a password. Only a salted
 * PBKDF2 hash is kept, readable by the parent's own account alone.
 */
const ITERATIONS = 100_000;

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0));

async function derive(pin: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

/** Why a PIN can't be used, or null. */
export function pinProblem(pin: string): string | null {
  if (!/^\d{4}$/.test(pin)) return "The PIN is 4 digits.";
  if (/^(\d)\1{3}$/.test(pin)) return "Pick digits that aren't all the same.";
  if ("0123456789".includes(pin) || "9876543210".includes(pin)) return "Pick digits that aren't in a row.";
  return null;
}

/** "pbkdf2-sha256$<iterations>$<salt>$<hash>", with a new random salt each time. */
export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${ITERATIONS}$${toBase64(salt)}$${toBase64(await derive(pin, salt, ITERATIONS))}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [scheme, iterations, salt, hash] = stored.split("$");
  if (scheme !== "pbkdf2-sha256" || !salt || !hash) return false;
  const got = await derive(pin, fromBase64(salt), Number(iterations));
  const want = fromBase64(hash);
  return got.length === want.length && got.every((b, i) => b === want[i]);
}

/** Wrong tries allowed before the PIN pad waits, and how long it waits. */
export const PIN_TRIES = 5;
export const PIN_WAIT_SECONDS = 30;
