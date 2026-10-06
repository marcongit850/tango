import { findUserByEmail } from "../db";
import { isUniqueConstraint } from "./errors";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type LoginEmailResult =
  | { ok: true; email: string; changed: boolean }
  | { ok: false; reason: "invalid" | "taken" | "missing" };

export function normalizeLoginEmail(value: string): string {
  return value.trim().toLowerCase();
}

export async function changeLoginEmail(db: D1Database, userId: string, rawEmail: string): Promise<LoginEmailResult> {
  const email = normalizeLoginEmail(rawEmail);
  if (!email || email.length > 200 || !EMAIL.test(email)) return { ok: false, reason: "invalid" };

  const existing = await findUserByEmail(db, email);
  if (existing && existing.id !== userId) return { ok: false, reason: "taken" };
  if (existing && existing.email === email) return { ok: true, email, changed: false };

  try {
    const updated = await db.prepare("UPDATE users SET email = ? WHERE id = ?").bind(email, userId).run();
    if ((updated.meta.changes ?? 0) === 0) return { ok: false, reason: "missing" };
  } catch (error) {
    if (isUniqueConstraint(error)) return { ok: false, reason: "taken" };
    throw error;
  }
  return { ok: true, email, changed: true };
}
