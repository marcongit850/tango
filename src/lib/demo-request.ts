/** Inbox for Bring This to Your HOA requests. Kept off the public page. */
export const DEMO_INBOX = "marc@whpinc.com";

export type DemoIntent = "demo" | "pricing" | "setup";

export type DemoFormValues = {
  intent: string;
  name: string;
  email: string;
  hoa: string;
  phone: string;
  homes: string;
  message: string;
};

const WINDOW_MS = 10 * 60 * 1000;
const MAX_HITS = 5;
const hits = new Map<string, number[]>();

export function parseDemoIntent(value: string): DemoIntent | null {
  if (value === "demo" || value === "pricing" || value === "setup") return value;
  return null;
}

export function demoSubject(intent: DemoIntent, hoa: string): string {
  const name = oneLine(hoa) || "HOA";
  const prefix = intent === "pricing" ? "Pricing request" : intent === "setup" ? "Schedule a demo" : "Demo request";
  return `${prefix}: ${name}`.slice(0, 200);
}

export function demoEmailText(input: DemoFormValues & { intent: DemoIntent }): string {
  const kind = input.intent === "pricing" ? "Pricing" : input.intent === "setup" ? "Schedule a demo" : "Demo";
  return [
    `Request: ${kind}`,
    `Name: ${oneLine(input.name)}`,
    `Email: ${oneLine(input.email)}`,
    `HOA: ${oneLine(input.hoa)}`,
    `Phone: ${oneLine(input.phone) || "not provided"}`,
    `Homes: ${oneLine(input.homes) || "not provided"}`,
    "",
    input.message.trim(),
  ].join("\n");
}

export function demoFieldError(input: DemoFormValues): string {
  if (!parseDemoIntent(input.intent)) return "Choose a request.";
  if (!input.name) return "Enter your name.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) return "Enter a valid email.";
  if (!input.hoa) return "Enter the HOA or community name.";
  if (input.homes && !/^\d{1,6}$/.test(input.homes)) return "Enter the number of homes as a whole number, or leave it blank.";
  if (!input.message) return "Enter a message.";
  return "";
}

/**
 * Five requests per IP in ten minutes. The window lives in this isolate, the same way a Worker
 * keeps short-lived memory, so a restart clears it. No database table is involved.
 */
export function allowDemoRequest(ip: string, now = Date.now()): boolean {
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

export function resetDemoRateLimit(): void {
  hits.clear();
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}
