import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { resetSupportRateLimit, sendResendEmail, SUPPORT_INBOX, supportEmailText } from "../src/lib/email";
import { sha256Hex } from "../src/lib/tokens";
import type { Association } from "../src/types";
import { adminSupportPage } from "../src/views/admin";
import { siteFooter } from "../src/views/layout";

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

describe("site footer", () => {
  it("uses the shared home footer on every page", () => {
    const html = siteFooter();
    expect(html).toContain('<footer class="home-footer">');
    expect(html).toContain('href="/">Home</a>');
    expect(html).toContain('href="/a/tango-mar/dashboard">Dashboard</a>');
    expect(html).toContain('href="/a/tango-mar/documents">Documents</a>');
    expect(html).toContain('href="/a/tango-mar/faq">FAQs</a>');
    expect(html).toContain('href="/a/tango-mar/messages">Contact</a>');
    expect(html).toContain('href="/a/tango-mar/estoppel">Estoppel Requests</a>');
    expect(html).toContain('href="/bring-this-to-your-hoa">Bring This to Your HOA</a>');
    expect(html).toContain('href="/privacy">Privacy Policy</a>');
    expect(html).toContain('href="/terms">Terms of Use</a>');
    expect(html).toContain("© 2026 Tango Mar Property Owners Association");
    expect(html).toContain("Miramar Beach, Florida");
    expect(html).not.toContain(">Support</a>");
    expect(html).not.toContain("site-footer");
    expect(html).not.toContain("A beach neighborhood in Miramar Beach, Walton County, Florida.");
  });
});

describe("support page", () => {
  it("asks for a type, subject, details, and one attachment", () => {
    const html = adminSupportPage(
      association,
      { name: "Jordan Lee", email: "jordan.lee@example.com" },
      { kind: "feature", subject: "Gate codes", details: "Hello" },
    );
    expect(html).toContain('href="/a/tango-mar/admin">Overview</a>');
    expect(html).toContain('href="/a/tango-mar/admin/support">Support</a>');
    expect(html).toContain('action="/a/tango-mar/admin/support"');
    expect(html).toContain('name="kind"');
    expect(html).toContain('name="subject"');
    expect(html).toContain('name="details"');
    expect(html).toContain('name="file"');
    expect(html).toContain("Feature request");
    expect(html).toContain("Jordan Lee");
    expect(html).toContain("jordan.lee@example.com");
    expect(html).toContain("Hello");
    expect(html).toContain("Send message");
    expect(html).not.toContain(SUPPORT_INBOX);
    expect(html).not.toContain("whpinc");
    expect(html).not.toContain("marc@");
    expect(html).not.toContain("\u2014");
    expect(html).not.toContain("\u2013");
  });
});

