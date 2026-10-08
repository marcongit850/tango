import { isIsoDate } from "./dates";

/** Inbox for estoppel certificate requests. Kept off the public page. */
export const ESTOPPEL_INBOX = "marc@whpinc.com";

/** Official text of section 720.30851 on Online Sunshine. */
export const ESTOPPEL_STATUTE_URL =
  "https://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0700-0799/0720/Sections/0720.30851.html";

const WINDOW_MS = 10 * 60 * 1000;
const MAX_HITS = 5;
const hits = new Map<string, number[]>();

export type EstoppelFormValues = {
  name: string;
  company: string;
  email: string;
  phone: string;
  property: string;
  owners: string;
  closingDate: string;
  notes: string;
};

/**
 * Recipient for an estoppel request. Pass a future per-association address here.
 * A blank or invalid value falls back to ESTOPPEL_INBOX.
 */
export function estoppelRecipient(configured?: string | null): string {
  const email = (configured ?? "").trim().toLowerCase();
  if (email && validEmail(email)) return email;
  return ESTOPPEL_INBOX;
}

export function estoppelSubject(property: string): string {
  const place = oneLine(property) || "property";
  return `Estoppel request: ${place}`.slice(0, 200);
}

export function estoppelEmailText(input: EstoppelFormValues & { submittedAt: string }): string {
  return [
    `Name: ${oneLine(input.name)}`,
    `Company: ${oneLine(input.company) || "not provided"}`,
    `Email: ${oneLine(input.email)}`,
    `Phone: ${oneLine(input.phone)}`,
    `Property or lot: ${oneLine(input.property)}`,
    `Owner names: ${oneLine(input.owners)}`,
    `Anticipated closing date: ${oneLine(input.closingDate) || "not provided"}`,
    `Notes: ${input.notes.trim() || "not provided"}`,
    `Time: ${oneLine(input.submittedAt)}`,
  ].join("\n");
}

export function estoppelFieldError(input: EstoppelFormValues): string {
  if (!input.name) return "Enter your name.";
  if (!validEmail(input.email)) return "Enter a valid email.";
  if (!input.phone) return "Enter a phone number.";
  if (!input.property) return "Enter the property address or lot number.";
  if (!input.owners) return "Enter the owner name or names.";
  if (input.closingDate && !isIsoDate(input.closingDate)) return "Enter the closing date as a date, or leave it blank.";
  return "";
}

/**
 * Five requests per IP in ten minutes. The window lives in this isolate, the same way a Worker
 * keeps short-lived memory, so a restart clears it. No database table is involved.
 */
export function allowEstoppelRequest(ip: string, now = Date.now()): boolean {
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

export function resetEstoppelRateLimit(): void {
  hits.clear();
}

function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}
