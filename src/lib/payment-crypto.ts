/**
 * Encrypts a neighborhood's Stripe secrets at rest.
 * PAYMENT_ENCRYPTION_KEY is the current base64-encoded 32-byte AES-GCM key.
 * PAYMENT_ENCRYPTION_KEY_ID is that key's id (default 1).
 * PAYMENT_ENCRYPTION_KEYS is an optional JSON map of older ids to keys, used only to decrypt.
 * Ciphertext is v2.<key id>.<iv>.<cipher> and is bound to the neighborhood and the field.
 * Callers must not log plaintext, ciphertext, or the key.
 */

const KID = /^[A-Za-z0-9_-]{1,32}$/;

export type PaymentSecretField = "secret_key" | "webhook_secret";

export type PaymentKeyRing = {
  currentKid: string;
  keys: ReadonlyMap<string, string>;
};

type SecretEnv = Env & {
  PAYMENT_ENCRYPTION_KEY?: string;
  PAYMENT_ENCRYPTION_KEY_ID?: string;
  PAYMENT_ENCRYPTION_KEYS?: string;
};

export function paymentEncryptionKey(env: Env): string | undefined {
  const value = (env as SecretEnv).PAYMENT_ENCRYPTION_KEY?.trim();
  return value ? value : undefined;
}

/** Current key plus any previous keys. Null when the current key is missing or the map is unreadable. */
export function paymentKeyRing(env: Env): PaymentKeyRing | null {
  const current = paymentEncryptionKey(env);
  const kid = (env as SecretEnv).PAYMENT_ENCRYPTION_KEY_ID?.trim() || "1";
  if (!KID.test(kid) || !current) return null;
  const previous = previousKeys((env as SecretEnv).PAYMENT_ENCRYPTION_KEYS);
  if (previous === null) return null;
  const keys = new Map(previous);
  keys.set(kid, current);
  return { currentKid: kid, keys };
}

export async function encryptPaymentSecret(
  ring: PaymentKeyRing,
  associationId: string,
  field: PaymentSecretField,
  plaintext: string,
): Promise<string> {
  const material = ring.keys.get(ring.currentKid);
  if (!material) throw new Error("payment encryption key is not configured");
  const key = await importKey(material);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(associationId, field) },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `v2.${ring.currentKid}.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(cipher))}`;
}

export async function decryptPaymentSecret(
  ring: PaymentKeyRing,
  associationId: string,
  field: PaymentSecretField,
  stored: string,
): Promise<string> {
  const parts = stored.split(".");
  if (parts[0] === "v1" && parts.length === 3) return decryptLegacy(ring, parts[1] ?? "", parts[2] ?? "");
  if (parts[0] !== "v2" || parts.length !== 4 || !parts[1] || !KID.test(parts[1])) throw new Error("unreadable payment secret");
  const material = ring.keys.get(parts[1]);
  if (!material) throw new Error("unreadable payment secret");
  const iv = base64ToBytes(parts[2] ?? "");
  const cipher = base64ToBytes(parts[3] ?? "");
  if (!iv || iv.byteLength !== 12 || !cipher) throw new Error("unreadable payment secret");
  const key = await importKey(material);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: aad(associationId, field) },
    key,
    cipher,
  );
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

function aad(associationId: string, field: PaymentSecretField): Uint8Array {
  return new TextEncoder().encode(`${associationId}:${field}`);
}

async function decryptLegacy(ring: PaymentKeyRing, ivPart: string, cipherPart: string): Promise<string> {
  const iv = base64ToBytes(ivPart);
  const cipher = base64ToBytes(cipherPart);
  if (!iv || iv.byteLength !== 12 || !cipher) throw new Error("unreadable payment secret");
  for (const material of ring.keys.values()) {
    try {
      const key = await importKey(material);
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
      return new TextDecoder().decode(plain);
    } catch {
      // Try the next key. v1 rows are not bound to a neighborhood.
    }
  }
  throw new Error("unreadable payment secret");
}

function previousKeys(raw: string | undefined): Map<string, string> | null {
  const value = raw?.trim();
  if (!value) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const keys = new Map<string, string>();
  for (const [id, secret] of Object.entries(parsed)) {
    if (!KID.test(id) || typeof secret !== "string" || !secret.trim()) return null;
    keys.set(id, secret.trim());
  }
  return keys;
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
