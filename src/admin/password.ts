// A strong password for a new account, and the check the form runs before it sends anything. The server checks
// again (12 to 72 characters). Nothing here stores or logs a password.
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 72;
const LOWER = "abcdefghijkmnopqrstuvwxyz"; // no l, which looks like 1 and I
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I or O
const DIGITS = "23456789"; // no 0 or 1
const SYMBOLS = "-_!@#$%*+=?";
const ALL = LOWER + UPPER + DIGITS + SYMBOLS;

// One random index below `max`, without modulo bias (values that would skew the result are thrown away).
function randomBelow(max: number, source: Crypto = globalThis.crypto): number {
  const limit = Math.floor(0x100000000 / max) * max;
  const buffer = new Uint32Array(1);
  for (;;) {
    source.getRandomValues(buffer);
    if (buffer[0] < limit) return buffer[0] % max;
  }
}

export function generatePassword(length = 20, source: Crypto = globalThis.crypto): string {
  const size = Math.max(16, Math.min(length, PASSWORD_MAX));
  for (;;) {
    const chars = Array.from({ length: size }, () => ALL[randomBelow(ALL.length, source)]);
    const text = chars.join("");
    // at least one of each kind, so it passes any strength rule
    if ([LOWER, UPPER, DIGITS, SYMBOLS].every(set => [...set].some(c => text.includes(c)))) return text;
  }
}

export const passwordProblem = (password: string): string =>
  password.length < PASSWORD_MIN ? `Use at least ${PASSWORD_MIN} characters.`
  : new TextEncoder().encode(password).length > PASSWORD_MAX ? `Use at most ${PASSWORD_MAX} characters.`
  : "";
