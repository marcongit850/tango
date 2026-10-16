import { formatDate } from "./dates";
import { contentTypeForUpload, MAX_DOCUMENT_BYTES, safeFilename } from "./files";
import { esc } from "./html";
import { logError } from "./log";
import { formatMoney } from "./money";

const PORTAL_ORIGIN = "https://mytangomar.com";

/** Inbox for portal support requests. Kept off the public page. */
export const SUPPORT_INBOX = "marc@whpinc.com";

const SUPPORT_WINDOW_MS = 10 * 60 * 1000;
const SUPPORT_MAX = 5;
const supportHits = new Map<string, number[]>();

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

export function supportKindLabel(kind: string): string | null {
  if (kind === "issue") return "Issue";
  if (kind === "question") return "Question";
  if (kind === "feature") return "Feature request";
  return null;
}

export function supportFieldError(input: { kind: string; subject: string; details: string }): string {
  if (!supportKindLabel(input.kind)) return "Choose a type.";
  if (!input.subject) return "Enter a subject.";
  if (!input.details) return "Enter the details.";
  return "";
}

export function supportSubject(associationName: string, kindLabel: string, subject: string): string {
  const name = oneLine(associationName) || "Support";
  const title = oneLine(subject) || "Request";
  return `[${name} support] ${kindLabel}: ${title}`.slice(0, 200);
}

export function supportEmailText(input: {
  name: string;
  email: string;
  role: string;
  page: string;
  time: string;
  message: string;
}): string {
  return [
    `Name: ${oneLine(input.name)}`,
    `Email: ${oneLine(input.email)}`,
    `Role: ${oneLine(input.role)}`,
    `Page: ${oneLine(input.page)}`,
    `Time: ${oneLine(input.time)}`,
    "",
    input.message.trim(),
  ].join("\n");
}

/** Five requests per person in ten minutes. The window lives in this isolate and clears on restart. */
export function allowSupportRequest(userId: string, now = Date.now()): boolean {
  const key = userId.trim() || "unknown";
  const recent = (supportHits.get(key) ?? []).filter((time) => now - time < SUPPORT_WINDOW_MS);
  if (recent.length >= SUPPORT_MAX) {
    supportHits.set(key, recent);
    return false;
  }
  recent.push(now);
  supportHits.set(key, recent);
  return true;
}

