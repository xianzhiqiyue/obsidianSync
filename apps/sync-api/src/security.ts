import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_KEY_LEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const digest = scryptSync(password, salt, SCRYPT_KEY_LEN).toString("hex");
  return `${salt}:${digest}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, digest] = storedHash.split(":");
  if (!salt || !digest) {
    return false;
  }

  const input = scryptSync(password, salt, SCRYPT_KEY_LEN);
  const stored = Buffer.from(digest, "hex");
  if (input.length !== stored.length) {
    return false;
  }

  return timingSafeEqual(input, stored);
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
