import type { Context } from "hono";
import { setCookie } from "hono/cookie";
import { canEditAdmin, canViewAdmin } from "../lib/access";
import { ForbiddenError, NotFoundError, RedirectError } from "../lib/errors";
import { assertSameOrigin, clip, isHttps } from "../lib/html";
import type { AppBindings, Association, Membership, User } from "../types";

export type AppContext = Context<AppBindings>;

export function requireAssociation(c: AppContext): Association {
  const association = c.get("association");
  if (!association) throw new NotFoundError();
  return association;
}

export function requireMember(c: AppContext): { association: Association; user: User; membership: Membership } {
  const association = requireAssociation(c);
  const user = c.get("user");
  const membership = c.get("membership");
  if (!user || !membership || membership.status === "inactive") {
    const path = new URL(c.req.url).pathname;
    throw new RedirectError(`/login?next=${encodeURIComponent(path)}`);
  }
  return { association, user, membership };
}

export function requireStaff(c: AppContext): { association: Association; user: User; membership: Membership } {
  const context = requireMember(c);
  if (!canViewAdmin(context.membership)) throw new ForbiddenError();
  return context;
}

export function requireEditor(c: AppContext): { association: Association; user: User; membership: Membership } {
  const context = requireStaff(c);
  if (!canEditAdmin(context.membership)) throw new ForbiddenError();
  return context;
}

export function redirectTo(c: AppContext, location: string, message?: string, tone: "ok" | "warn" = "ok"): Response {
  if (message) {
    setCookie(c, "tango_flash", `${tone}:${message}`, {
      path: "/",
      maxAge: 120,
      httpOnly: true,
      sameSite: "Lax",
      secure: isHttps(c.req.url),
    });
  }
  return c.redirect(location, 303);
}

export async function readForm(c: AppContext): Promise<Record<string, string | File>> {
  assertSameOrigin(c.req.raw);
  const body = await c.req.parseBody();
  const fields: Record<string, string | File> = {};
  for (const [key, value] of Object.entries(body)) {
    const item = Array.isArray(value) ? value[0] : value;
    if (typeof item === "string" || item instanceof File) fields[key] = item;
  }
  return fields;
}

export function textValue(fields: Record<string, string | File>, name: string, max: number): string {
  const value = fields[name];
  return typeof value === "string" ? clip(value, max) : "";
}

export function fileValue(fields: Record<string, string | File>, name: string): File | null {
  const value = fields[name];
  return value instanceof File ? value : null;
}
