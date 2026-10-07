import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { sendResendEmail, SUPPORT_INBOX, supportEmailText } from "../src/lib/email";
import { sha256Hex } from "../src/lib/tokens";
import type { Association } from "../src/types";
import { siteFooter } from "../src/views/layout";
import { supportPage } from "../src/views/resident";

const association: Association = {
  id: "assoc_tango_mar",
  slug: "tango-mar",
  name: "Tango Mar",
  legal_name: "Tango Mar Property Owners Association",
  address_line1: "31 Tang O Mar Drive",
  city: "Miramar Beach",
  state: "FL",
  postal_code: "32550",
  county: "Walton County",
  timezone: "America/Chicago",
};

class SqliteStatement {
  constructor(
    private readonly sqlite: DatabaseSync,
    private readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.sqlite, this.sql, values);
  }

  async first<T>(): Promise<T | null> {
    const row = this.sqlite.prepare(this.sql).get(...(this.params as (string | number | null | bigint)[]));
    return (row as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    const rows = this.sqlite.prepare(this.sql).all(...(this.params as (string | number | null | bigint)[]));
    return { results: rows as T[] };
  }

  async run(): Promise<{ meta: { changes: number }; results: [] }> {
    const info = this.sqlite.prepare(this.sql).run(...(this.params as (string | number | null | bigint)[]));
    return { meta: { changes: Number(info.changes) }, results: [] };
  }
}

class SqliteD1 {
  constructor(private readonly sqlite: DatabaseSync) {}

  prepare(query: string): SqliteStatement {
    return new SqliteStatement(this.sqlite, query);
  }
}

function openPortal(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of [
    "migrations/0001_schema.sql",
    "migrations/0002_seed_tango_mar.sql",
    "migrations/0003_join_requests.sql",
    "migrations/0004_join_request_approved.sql",
    "migrations/0005_admin_improvements.sql",
  ]) {
    sqlite.exec(readFileSync(file, "utf8"));
  }
  return { sqlite, db: new SqliteD1(sqlite) as unknown as D1Database };
}

function portalEnv(db: D1Database, apiKey = ""): Env {
  return {
    DB: db,
    APP_ENV: "production",
    EMAIL_FROM: "Tango Mar <donotreply@mytangomar.com>",
    DOCUMENTS: {} as R2Bucket,
    RESEND_API_KEY: apiKey,
  } as Env;
}

async function signIn(sqlite: DatabaseSync, userId: string): Promise<string> {
  const token = `session-${userId}`;
  sqlite
    .prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(`sess_${userId}`, userId, await sha256Hex(token), "2099-01-01T00:00:00.000Z", "2026-10-06T00:00:00.000Z");
  return token;
}

const legalFooterLinks = '<a href="/privacy">Privacy Policy</a><a href="/terms">Terms of Use</a>';

describe("support footer", () => {
  it("uses a Support link and leaves out the association name", () => {
    const html = siteFooter("/a/tango-mar/support");
    expect(html).toBe(
      `<footer class="site-footer wrap"><p class="footer-links"><a href="/a/tango-mar/support">Support</a>${legalFooterLinks}</p></footer>`,
    );
    expect(html).not.toContain("Tango Mar");
    expect(html).not.toContain("Property Owners Association");
    expect(siteFooter("")).toBe(`<footer class="site-footer wrap"><p class="footer-links">${legalFooterLinks}</p></footer>`);
    expect(siteFooter("")).not.toContain("Support");
  });
});

describe("support page", () => {
  it("asks the signed-in resident for a message", () => {
    const html = supportPage(association, { name: "Sam Rivera", email: "sam.rivera@example.com" }, "Hello");
    expect(html).toContain('action="/a/tango-mar/support"');
    expect(html).toContain('name="body"');
    expect(html).toContain("Sam Rivera");
    expect(html).toContain("sam.rivera@example.com");
    expect(html).toContain("Hello");
    expect(html).toContain("Send message");
    expect(html).not.toContain(SUPPORT_INBOX);
    expect(html).not.toContain("\u2014");
    expect(html).not.toContain("\u2013");
  });
});

describe("support email", () => {
  it("includes the sender name, email, and message", () => {
    const text = supportEmailText({
      name: "Sam Rivera",
      email: "sam.rivera@example.com",
      message: "The gate code is not working.",
    });
    expect(text).toBe("Name: Sam Rivera\nEmail: sam.rivera@example.com\n\nThe gate code is not working.");
    expect(SUPPORT_INBOX).toBe("352marc@gmail.com");
  });

  it("sends through Resend and sets reply-to", async () => {
    let payload: unknown;
    const sent = await sendResendEmail({
      apiKey: "test",
      from: "Tango Mar <donotreply@mytangomar.com>",
      to: SUPPORT_INBOX,
      replyTo: "sam.rivera@example.com",
      subject: "Support message from Sam Rivera",
      text: supportEmailText({
        name: "Sam Rivera",
        email: "sam.rivera@example.com",
        message: "The gate code is not working.",
      }),
      fetchImpl: async (_url, init) => {
        payload = JSON.parse(String(init?.body));
        return new Response("{}", { status: 200 });
      },
    });
    expect(sent).toBe(true);
    expect(payload).toEqual({
      from: "Tango Mar <donotreply@mytangomar.com>",
      to: ["352marc@gmail.com"],
      subject: "Support message from Sam Rivera",
      text: "Name: Sam Rivera\nEmail: sam.rivera@example.com\n\nThe gate code is not working.",
      reply_to: "sam.rivera@example.com",
    });
  });
});

