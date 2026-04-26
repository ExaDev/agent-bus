/**
 * Minimal nanoid — URL-safe alphanumeric, no dependencies.
 * Uses crypto.getRandomValues for cryptographic randomness.
 */

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-";
const SIZE = 21;

export function nanoid(size: number = SIZE): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  let id = "";
  for (let i = 0; i < size; i++) {
    id += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return id;
}
