import bcrypt from "bcrypt";

const SALT_ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// Minimal server-side strength check. Real production apps should also check
// against a breached-password list (e.g. HaveIBeenPwned's k-anonymity API).
// Passwords that satisfy "10+ chars with a letter and a number" but appear at the very top of
// every breached-password list. (A full HIBP check is still the better long-term answer.)
const COMMON_PASSWORDS = new Set([
  "password123", "password1234", "password12345", "passw0rd123", "qwerty12345", "qwerty123456",
  "1qaz2wsx3edc", "iloveyou123", "iloveyou1234", "welcome1234", "welcome12345", "admin12345",
  "letmein12345", "abc1234567", "abcd123456", "abcd1234567", "a1b2c3d4e5", "1234567890a",
  "a123456789", "aa123456789", "monkey12345", "dragon12345", "football123", "baseball123",
  "matchify123", "matchify1234", "demo@12345", "demoadmin@12345",
]);

export function isPasswordStrongEnough(plain: string): boolean {
  if (plain.length < 10 || plain.length > 128) return false;
  if (!/[A-Za-z]/.test(plain) || !/[0-9]/.test(plain)) return false;
  if (COMMON_PASSWORDS.has(plain.toLowerCase())) return false;
  // Reject a single repeated character ("aaaaaaaaa1") or an obvious run.
  if (/^(.)\1+.?$/.test(plain)) return false;
  return true;
}
