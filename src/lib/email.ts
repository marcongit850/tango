import { logError } from "./log";

const PORTAL_ORIGIN = "https://mytangomar.com";

/** Inbox for resident support messages from the portal. */
export const SUPPORT_INBOX = "352marc@gmail.com";

export type LoginAudience = "owners" | "board";
export type OwnerNoticeKind = "announcement" | "event" | "document";

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
        : `${associationName} published a document.`;
  const lines = [intro, "", title];
  if (summary && summary.toLowerCase() !== title.toLowerCase()) lines.push("", summary);
  lines.push("", href);
  return { subject: `${associationName}: ${title}`, text: lines.join("\n"), href };
}

function ownerNoticeHref(slug: string, kind: OwnerNoticeKind, itemId?: string): string {
  if (kind === "announcement" && itemId) return `${PORTAL_ORIGIN}/a/${slug}/news/${itemId}`;
  if (kind === "event") return `${PORTAL_ORIGIN}/a/${slug}/calendar`;
  return `${PORTAL_ORIGIN}/a/${slug}/documents`;
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
  fetchImpl?: typeof fetch;
}): Promise<OwnerEmailDelivery> {
  if (!options.apiKey) return { sent: 0, failed: 0, skipped: true };
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
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const payload: {
    from: string;
    to: string[];
    subject: string;
    text: string;
    reply_to?: string;
  } = {
    from: options.from,
    to: [options.to],
    subject: options.subject,
    text: options.text,
  };
  if (options.replyTo) payload.reply_to = options.replyTo;
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
