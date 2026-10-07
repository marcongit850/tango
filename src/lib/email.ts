import { contentTypeForUpload, MAX_DOCUMENT_BYTES, safeFilename } from "./files";
import { logError } from "./log";

const PORTAL_ORIGIN = "https://mytangomar.com";

/** Inbox for resident support messages from the portal. */
export const SUPPORT_INBOX = "352marc@gmail.com";

export type LoginAudience = "owners" | "board";
export type OwnerNoticeKind = "announcement" | "event" | "document" | "account";

/** File bytes for a Resend email. `content` is base64. */
export type ResendAttachment = {
  filename: string;
  content: string;
  contentType: string;
};

export function resendApiKey(env: Env): string | undefined {
  const value = (env as Env & { RESEND_API_KEY?: string }).RESEND_API_KEY?.trim();
  return value ? value : undefined;
}

export function supportEmailText(input: { name: string; email: string; message: string }): string {
  return [`Name: ${input.name}`, `Email: ${input.email}`, "", input.message].join("\n");
}

export function loginAudienceForVisibility(visibility: string): LoginAudience {
  return visibility === "board" ? "board" : "owners";
}

/** One address per person. Blank and repeated logins are dropped. */
export function uniqueLoginEmails(rows: { id: string; email: string }[]): { id: string; email: string }[] {
  const seen = new Set<string>();
  const people: { id: string; email: string }[] = [];
  for (const row of rows) {
    const email = row.email.trim();
    const key = email.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    people.push({ id: row.id, email });
  }
  return people;
}

export function ownerNoticeEmail(input: {
  associationName: string;
  slug: string;
  kind: OwnerNoticeKind;
  title: string;
  summary: string;
  itemId?: string;
  attachmentName?: string;
}): { subject: string; text: string; href: string } {
  const associationName = oneLine(input.associationName) || "The association";
  const title = oneLine(input.title) || "Update";
  const summary = briefPlain(input.summary);
  const href = ownerNoticeHref(input.slug, input.kind, input.itemId);
  const intro =
    input.kind === "announcement"
      ? `${associationName} posted an announcement.`
      : input.kind === "event"
        ? `${associationName} added an event.`
        : input.kind === "account"
          ? `${associationName} posted a notice.`
          : `${associationName} published a document.`;
  const lines = [intro, "", title];
  if (summary && summary.toLowerCase() !== title.toLowerCase()) lines.push("", summary);
  const attachmentName = input.attachmentName ? oneLine(input.attachmentName) : "";
  if (attachmentName) {
    lines.push("", `Attached file: ${attachmentName}`);
    if (input.kind === "account") lines.push("You can also open it from the notice in the portal.");
  }
  lines.push("", href);
  return { subject: `${associationName}: ${title}`, text: lines.join("\n"), href };
}

function ownerNoticeHref(slug: string, kind: OwnerNoticeKind, itemId?: string): string {
  if (kind === "announcement" && itemId) return `${PORTAL_ORIGIN}/a/${slug}/news/${itemId}`;
  if (kind === "event") return `${PORTAL_ORIGIN}/a/${slug}/calendar`;
  if (kind === "account") return `${PORTAL_ORIGIN}/a/${slug}/notices`;
  return `${PORTAL_ORIGIN}/a/${slug}/documents`;
}

/** Turns an uploaded notice file into a Resend attachment. Empty or disallowed files are skipped. */
export async function fileToResendAttachment(file: File | null): Promise<ResendAttachment | null> {
  if (!file || file.size <= 0 || file.size > MAX_DOCUMENT_BYTES) return null;
  const contentType = contentTypeForUpload(file);
  if (!contentType) return null;
  return resendAttachment(safeFilename(file.name), contentType, new Uint8Array(await file.arrayBuffer()));
}

export function resendAttachment(filename: string, contentType: string, bytes: Uint8Array): ResendAttachment {
  return { filename, content: bytesToBase64(bytes), contentType };
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunk) {
    const slice = bytes.subarray(index, index + chunk);
    let part = "";
    for (let offset = 0; offset < slice.length; offset += 1) part += String.fromCharCode(slice[offset] ?? 0);
    binary += part;
  }
  return btoa(binary);
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function briefPlain(value: string, max = 320): string {
  const flat = oneLine(value);
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  const base = space > 200 ? cut.slice(0, space) : cut;
  return `${base.trimEnd()}...`;
}

export type OwnerEmailDelivery = {
  sent: number;
  failed: number;
  skipped: boolean;
};

export async function deliverOwnerEmails(options: {
  apiKey?: string;
  from: string;
  recipients: { email: string }[];
  subject: string;
  text: string;
  attachments?: ResendAttachment[];
  fetchImpl?: typeof fetch;
}): Promise<OwnerEmailDelivery> {
  if (!options.apiKey) return { sent: 0, failed: 0, skipped: true };
  const attachments = options.attachments && options.attachments.length > 0 ? options.attachments : undefined;
  let sent = 0;
  let failed = 0;
  for (const person of options.recipients) {
    try {
      const ok = await sendResendEmail({
        apiKey: options.apiKey,
        from: options.from,
        to: person.email,
        subject: options.subject,
        text: options.text,
        attachments,
        fetchImpl: options.fetchImpl,
      });
      if (ok) sent += 1;
      else failed += 1;
    } catch (error) {
      failed += 1;
      logError("owner_notice_email", { message: error instanceof Error ? error.message : "unknown" });
    }
  }
  return { sent, failed, skipped: false };
}

export function ownerEmailFlash(input: {
  saved: string;
  audience: LoginAudience;
  recipients: number;
  delivery: OwnerEmailDelivery;
}): { message: string; tone: "ok" | "warn"; note: string } {
  const people = input.audience === "board" ? "board members" : "owners";
  const person = input.audience === "board" ? "board member" : "owner";
  if (input.recipients === 0) {
    const note = input.audience === "board" ? "No active board logins to email." : "No active logins to email.";
    return { message: `${input.saved} ${note}`, tone: "warn", note };
  }
  if (input.delivery.skipped || input.delivery.sent === 0) {
    const note = "Email was not sent.";
    return { message: `${input.saved} ${note}`, tone: "warn", note };
  }
  if (input.delivery.failed > 0) {
    const note = `Emailed ${input.delivery.sent} of ${input.recipients} ${people}.`;
    return { message: `${input.saved} ${note}`, tone: "warn", note };
  }
  const noun = input.delivery.sent === 1 ? person : people;
  const note = `Emailed ${input.delivery.sent} ${noun}.`;
  return { message: `${input.saved} ${note}`, tone: "ok", note };
}

export async function sendResendEmail(options: {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
  attachments?: ResendAttachment[];
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const payload: {
    from: string;
    to: string[];
    subject: string;
    text: string;
    reply_to?: string;
    attachments?: { filename: string; content: string; content_type: string }[];
  } = {
    from: options.from,
    to: [options.to],
    subject: options.subject,
    text: options.text,
  };
  if (options.replyTo) payload.reply_to = options.replyTo;
  if (options.attachments && options.attachments.length > 0) {
    payload.attachments = options.attachments.map((item) => ({
      filename: item.filename,
      content: item.content,
      content_type: item.contentType,
    }));
  }
  const response = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const detail = await response.text();
    logError("resend_failed", { status: response.status, detail: detail.slice(0, 300) });
    return false;
  }
  return true;
}