export function resetSupportRateLimit(): void {
  supportHits.clear();
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
  /** https://myhoadashboard.com/<vanity> when the association has a public address. */
  canonicalBase?: string;
}): { subject: string; text: string; href: string } {
  const associationName = oneLine(input.associationName) || "The association";
  const title = oneLine(input.title) || "Update";
  const summary = briefPlain(input.summary);
  const href = ownerNoticeHref(input.slug, input.kind, input.itemId, input.canonicalBase);
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

/** Remaining balance an owner is asked to pay. Late fees are included. Payments already recorded are not. */
export function invoiceAmountDueCents(amountCents: number, lateFeeCents: number, paidCents: number): number {
  const due = Number(amountCents) + Number(lateFeeCents) - Number(paidCents);
  if (!Number.isFinite(due) || due <= 0) return 0;
  return Math.round(due);
}

const EMAIL_FONT = "Segoe UI, Helvetica, Arial, sans-serif";
const EMAIL_SERIF = "Georgia, 'Times New Roman', serif";

/** Branded invoice letter. Sent on issued_on, and again when an admin chooses Email this invoice. */
export function invoiceOwnerEmail(input: {
  associationName: string;
  invoiceNumber: string;
  description: string;
  lotNumber: string;
  amountDueCents: number;
  lateFeeCents?: number;
  dueOn: string;
  timeZone: string;
  payUrl: string;
  payOnline?: boolean;
  feeLine?: string;
  payableTo?: string;
  mailLines?: string[];
  boardNote?: string;
}): { subject: string; text: string; html: string } {
  const associationName = oneLine(input.associationName) || "Your association";
  const description = oneLine(input.description) || "Invoice";
  const invoiceNumber = oneLine(input.invoiceNumber) || "Invoice";
  const lotNumber = oneLine(input.lotNumber) || "Lot";
  const due = formatDate(input.dueOn, input.timeZone);
  const lateFeeCents = input.lateFeeCents ?? 0;
  const amountDue = formatMoney(invoiceAmountDueCents(input.amountDueCents, 0, 0));
  const lateFee = lateFeeCents > 0 ? formatMoney(lateFeeCents) : "";
  const payOnline = Boolean(input.payOnline);
  const button = payOnline ? "Pay now" : "View invoice";
  const feeLine = payOnline ? oneLine(input.feeLine ?? "") : "";
  const payableTo = oneLine(input.payableTo ?? "") || associationName;
  const mailLines = (input.mailLines ?? []).map((line) => oneLine(line)).filter(Boolean).slice(0, 5);
  const boardNote = oneLine(input.boardNote ?? "");
  const subject = `${associationName}: ${description} invoice`;
  const intro = `Your ${description} invoice is ready.`;
  const lines = [associationName, "", intro, "", `Invoice number: ${invoiceNumber}`, `Lot: ${lotNumber}`, `Due date: ${due}`];
  if (lateFee) lines.push(`Late fee: ${lateFee}`);
  lines.push(`Amount due: ${amountDue}`, "", `${button}: ${input.payUrl}`);
  if (feeLine) lines.push(feeLine);
  if (mailLines.length > 0) {
    lines.push(
      "",
      `Prefer to mail a check? No fee for checks. Make it payable to ${payableTo} and write your lot number on it. Mail to:`,
      ...mailLines,
    );
  }
  if (boardNote) lines.push("", "A note from the board:", boardNote);
  lines.push(
    "",
    "Questions? Use the Support tab in your portal. This mailbox is not monitored.",
    `Sent by ${associationName} through My HOA Dashboard.`,
  );
  return { subject, text: lines.join("\n"), html: invoiceEmailHtml({
    subject,
    associationName,
    intro,
    invoiceNumber,
    lotNumber,
    due,
    lateFee,
    amountDue,
    button,
    payUrl: input.payUrl,
    feeLine,
    payableTo,
    mailLines,
    boardNote,
  }) };
}

function invoiceEmailHtml(input: {
  subject: string;
  associationName: string;
  intro: string;
  invoiceNumber: string;
  lotNumber: string;
  due: string;
  lateFee: string;
  amountDue: string;
  button: string;
  payUrl: string;
  feeLine: string;
  payableTo: string;
  mailLines: string[];
  boardNote: string;
}): string {
  const detailRows = [
    detailRow("Invoice number", input.invoiceNumber),
    detailRow("Lot", input.lotNumber),
    detailRow("Due date", input.due),
    input.lateFee ? detailRow("Late fee", input.lateFee) : "",
    detailRow("Amount due", input.amountDue, true),
  ].join("");
  const fee = input.feeLine
    ? `<tr><td style="padding:14px 28px 0;font-family:${EMAIL_FONT};font-size:14px;line-height:1.5;color:#5d6c74;">${esc(input.feeLine)}</td></tr>`
    : "";
  const check = input.mailLines.length
    ? `<tr><td style="padding:18px 28px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e4d9c8;background:#f7f3ea;">
          <tr><td style="padding:14px 16px;font-family:${EMAIL_FONT};font-size:15px;line-height:1.5;color:#1b2830;">
            Prefer to mail a check? No fee for checks. Make it payable to ${esc(input.payableTo)} and write your lot number on it. Mail to:<br>${input.mailLines.map((line) => esc(line)).join("<br>")}
          </td></tr>
        </table>
      </td></tr>`
    : "";
  const note = input.boardNote
    ? `<tr><td style="padding:18px 28px 0;font-family:${EMAIL_FONT};font-size:15px;line-height:1.5;color:#1b2830;"><strong>A note from the board:</strong> ${esc(input.boardNote)}</td></tr>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(input.subject)}</title></head>
<body style="margin:0;padding:0;background:#f4efe6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4efe6;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px;max-width:560px;background:#fffdf8;">
      <tr><td style="padding:22px 28px;background:#0e5e5b;font-family:${EMAIL_SERIF};font-size:24px;line-height:1.3;color:#ffffff;">${esc(input.associationName)}</td></tr>
      <tr><td style="padding:24px 28px 0;font-family:${EMAIL_FONT};font-size:16px;line-height:1.5;color:#1b2830;">${esc(input.intro)}</td></tr>
      <tr><td style="padding:16px 28px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e4d9c8;">
          ${detailRows}
        </table>
      </td></tr>
      <tr><td style="padding:20px 28px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr><td bgcolor="#0e5e5b" style="background:#0e5e5b;">
            <a href="${esc(input.payUrl)}" style="display:inline-block;padding:12px 22px;font-family:${EMAIL_FONT};font-size:16px;font-weight:700;line-height:1.2;color:#ffffff;text-decoration:none;">${esc(input.button)}</a>
          </td></tr>
        </table>
      </td></tr>
      ${fee}
      ${check}
      ${note}
      <tr><td style="padding:22px 28px 24px;font-family:${EMAIL_FONT};font-size:13px;line-height:1.5;color:#5d6c74;">
        Questions? Use the Support tab in your portal. This mailbox is not monitored.<br>
        Sent by ${esc(input.associationName)} through My HOA Dashboard.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function detailRow(label: string, value: string, emphasize = false): string {
  const valueStyle = emphasize
    ? `font-family:${EMAIL_FONT};font-size:22px;line-height:1.3;font-weight:700;color:#1b2830;`
    : `font-family:${EMAIL_FONT};font-size:15px;line-height:1.4;color:#1b2830;`;
  return `<tr>
    <td style="padding:10px 14px;width:148px;font-family:${EMAIL_FONT};font-size:14px;line-height:1.4;color:#5d6c74;vertical-align:top;">${esc(label)}</td>
    <td style="padding:10px 14px;${valueStyle}vertical-align:top;">${esc(value)}</td>
  </tr>`;
}

function ownerNoticeHref(slug: string, kind: OwnerNoticeKind, itemId?: string, canonicalBase?: string): string {
  const tail =
    kind === "announcement" && itemId ? `/news/${itemId}` : kind === "event" ? "/calendar" : kind === "account" ? "/notices" : "/documents";
  if (canonicalBase) return `${canonicalBase}${tail}`;
  return `${PORTAL_ORIGIN}/a/${slug}${tail}`;
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
  html?: string;
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
    html?: string;
    reply_to?: string;
    attachments?: { filename: string; content: string; content_type: string }[];
  } = {
    from: options.from,
    to: [options.to],
    subject: options.subject,
    text: options.text,
  };
  if (options.html) payload.html = options.html;
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