describe("support access", () => {
  it("hides Support from logged-out visitors and emails the inbox for a resident", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db, "test-key");
    const token = await signIn(sqlite, "user_sam");
    const calls: { url: string; body: unknown }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response("{}", { status: 200 });
    };

    try {
      const loggedOut = await app.request("http://localhost/a/tango-mar/support", {}, env);
      expect(loggedOut.status).toBe(303);
      expect(loggedOut.headers.get("Location")).toBe("/login?next=%2Fa%2Ftango-mar%2Fsupport");

      const login = await app.request("http://localhost/login", {}, env);
      const loggedOutLogin = await login.text();
      expect(loggedOutLogin).toContain(`<footer class="site-footer wrap"><p class="footer-links">${legalFooterLinks}</p></footer>`);
      expect(loggedOutLogin).not.toContain(">Support</a>");

      const residentLogin = await app.request("http://localhost/login", { headers: { Cookie: `tango_session=${token}` } }, env);
      const loginHtml = await residentLogin.text();
      expect(loginHtml).toContain(
        `<footer class="site-footer wrap"><p class="footer-links"><a href="/a/tango-mar/support">Support</a>${legalFooterLinks}</p></footer>`,
      );

      const page = await app.request("http://localhost/a/tango-mar/support", { headers: { Cookie: `tango_session=${token}` } }, env);
      expect(page.status).toBe(200);
      const html = await page.text();
      const footer = html.slice(html.indexOf("<footer"));
      const nav = html.slice(html.indexOf("<nav>"), html.indexOf("</nav>"));
      expect(footer).toContain('href="/a/tango-mar/support">Support</a>');
      expect(footer).toContain('href="/privacy">Privacy Policy</a>');
      expect(footer).toContain('href="/terms">Terms of Use</a>');
      expect(footer).not.toContain("Tango Mar");
      expect(nav).not.toContain("Support");

      for (const path of ["/privacy", "/terms"]) {
        const legal = await app.request(`http://localhost${path}`, { headers: { Cookie: `tango_session=${token}` } }, env);
        expect(legal.status).toBe(200);
        const legalHtml = await legal.text();
        const legalFooter = legalHtml.slice(legalHtml.indexOf("<footer"));
        expect(legalFooter).toContain('href="/a/tango-mar/support">Support</a>');
        expect(legalFooter).toContain(legalFooterLinks);
        expect(legalHtml).toContain(path === "/privacy" ? "<h1>Privacy Policy</h1>" : "<h1>Terms of Use</h1>");
      }
      expect(html).toContain("Sam Rivera");
      expect(html).toContain("sam.rivera@example.com");
      expect(html).toContain('name="body"');

      const empty = await app.request(
        "http://localhost/a/tango-mar/support",
        {
          method: "POST",
          headers: {
            Cookie: `tango_session=${token}`,
            Origin: "http://localhost",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: "body=",
        },
        env,
      );
      expect(empty.status).toBe(400);
      expect(await empty.text()).toContain("Write a message before sending.");
      expect(calls).toHaveLength(0);

      const sent = await app.request(
        "http://localhost/a/tango-mar/support",
        {
          method: "POST",
          headers: {
            Cookie: `tango_session=${token}`,
            Origin: "http://localhost",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ body: "The gate code is not working." }),
        },
        env,
      );
      expect(sent.status).toBe(303);
      expect(sent.headers.get("Location")).toBe("/a/tango-mar/support");
      expect(decodeURIComponent(sent.headers.get("Set-Cookie") ?? "")).toContain("ok:Your message was sent.");
      expect(calls).toEqual([
        {
          url: "https://api.resend.com/emails",
          body: {
            from: "Tango Mar <donotreply@mytangomar.com>",
            to: ["352marc@gmail.com"],
            reply_to: "sam.rivera@example.com",
            subject: "Support message from Sam Rivera",
            text: "Name: Sam Rivera\nEmail: sam.rivera@example.com\n\nThe gate code is not working.",
          },
        },
      ]);
    } finally {
      globalThis.fetch = original;
      sqlite.close();
    }
  });
});

function headerPart(html: string, start: string, end: string): string {
  const header = html.slice(html.indexOf('<header class="site-header">'), html.indexOf("</header>"));
  return header.slice(header.indexOf(start), header.indexOf(end, header.indexOf(start)));
}

function headerNav(html: string): string {
  return headerPart(html, "<nav>", "</nav>");
}

function headerAccount(html: string): string {
  return headerPart(html, '<div class="account">', "</div>");
}