describe("support email", () => {
  it("includes the sender name, email, role, page, and time", () => {
    const text = supportEmailText({
      name: "Jordan Lee",
      email: "jordan.lee@example.com",
      role: "Board member, edit access",
      page: "/a/tango-mar/admin/support",
      time: "2026-10-08T02:16:00.000Z",
      message: "The gate code is not working.",
    });
    expect(text).toBe(
      "Name: Jordan Lee\nEmail: jordan.lee@example.com\nRole: Board member, edit access\nPage: /a/tango-mar/admin/support\nTime: 2026-10-08T02:16:00.000Z\n\nThe gate code is not working.",
    );
    expect(SUPPORT_INBOX).toBe("marc@whpinc.com");
  });

  it("sends through Resend and sets reply-to", async () => {
    let payload: unknown;
    const sent = await sendResendEmail({
      apiKey: "test",
      from: "Tango Mar <donotreply@mytangomar.com>",
      to: SUPPORT_INBOX,
      replyTo: "jordan.lee@example.com",
      subject: "[Tango Mar support] Feature request: Gate codes",
      text: supportEmailText({
        name: "Jordan Lee",
        email: "jordan.lee@example.com",
        role: "Board member, edit access",
        page: "/a/tango-mar/admin/support",
        time: "2026-10-08T02:16:00.000Z",
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
      to: ["marc@whpinc.com"],
      subject: "[Tango Mar support] Feature request: Gate codes",
      text: "Name: Jordan Lee\nEmail: jordan.lee@example.com\nRole: Board member, edit access\nPage: /a/tango-mar/admin/support\nTime: 2026-10-08T02:16:00.000Z\n\nThe gate code is not working.",
      reply_to: "jordan.lee@example.com",
    });
  });
});

describe("support access", () => {
  beforeEach(() => {
    resetSupportRateLimit();
  });

  it("shows the admin tab to people who can view admin and emails the inbox", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db, "test-key");
    const token = await signIn(sqlite, "user_sam");
    const jordan = await signIn(sqlite, "user_jordan");
    sqlite
      .prepare("INSERT INTO users (id, email, name, phone, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("user_board", "board.viewer@example.com", "Board Viewer", "", "2026-10-06T00:00:00.000Z");
    sqlite
      .prepare(
        "INSERT INTO memberships (id, association_id, user_id, role_id, is_admin, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("mem_board", "assoc_tango_mar", "user_board", "board", 0, "active", "2026-10-06T00:00:00.000Z");
    const board = await signIn(sqlite, "user_board");
    const calls: { url: string; body: unknown }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response("{}", { status: 200 });
    };

    try {
      const loggedOut = await app.request("http://localhost/a/tango-mar/admin/support", {}, env);
      expect(loggedOut.status).toBe(303);
      expect(loggedOut.headers.get("Location")).toBe("/login?next=%2Fa%2Ftango-mar%2Fadmin%2Fsupport");

      const login = await app.request("http://localhost/login", {}, env);
      const loggedOutLogin = await login.text();
      expect(loggedOutLogin).toContain(siteFooter());
      expect(loggedOutLogin).not.toContain(">Support</a>");

      const residentLogin = await app.request("http://localhost/login", { headers: { Cookie: `tango_session=${token}` } }, env);
      const loginHtml = await residentLogin.text();
      expect(loginHtml).toContain(siteFooter());
      expect(loginHtml).not.toContain(">Support</a>");

      const homeowner = await app.request("http://localhost/a/tango-mar/admin/support", { headers: { Cookie: `tango_session=${token}` } }, env);
      expect(homeowner.status).toBe(403);
      const homeownerFaq = await app.request("http://localhost/a/tango-mar/faq", { headers: { Cookie: `tango_session=${token}` } }, env);
      expect(await homeownerFaq.text()).not.toContain("/admin/support");

      const page = await app.request("http://localhost/a/tango-mar/admin/support", { headers: { Cookie: `tango_session=${jordan}` } }, env);
      expect(page.status).toBe(200);
      const html = await page.text();
      const footer = html.slice(html.indexOf("<footer"));
      const nav = html.slice(html.indexOf("<nav>"), html.indexOf("</nav>"));
      expect(footer).toContain(siteFooter());
      expect(footer).not.toContain(">Support</a>");
      expect(nav).not.toContain("Support");
      expect(html).toContain('href="/a/tango-mar/admin/support">Support</a>');
      expect(html).not.toContain(SUPPORT_INBOX);
      expect(html).not.toContain("whpinc");

      for (const path of ["/privacy", "/terms"]) {
        const legal = await app.request(`http://localhost${path}`, { headers: { Cookie: `tango_session=${token}` } }, env);
        expect(legal.status).toBe(200);
        const legalHtml = await legal.text();
        const legalFooter = legalHtml.slice(legalHtml.indexOf("<footer"));
        expect(legalFooter).toContain(siteFooter());
        expect(legalHtml).toContain(path === "/privacy" ? "<h1>Privacy Policy</h1>" : "<h1>Terms of Use</h1>");
      }
      expect(html).toContain("Jordan Lee");
      expect(html).toContain("jordan.lee@example.com");
      expect(html).toContain('name="details"');

      const empty = await app.request(
        "http://localhost/a/tango-mar/admin/support",
        {
          method: "POST",
          headers: {
            Cookie: `tango_session=${jordan}`,
            Origin: "http://localhost",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: "kind=feature&subject=&details=",
        },
        env,
      );
      expect(empty.status).toBe(400);
      expect(await empty.text()).toContain("Enter a subject.");
      expect(calls).toHaveLength(0);

      const sent = await app.request(
        "http://localhost/a/tango-mar/admin/support",
        {
          method: "POST",
          headers: {
            Cookie: `tango_session=${jordan}`,
            Origin: "http://localhost",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ kind: "feature", subject: "Gate codes", details: "The gate code is not working." }),
        },
        env,
      );
      expect(sent.status).toBe(303);
      expect(sent.headers.get("Location")).toBe("/a/tango-mar/admin/support");
      expect(decodeURIComponent(sent.headers.get("Set-Cookie") ?? "")).toContain("ok:Thanks. Your message was sent.");
      const body = calls[0]?.body as { text: string; subject: string; reply_to: string; to: string[]; from: string };
      expect(calls[0]?.url).toBe("https://api.resend.com/emails");
      expect(body.from).toBe("Tango Mar <donotreply@mytangomar.com>");
      expect(body.to).toEqual(["marc@whpinc.com"]);
      expect(body.reply_to).toBe("jordan.lee@example.com");
      expect(body.subject).toBe("[Tango Mar support] Feature request: Gate codes");
      expect(body.text).toContain("Role: Board member, edit access");
      expect(body.text).toContain("Page: /a/tango-mar/admin/support");
      expect(body.text).toContain("The gate code is not working.");
      const audit = sqlite.prepare("SELECT action, detail, actor_user_id FROM audit_log WHERE action = ?").get("support_request") as {
        action: string;
        detail: string;
        actor_user_id: string;
      };
      expect(audit).toMatchObject({ action: "support_request", detail: "Feature request: Gate codes", actor_user_id: "user_jordan" });

      const viewer = await app.request("http://localhost/a/tango-mar/admin/support", { headers: { Cookie: `tango_session=${board}` } }, env);
      expect(viewer.status).toBe(200);
      expect(await viewer.text()).toContain('href="/a/tango-mar/admin/support">Support</a>');
      calls.length = 0;
      const viewerSent = await app.request(
        "http://localhost/a/tango-mar/admin/support",
        {
          method: "POST",
          headers: {
            Cookie: `tango_session=${board}`,
            Origin: "http://localhost",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ kind: "question", subject: "Hours", details: "When is the office open?" }),
        },
        env,
      );
      expect(viewerSent.status).toBe(303);
      expect(calls[0]?.body).toMatchObject({
        subject: "[Tango Mar support] Question: Hours",
        reply_to: "board.viewer@example.com",
        text: expect.stringContaining("Role: Board member"),
      });

      sqlite.prepare("UPDATE memberships SET is_admin = 1 WHERE user_id = ?").run("user_sam");
      const adminOwner = await app.request("http://localhost/a/tango-mar/admin/support", { headers: { Cookie: `tango_session=${token}` } }, env);
      expect(adminOwner.status).toBe(200);
      expect(await adminOwner.text()).toContain('href="/a/tango-mar/admin/support">Support</a>');
    } finally {
      globalThis.fetch = original;
      sqlite.close();
    }
  });

  it("attaches one file, refuses a second kind of file, and limits repeats", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db, "test-key");
    const jordan = await signIn(sqlite, "user_jordan");
    const calls: { body: { attachments?: { filename: string; content_type: string }[] } }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
      calls.push({ body: JSON.parse(String(args[1]?.body)) });
      return new Response("{}", { status: 200 });
    };
    try {
      const form = new FormData();
      form.set("kind", "issue");
      form.set("subject", "Broken total");
      form.set("details", "The balance looks wrong.");
      form.set("file", new File([Uint8Array.from([1, 2, 3])], "shot.png", { type: "image/png" }));
      const sent = await app.request(
        "http://localhost/a/tango-mar/admin/support",
        { method: "POST", headers: { Cookie: `tango_session=${jordan}`, Origin: "http://localhost" }, body: form },
        env,
      );
      expect(sent.status).toBe(303);
      expect(calls[0]?.body.attachments).toEqual([{ filename: "shot.png", content: "AQID", content_type: "image/png" }]);

      const bad = new FormData();
      bad.set("kind", "issue");
      bad.set("subject", "Zip");
      bad.set("details", "Not allowed.");
      bad.set("file", new File([Uint8Array.from([1])], "notes.zip", { type: "application/zip" }));
      const refused = await app.request(
        "http://localhost/a/tango-mar/admin/support",
        { method: "POST", headers: { Cookie: `tango_session=${jordan}`, Origin: "http://localhost" }, body: bad },
        env,
      );
      expect(refused.status).toBe(400);
      expect(await refused.text()).toContain("Upload a PDF, text file, image, or Word document.");

      for (let i = 0; i < 4; i += 1) {
        const ok = await app.request(
          "http://localhost/a/tango-mar/admin/support",
          {
            method: "POST",
            headers: {
              Cookie: `tango_session=${jordan}`,
              Origin: "http://localhost",
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ kind: "issue", subject: `Again ${i}`, details: "Still broken." }),
          },
          env,
        );
        expect(ok.status).toBe(303);
      }
      const blocked = await app.request(
        "http://localhost/a/tango-mar/admin/support",
        {
          method: "POST",
          headers: {
            Cookie: `tango_session=${jordan}`,
            Origin: "http://localhost",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ kind: "issue", subject: "Too many", details: "Still broken." }),
        },
        env,
      );
      expect(blocked.status).toBe(429);
      expect(await blocked.text()).toContain("Please wait a few minutes, then try again.");
    } finally {
      globalThis.fetch = original;
      sqlite.close();
    }
  });

  it("says the message could not be sent when email is not configured", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const jordan = await signIn(sqlite, "user_jordan");
    const response = await app.request(
      "http://localhost/a/tango-mar/admin/support",
      {
        method: "POST",
        headers: {
          Cookie: `tango_session=${jordan}`,
          Origin: "http://localhost",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ kind: "issue", subject: "Gate", details: "It is stuck." }),
      },
      portalEnv(db, ""),
    );
    expect(response.status).toBe(503);
    const html = await response.text();
    expect(html).toContain("Your message could not be sent. Please try again later.");
    expect(html).not.toContain(SUPPORT_INBOX);
    sqlite.close();
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
      const portal = await app.request("http://localhost/a/tango-mar/profile", { headers: { Cookie: `tango_session=${sam}` } }, env);
      expect(portal.status).toBe(200);
      const portalHtml = await portal.text();
      const adminPortal = await app.request(
        "http://localhost/a/tango-mar/profile",
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
