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
export function isPasswordStrongEnough(plain: string): boolean {
  return plain.length >= 10 && /[A-Za-z]/.test(plain) && /[0-9]/.test(plain);
}