describe("privacy and terms header", () => {
  it("uses the signed-in portal header for members and the public header otherwise", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const sam = await signIn(sqlite, "user_sam");
    const jordan = await signIn(sqlite, "user_jordan");
    sqlite
      .prepare("INSERT INTO users (id, email, name, phone, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("user_guest", "guest@example.com", "Guest Visitor", "", "2026-10-06T00:00:00.000Z");
    const guest = await signIn(sqlite, "user_guest");

    try {
      const portal = await app.request("http://localhost/a/tango-mar/support", { headers: { Cookie: `tango_session=${sam}` } }, env);
      expect(portal.status).toBe(200);
      const portalHtml = await portal.text();
      const adminPortal = await app.request(
        "http://localhost/a/tango-mar/support",
        { headers: { Cookie: `tango_session=${jordan}` } },
        env,
      );
      expect(adminPortal.status).toBe(200);
      const adminPortalHtml = await adminPortal.text();

      for (const path of ["/privacy", "/terms"]) {
        const loggedOut = await app.request(`http://localhost${path}`, {}, env);
        const loggedOutHtml = await loggedOut.text();
        expect(headerNav(loggedOutHtml)).toContain('href="/">Home</a>');
        expect(headerNav(loggedOutHtml)).toContain("Resident login");
        expect(headerNav(loggedOutHtml)).not.toContain("Dashboard");
        expect(loggedOutHtml).toContain('<div class="account"></div>');

        const member = await app.request(`http://localhost${path}`, { headers: { Cookie: `tango_session=${sam}` } }, env);
        expect(member.status).toBe(200);
        const memberHtml = await member.text();
        expect(headerNav(memberHtml)).toBe(headerNav(portalHtml));
        expect(headerAccount(memberHtml)).toBe(headerAccount(portalHtml));
        expect(headerNav(memberHtml)).toContain('href="/a/tango-mar/dashboard">Dashboard</a>');
        expect(headerNav(memberHtml)).toContain('href="/a/tango-mar/documents">Documents</a>');
        expect(headerNav(memberHtml)).toContain('href="/a/tango-mar/news">News</a>');
        expect(headerNav(memberHtml)).toContain('href="/a/tango-mar/calendar">Calendar</a>');
        expect(headerNav(memberHtml)).toContain('href="/a/tango-mar/faq">FAQ</a>');
        expect(headerNav(memberHtml)).toContain('href="/a/tango-mar/board">Board</a>');
        expect(headerNav(memberHtml)).toContain('href="/a/tango-mar/messages">Messages</a>');
        expect(headerNav(memberHtml)).toContain('href="/a/tango-mar/notices">Notices from the Board</a>');
        expect(headerNav(memberHtml)).not.toContain(">Home</a>");
        expect(headerAccount(memberHtml)).toContain("Sam Rivera");
        expect(headerAccount(memberHtml)).toContain("Log out");
        expect(headerAccount(memberHtml)).not.toContain("Admin");
        expect(memberHtml).toContain('<header class="site-header">');
        expect(memberHtml).toContain(path === "/privacy" ? "<h1>Privacy Policy</h1>" : "<h1>Terms of Use</h1>");

        const admin = await app.request(`http://localhost${path}`, { headers: { Cookie: `tango_session=${jordan}` } }, env);
        const adminHtml = await admin.text();
        expect(headerNav(adminHtml)).toBe(headerNav(adminPortalHtml));
        expect(headerAccount(adminHtml)).toBe(headerAccount(adminPortalHtml));
        expect(headerAccount(adminHtml)).toContain('class="account-admin" href="/a/tango-mar/admin">Admin</a>');
        expect(headerAccount(adminHtml).indexOf(">Admin</a>")).toBeLessThan(headerAccount(adminHtml).indexOf("Jordan Lee"));

        const stranger = await app.request(`http://localhost${path}`, { headers: { Cookie: `tango_session=${guest}` } }, env);
        const strangerHtml = await stranger.text();
        expect(headerNav(strangerHtml)).toContain('href="/">Home</a>');
        expect(headerNav(strangerHtml)).toContain("Resident login");
        expect(headerNav(strangerHtml)).not.toContain("Dashboard");
        expect(headerAccount(strangerHtml)).toContain("Guest Visitor");
        expect(headerAccount(strangerHtml)).toContain("Log out");
      }

      const login = await app.request("http://localhost/login", { headers: { Cookie: `tango_session=${sam}` } }, env);
      const loginNav = headerNav(await login.text());
      expect(loginNav).toContain("Resident login");
      expect(loginNav).not.toContain("Dashboard");

      sqlite.prepare("UPDATE memberships SET status = 'inactive' WHERE user_id = ?").run("user_sam");
      const inactive = await app.request("http://localhost/privacy", { headers: { Cookie: `tango_session=${sam}` } }, env);
      const inactiveNav = headerNav(await inactive.text());
      expect(inactiveNav).toContain('href="/">Home</a>');
      expect(inactiveNav).not.toContain("Dashboard");
    } finally {
      sqlite.close();
    }
  });
});
