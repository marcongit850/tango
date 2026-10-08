import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { DEMO_INBOX, resetDemoRateLimit } from "../src/lib/demo-request";

const PATH = "/bring-this-to-your-hoa";

function demoEnv(apiKey = "re_test"): Env {
  return {
    APP_ENV: "production",
    EMAIL_FROM: "Tango Mar <donotreply@mytangomar.com>",
    RESEND_API_KEY: apiKey,
  } as unknown as Env;
}

function validFields(intent = "demo"): Record<string, string> {
  return {
    intent,
    name: "Pat Lee",
    email: "Pat@Example.com",
    hoa: "Cedar Court HOA",
    phone: "555-0100",
    homes: "42",
    message: "Please show us the portal.",
  };
}

function postDemo(app: ReturnType<typeof createApp>, env: Env, fields: Record<string, string>, ip = "203.0.113.10") {
  return app.request(
    `http://localhost${PATH}`,
    {
      method: "POST",
      headers: {
        Origin: "http://localhost",
        "Content-Type": "application/x-www-form-urlencoded",
        "CF-Connecting-IP": ip,
      },
      body: new URLSearchParams(fields),
    },
    env,
  );
}

describe("demo request", () => {
  beforeEach(() => {
    resetDemoRateLimit();
  });

  it("emails the inbox from the verified sender and hides that address on the page", async () => {
    const app = createApp();
    const env = demoEnv();
    const calls: { url: string; body: unknown }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response("{}", { status: 200 });
    };
    try {
      const page = await app.request(`http://localhost${PATH}`, {}, env);
      const pageHtml = await page.text();
      expect(pageHtml).not.toContain(DEMO_INBOX);
      expect(pageHtml).not.toContain("whpinc");

      const sent = await postDemo(app, env, validFields());
      expect(sent.status).toBe(303);
      expect(sent.headers.get("Location")).toBe(`${PATH}?sent=1#demo-form`);
      expect(calls).toEqual([
        {
          url: "https://api.resend.com/emails",
          body: {
            from: "Tango Mar <donotreply@mytangomar.com>",
            to: [DEMO_INBOX],
            reply_to: "pat@example.com",
            subject: "Demo request: Cedar Court HOA",
            text: "Request: Demo\nName: Pat Lee\nEmail: pat@example.com\nHOA: Cedar Court HOA\nPhone: 555-0100\nHomes: 42\n\nPlease show us the portal.",
          },
        },
      ]);

      for (const [intent, subject, kind] of [
        ["pricing", "Pricing request: Cedar Court HOA", "Pricing"],
        ["setup", "Schedule a demo: Cedar Court HOA", "Schedule a demo"],
      ] as const) {
        calls.length = 0;
        const response = await postDemo(app, env, validFields(intent), `203.0.113.${intent === "pricing" ? "11" : "12"}`);
        expect(response.status).toBe(303);
        expect(calls[0]?.body).toMatchObject({ subject, text: expect.stringContaining(`Request: ${kind}`) });
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  it("keeps invalid fields on the page and does not email", async () => {
    const app = createApp();
    const env = demoEnv();
    const calls: unknown[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
      calls.push(JSON.parse(String(args[1]?.body)));
      return new Response("{}", { status: 200 });
    };
    try {
      const response = await postDemo(app, env, { ...validFields(), email: "not-an-email" });
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Enter a valid email.");
      expect(html).toContain('value="Pat Lee"');
      expect(html).not.toContain(DEMO_INBOX);
      expect(calls).toHaveLength(0);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("treats a filled honeypot as sent and does not email", async () => {
    const app = createApp();
    const env = demoEnv();
    let called = false;
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      called = true;
      return new Response("{}", { status: 200 });
    };
    try {
      const response = await postDemo(app, env, { ...validFields(), company: "Acme" });
      expect(response.status).toBe(303);
      expect(response.headers.get("Location")).toBe(`${PATH}?sent=1#demo-form`);
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("says the request could not be sent when email is not configured", async () => {
    const app = createApp();
    const response = await postDemo(app, demoEnv(""), validFields());
    expect(response.status).toBe(503);
    const html = await response.text();
    expect(html).toContain("Your request could not be sent. Please try again later.");
    expect(html).not.toContain(DEMO_INBOX);
    expect(html).not.toContain("whpinc");
  });

  it("limits repeated requests from the same address", async () => {
    const app = createApp();
    const env = demoEnv();
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response("{}", { status: 200 });
    try {
      for (let i = 0; i < 5; i += 1) {
        const ok = await postDemo(app, env, { ...validFields(), email: "not-an-email" });
        expect(ok.status).toBe(400);
      }
      for (let i = 0; i < 5; i += 1) {
        const ok = await postDemo(app, env, validFields());
        expect(ok.status).toBe(303);
      }
      const blocked = await postDemo(app, env, validFields());
      expect(blocked.status).toBe(429);
      expect(await blocked.text()).toContain("Please wait a few minutes, then try again.");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("opens the form for the clicked request and thanks the visitor after send", async () => {
    const app = createApp();
    const env = demoEnv();
    const pricing = await app.request(`http://localhost${PATH}?intent=pricing`, {}, env);
    expect(await pricing.text()).toContain('<input type="hidden" name="intent" value="pricing">');

    const thanks = await app.request(`http://localhost${PATH}?sent=1`, {}, env);
    const html = await thanks.text();
    expect(html).toContain("Thanks. Your request was sent. We will reply by email.");
    expect(html).not.toContain('name="message"');
    expect(html).not.toContain(DEMO_INBOX);
  });
});
