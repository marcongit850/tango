/** Inbox for the product contact form. Kept off the public page. */
export const CONTACT_INBOX = "marc@whpinc.com";

const WINDOW_MS = 10 * 60 * 1000;
const MAX_HITS = 5;
const hits = new Map<string, number[]>();

export type ContactValues = {
  name: string;
  email: string;
  neighborhood: string;
  message: string;
};

export function contactFieldError(input: ContactValues): string {
  if (!input.name.trim()) return "Enter your name.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) return "Enter a valid email.";
  if (!input.message.trim()) return "Enter a message.";
  return "";
}

export function contactSubject(neighborhood: string): string {
  const name = oneLine(neighborhood) || "MyHOADashboard";
  return `MyHOADashboard contact: ${name}`.slice(0, 200);
}

export function contactEmailText(input: ContactValues): string {
  return [
    `Name: ${oneLine(input.name)}`,
    `Email: ${oneLine(input.email)}`,
    `Neighborhood: ${oneLine(input.neighborhood) || "not provided"}`,
    "",
    input.message.trim(),
  ].join("\n");
}

/** Five messages per IP in ten minutes. A restart clears the window. */
export function allowContactRequest(ip: string, now = Date.now()): boolean {
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

export function resetContactRateLimit(): void {
  hits.clear();
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}
