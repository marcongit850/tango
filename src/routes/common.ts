import type { Context } from "hono";
import { setCookie } from "hono/cookie";
import { messageAttachmentForViewer } from "../db";
import { canEditAdmin, canViewAdmin } from "../lib/access";
import { ForbiddenError, NotFoundError, RedirectError } from "../lib/errors";
import { allowedDocumentType, applyDocumentResponseHeaders, isImageContentType } from "../lib/files";
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

export type FormFields = Record<string, string | File | File[]>;

export async function readForm(c: AppContext): Promise<FormFields> {
  assertSameOrigin(c.req.raw);
  const body = await c.req.parseBody({ all: true });
  const fields: FormFields = {};
  for (const [key, value] of Object.entries(body)) {
    if (Array.isArray(value)) {
      const files = value.filter((item): item is File => item instanceof File);
      if (files.length > 1) {
        fields[key] = files;
        continue;
      }
      if (files.length === 1) {
        fields[key] = files[0];
        continue;
      }
      const text = value.find((item): item is string => typeof item === "string");
      if (text !== undefined) fields[key] = text;
      continue;
    }
    if (typeof value === "string" || value instanceof File) fields[key] = value;
  }
  return fields;
}

export function textValue(fields: FormFields, name: string, max: number): string {
  const value = fields[name];
  return typeof value === "string" ? clip(value, max) : "";
}

export function fileValue(fields: FormFields, name: string): File | null {
  const value = fields[name];
  if (value instanceof File) return value;
  if (Array.isArray(value)) return value.find((item): item is File => item instanceof File) ?? null;
  return null;
}

export function fileValues(fields: FormFields, name: string): File[] {
  const value = fields[name];
  const files = value instanceof File ? [value] : Array.isArray(value) ? value.filter((item): item is File => item instanceof File) : [];
  return files.filter((file) => file.size > 0);
}

/** Streams one message file. Images can open inline. Every other allowed type downloads. */
export async function streamMessageAttachment(
  c: AppContext,
  threadId: string,
  messageId: string,
  attachmentId: string,
  staff: boolean,
): Promise<Response> {
  const { association, user } = requireMember(c);
  const found = await messageAttachmentForViewer(
    c.env.DB,
    association.id,
    threadId,
    messageId,
    attachmentId,
    user.id,
    staff,
  );
  if (!found.ok) {
    if (found.reason === "forbidden") throw new ForbiddenError();
    throw new NotFoundError();
  }
  if (!allowedDocumentType(found.file.content_type)) throw new NotFoundError();
  const object = await c.env.DOCUMENTS.get(found.file.r2_key);
  if (!object) throw new NotFoundError();
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", found.file.content_type);
  applyDocumentResponseHeaders(headers, {
    filename: found.file.filename,
    contentType: found.file.content_type,
    download: c.req.query("download") === "1" || !isImageContentType(found.file.content_type),
  });
  return new Response(object.body, { headers });
}
