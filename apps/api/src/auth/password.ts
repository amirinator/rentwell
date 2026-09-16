/**
 * Password hashing.
 *
 * Argon2id with the parameters from the OWASP Password Storage Cheat Sheet
 * (19 MiB memory, 2 iterations, 1 degree of parallelism). Argon2id rather than
 * bcrypt because its memory cost is what makes GPU cracking expensive, and the
 * memory parameter is the one this codebase can raise later without a migration
 * — the cost parameters are encoded in each hash, so old hashes keep verifying.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';

export interface PasswordOptions {
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

export const DEFAULT_PASSWORD_OPTIONS: PasswordOptions = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(
  plaintext: string,
  options: PasswordOptions = DEFAULT_PASSWORD_OPTIONS,
): Promise<string> {
  return argon2.hash(plaintext, {
    type: argon2.argon2id,
    memoryCost: options.memoryCost,
    timeCost: options.timeCost,
    parallelism: options.parallelism,
  });
}

/**
 * Verifies a password. Returns false rather than throwing on a malformed hash,
 * so a corrupted row denies access instead of returning a 500 that tells an
 * attacker the account exists.
 */
export async function verifyPassword(hash: string, plaintext: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plaintext);
  } catch {
    return false;
  }
}

/**
 * A hash of a throwaway value, used to equalise the cost of a sign-in attempt
 * for an address that does not exist. Without it, the response time difference
 * between "no such user" and "wrong password" enumerates accounts.
 */
let decoyHash: string | null = null;

export async function verifyAgainstDecoy(options: PasswordOptions): Promise<false> {
  if (decoyHash === null) {
    decoyHash = await hashPassword(randomBytes(24).toString('hex'), options);
  }
  await verifyPassword(decoyHash, 'not-the-password');
  return false;
}

/** Cryptographically random opaque token, URL-safe. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time string comparison for CSRF tokens and similar secrets. */
export function safeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
