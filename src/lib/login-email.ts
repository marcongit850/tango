import { findUserByEmail } from "../db";
import { isUniqueConstraint } from "./errors";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_CHANGE_PREFIX = "email-change:";

export function emailChangeRedirect(userId: string): string {
  return `${EMAIL_CHANGE_PREFIX}${userId}`;
}

export function parseEmailChangeUserId(redirectPath: string): string | null {
  if (!redirectPath.startsWith(EMAIL_CHANGE_PREFIX)) return null;
  const userId = redirectPath.slice(EMAIL_CHANGE_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(userId)) return null;
  return userId;
}

export function emailChangeLetter(input: { associationName: string; link: string; minutes: number }): { subject: string; text: string } {
  const associationName = input.associationName.replace(/[\r\n]+/g, " ").trim() || "the association";
  return {
    subject: `Confirm your email for ${associationName}`,
    text: [
      `Use this link to confirm your new email for the ${associationName} owner portal.`,
      `It expires in ${input.minutes} minutes and works once.`,
      "",
      input.link,
      "",
      "Your login stays the same until you open the link.",
      "If you did not ask to change your email, you can ignore this message.",
    ].join("\n"),
  };
}

export function emailChangedLetter(input: { associationName: string; newEmail: string }): { subject: string; text: string } {
  const associationName = input.associationName.replace(/[\r\n]+/g, " ").trim() || "the association";
  return {
    subject: `Your ${associationName} email was changed`,
    text: [
      `The login email for your ${associationName} owner portal was changed to ${input.newEmail}.`,
      "",
      "If you did not ask for this, contact the board.",
    ].join("\n"),
  };
}

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
