import { RESERVED_SLUGS } from "./hosts";

const WINDOW_MS = 10 * 60 * 1000;
const MAX_HITS = 8;
const hits = new Map<string, number[]>();

/** Eight lookups per IP in ten minutes. The window lives in this isolate and clears on restart. */
export function allowNeighborhoodLookup(ip: string, now = Date.now()): boolean {
  const key = ip.trim() || "unknown";
  const recent = (hits.get(key) ?? []).filter((time) => now - time < WINDOW_MS);
  if (recent.length >= MAX_HITS) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  return true;
}

export function resetNeighborhoodRateLimit(): void {
  hits.clear();
}

/** 3 to 12 digits, stored as entered. 850 is valid. */
export function normalizeNeighborhoodCode(value: string): string | null {
  const code = value.trim();
  if (!/^[0-9]{3,12}$/.test(code)) return null;
  return code;
}

/** Public address such as tangomar. Lowercase, starts with a letter, 2 to 40 characters. */
export function normalizeVanitySlug(value: string): string | null {
  const slug = value.trim().toLowerCase();
  if (slug.length < 2 || slug.length > 40) return null;
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(slug)) return null;
  if (RESERVED_SLUGS.has(slug)) return null;
  return slug;
}

export function neighborhoodCodeError(value: string): string {
  if (!value.trim()) return "Enter a neighborhood code.";
  if (!normalizeNeighborhoodCode(value)) return "Use 3 to 12 digits for the neighborhood code.";
  return "";
}

export function vanitySlugError(value: string): string {
  const slug = value.trim().toLowerCase();
  if (!slug) return "Enter a public slug.";
  if (RESERVED_SLUGS.has(slug)) return "That public slug is reserved.";
  if (!normalizeVanitySlug(value)) return "Use 2 to 40 lowercase letters, numbers, and hyphens. Start with a letter.";
  return "";
}
