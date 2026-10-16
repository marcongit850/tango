/**
 * Encrypts a neighborhood's Stripe secrets at rest.
 * The Worker secret PAYMENT_ENCRYPTION_KEY is a base64-encoded 32-byte AES-GCM key.
 * Callers must not log plaintext, ciphertext, or the key.
 */

const VERSION = "v1";

export function paymentEncryptionKey(env: Env): string | undefined {
  const value = (env as Env & { PAYMENT_ENCRYPTION_KEY?: string }).PAYMENT_ENCRYPTION_KEY?.trim();
  return value ? value : undefined;
}

export async function encryptPaymentSecret(material: string, plaintext: string): Promise<string> {
  const key = await importKey(material);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return `${VERSION}.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(cipher))}`;
}

export async function decryptPaymentSecret(material: string, stored: string): Promise<string> {
  const parts = stored.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) throw new Error("unreadable payment secret");
  const iv = base64ToBytes(parts[1] ?? "");
  const cipher = base64ToBytes(parts[2] ?? "");
  if (!iv || iv.byteLength !== 12 || !cipher) throw new Error("unreadable payment secret");
  const key = await importKey(material);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return new TextDecoder().decode(plain);
}

/** Fixed-size compare. Hashes first so length does not leak, then uses timingSafeEqual when the runtime has it. */
export async function fixedTimeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean;
  };
  if (typeof subtle.timingSafeEqual === "function") return subtle.timingSafeEqual(leftHash, rightHash);
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

async function importKey(material: string): Promise<CryptoKey> {
  const bytes = base64ToBytes(material.trim());
  if (!bytes || bytes.byteLength !== 32) throw new Error("payment encryption key is not configured");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value.replaceAll(/\s/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}
