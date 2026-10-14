import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { DEMO_BANNER, DEMO_WRITE_MESSAGE } from "../src/lib/demo";
import { sha256Hex } from "../src/lib/tokens";
import { homePage } from "../src/views/public";

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

const MIGRATIONS = [
  "migrations/0001_schema.sql",
  "migrations/0002_seed_tango_mar.sql",
  "migrations/0003_join_requests.sql",
  "migrations/0004_join_request_approved.sql",
  "migrations/0005_admin_improvements.sql",
  "migrations/0006_notice_attachments.sql",
  "migrations/0007_message_reviewed.sql",
  "migrations/0008_document_folders.sql",
  "migrations/0009_master_admin.sql",
  "migrations/0010_document_date.sql",
  "migrations/0011_lot_details.sql",
  "migrations/0012_message_attachments.sql",
  "migrations/0013_co_owner_request.sql",
  "migrations/0014_email_preferences.sql",
  "migrations/0015_rename_display_name.sql",
  "migrations/0016_seed_seaside_demo.sql",
];

function openPortal(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of MIGRATIONS) sqlite.exec(readFileSync(file, "utf8"));
  return { sqlite, db: new SqliteD1(sqlite) as unknown as D1Database };
}

function portalEnv(db: D1Database, apiKey = "re_test"): Env {
  return {
    DB: db,
    APP_ENV: "production",
    EMAIL_FROM: "Tang-O-Mar <donotreply@mytangomar.com>",
    DOCUMENTS: {
      get() {
        throw new Error("demo touched R2 get");
      },
      put() {
        throw new Error("demo touched R2 put");
      },
      head() {
        throw new Error("demo touched R2 head");
      },
      delete() {
        throw new Error("demo touched R2 delete");
      },
    },
    RESEND_API_KEY: apiKey,
  } as unknown as Env;
}

function count(sqlite: DatabaseSync, sql: string, ...params: (string | number)[]): number {
  const row = sqlite.prepare(sql).get(...params) as { n: number };
  return Number(row.n);
}

function snapshot(sqlite: DatabaseSync): Record<string, number | string> {
  return {
    demoAnnouncements: count(sqlite, "SELECT COUNT(*) AS n FROM announcements WHERE association_id = 'assoc_seaside_demo'"),
    realAnnouncements: count(sqlite, "SELECT COUNT(*) AS n FROM announcements WHERE association_id = 'assoc_tango_mar'"),
    demoAudits: count(sqlite, "SELECT COUNT(*) AS n FROM audit_log WHERE association_id = 'assoc_seaside_demo'"),
    realAudits: count(sqlite, "SELECT COUNT(*) AS n FROM audit_log WHERE association_id = 'assoc_tango_mar'"),
    demoPayments: count(sqlite, "SELECT COUNT(*) AS n FROM payments WHERE association_id = 'assoc_seaside_demo'"),
    magicLinks: count(sqlite, "SELECT COUNT(*) AS n FROM magic_links"),
    ownerName: (sqlite.prepare("SELECT name FROM users WHERE id = 'user_demo_owner'").get() as { name: string }).name,
    realName: (sqlite.prepare("SELECT name FROM users WHERE email = 'jordan.lee@example.com'").get() as { name: string }).name,
  };
}

function cookiePair(response: Response, name: string): string {
  const listed = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  const parts = listed.length > 0 ? listed : [response.headers.get("set-cookie") ?? ""];
  const found = parts.find((part) => part.startsWith(`${name}=`));
  return found ? found.split(";")[0] : "";
}

async function signIn(sqlite: DatabaseSync, userId: string): Promise<string> {
  const token = `session-${userId}`;
  sqlite
    .prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(`sess_${userId}`, userId, await sha256Hex(token), "2099-01-01T00:00:00.000Z", "2026-10-06T00:00:00.000Z");
  return token;
}

describe("public demo", () => {
  let sqlite: DatabaseSync;
  let env: Env;
  const calls: string[] = [];

  beforeEach(() => {
    const opened = openPortal();
    sqlite = opened.sqlite;
    env = portalEnv(opened.db);
    calls.length = 0;
  });

  it("links Try the demo from the public home page", async () => {
    const html = homePage(false);
    expect(html).toContain('class="home-try"');
    expect(html).toContain('href="/demo">Try the demo</a>');
    expect(html).toContain("Welcome to Tang-O-Mar");
    expect(html).not.toContain("\u2014");
    expect(html).not.toContain("\u2013");

    const app = createApp();
    const home = await app.request("http://localhost/", {}, env);
    expect(home.status).toBe(200);
    const homeHtml = await home.text();
    expect(homeHtml).toContain('href="/demo">Try the demo</a>');
    expect(homeHtml).toContain("Resident login");
    expect(homeHtml).not.toContain(DEMO_BANNER);
  });

  it("shows the demo banner on the owner dashboard and the board admin view", async () => {
    const app = createApp();
    const enter = await app.request("http://localhost/demo", {}, env);
    expect(enter.status).toBe(303);
    expect(enter.headers.get("Location")).toBe("/a/seaside-demo/dashboard");
    const ownerCookie = cookiePair(enter, "tango_demo");
    expect(ownerCookie).toContain("owner");

    const owner = await app.request("http://localhost/a/seaside-demo/dashboard", { headers: { Cookie: ownerCookie } }, env);
    expect(owner.status).toBe(200);
    const ownerHtml = await owner.text();
    expect(ownerHtml).toContain(DEMO_BANNER);
    expect(ownerHtml).toContain("View as Owner");
    expect(ownerHtml).toContain("View as Board admin");
    expect(ownerHtml).toContain("Seaside Demo HOA");
    expect(ownerHtml).toContain("Riley Coast");
    expect(ownerHtml).toContain("Sample pool hours");
    expect(ownerHtml).toContain("$300.00");
    expect(ownerHtml).not.toContain("jordan.lee@example.com");
    expect(ownerHtml).not.toContain("Casey Nguyen");
    expect(ownerHtml).not.toContain("31 Tang O Mar Drive");
    expect(ownerHtml).not.toContain("Beach walkway washdown");
    expect(ownerHtml).not.toContain("\u2014");
    expect(ownerHtml).not.toContain("\u2013");
    expect(ownerHtml).toContain("Leave demo");
    expect(ownerHtml).not.toContain(">Log out<");

    const adminEnter = await app.request("http://localhost/demo/admin", {}, env);
    const adminCookie = cookiePair(adminEnter, "tango_demo");
    const admin = await app.request("http://localhost/a/seaside-demo/admin", { headers: { Cookie: adminCookie } }, env);
    expect(admin.status).toBe(200);
    const adminHtml = await admin.text();
    expect(adminHtml).toContain(DEMO_BANNER);
    expect(adminHtml).toContain("Quinn Harbor");
    expect(adminHtml).toContain("Board admin");
    expect(adminHtml).toContain("$1,225.00");
    expect(adminHtml).toContain('href="/demo/owner">View as Owner</a>');
    expect(adminHtml).not.toContain("jordan.lee@example.com");
    expect(adminHtml).not.toContain("Casey Nguyen");
    expect(adminHtml).not.toContain("\u2014");
    expect(adminHtml).not.toContain("\u2013");

    const owners = await app.request("http://localhost/a/seaside-demo/admin/owners", { headers: { Cookie: adminCookie } }, env);
    expect(owners.status).toBe(200);
    const ownersHtml = await owners.text();
    expect(ownersHtml).toContain(DEMO_BANNER);
    expect(ownersHtml).toContain("Alex Marsh");
    expect(ownersHtml).toContain("12 Dune Lane");
    expect(ownersHtml).not.toContain("jordan.lee@example.com");
    expect(ownersHtml).not.toContain("Tang O Mar Drive");
  });

  it("blocks demo writes, including email, and leaves both associations unchanged", async () => {
    const app = createApp();
    const before = snapshot(sqlite);
    const original = globalThis.fetch;
    globalThis.fetch = async (input) => {
      calls.push(String(input));
      return new Response("{}", { status: 200 });
    };
    try {
      const blocked = await app.request(
        "http://localhost/a/seaside-demo/admin/announcements",
        {
          method: "POST",
          headers: {
            Cookie: "tango_demo=admin",
            Origin: "http://localhost",
            Referer: "http://localhost/a/seaside-demo/admin/news",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ kind: "news", title: "Should not save", body: "Nope" }),
        },
        env,
      );
      expect(blocked.status).toBe(303);
      expect(blocked.headers.get("Location")).toBe("/a/seaside-demo/admin/news");
      const flash = cookiePair(blocked, "tango_flash");
      expect(decodeURIComponent(flash)).toContain(DEMO_WRITE_MESSAGE);

      const page = await app.request(
        "http://localhost/a/seaside-demo/admin/news",
        { headers: { Cookie: `tango_demo=admin; ${flash}` } },
        env,
      );
      const pageHtml = await page.text();
      expect(pageHtml).toContain(DEMO_BANNER);
      expect(pageHtml).toContain(DEMO_WRITE_MESSAGE);
      expect(pageHtml).not.toContain("Should not save");

      const profile = await app.request(
        "http://localhost/a/seaside-demo/profile",
        {
          method: "POST",
          headers: {
            Cookie: "tango_demo=owner",
            Origin: "http://localhost",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ name: "Hacker", phone: "555-0199" }),
        },
        env,
      );
      expect(profile.status).toBe(303);
      expect(decodeURIComponent(cookiePair(profile, "tango_flash"))).toContain(DEMO_WRITE_MESSAGE);

      const support = await app.request(
        "http://localhost/a/seaside-demo/admin/support",
        {
          method: "POST",
          headers: {
            Cookie: "tango_demo=admin",
            Origin: "http://localhost",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ kind: "issue", subject: "Gate", details: "Please email this." }),
        },
        env,
      );
      expect(support.status).toBe(303);
      expect(decodeURIComponent(cookiePair(support, "tango_flash"))).toContain(DEMO_WRITE_MESSAGE);

      const estoppel = await app.request(
        "http://localhost/a/seaside-demo/estoppel",
        {
          method: "POST",
          headers: {
            Cookie: "tango_demo=owner",
            Origin: "http://localhost",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            name: "Pat Lee",
            email: "pat@example.com",
            phone: "555-0100",
            property: "12 Dune Lane",
            owners: "Riley Coast",
          }),
        },
        env,
      );
      expect(estoppel.status).toBe(303);

      const removed = await app.request("http://localhost/a/seaside-demo/admin/announcements/ann_demo_pool", {
        method: "DELETE",
        headers: { Cookie: "tango_demo=admin" },
      }, env);
      expect(removed.status).toBe(303);
      const replaced = await app.request("http://localhost/a/seaside-demo/profile", {
        method: "PUT",
        headers: { Cookie: "tango_demo=owner" },
      }, env);
      expect(replaced.status).toBe(303);

      const login = await app.request(
        "http://localhost/login",
        {
          method: "POST",
          headers: {
            Cookie: "tango_demo=owner",
            Origin: "http://localhost",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ email: "riley.coast@example.com" }),
        },
        env,
      );
      expect(login.status).toBe(200);
    } finally {
      globalThis.fetch = original;
    }

    expect(calls).toEqual([]);
    expect(snapshot(sqlite)).toEqual(before);
  });

  it("does not let a demo session open the real association", async () => {
    const app = createApp();
    const demoAdmin = await signIn(sqlite, "user_demo_admin");
    const jordan = await signIn(sqlite, "user_jordan");

    const byCookie = await app.request("http://localhost/a/tango-mar/admin", { headers: { Cookie: "tango_demo=admin" } }, env);
    expect(byCookie.status).toBe(303);
    expect(byCookie.headers.get("Location")).toContain("/login");

    const bySession = await app.request(
      "http://localhost/a/tango-mar/admin",
      { headers: { Cookie: `tango_session=${demoAdmin}` } },
      env,
    );
    expect(bySession.status).toBe(303);
    expect(bySession.headers.get("Location")).toContain("/login");

    const real = await app.request(
      "http://localhost/a/tango-mar/dashboard",
      { headers: { Cookie: `tango_session=${jordan}; tango_demo=admin` } },
      env,
    );
    expect(real.status).toBe(200);
    const realHtml = await real.text();
    expect(realHtml).toContain("Jordan Lee");
    expect(realHtml).toContain("Tang-O-Mar");
    expect(realHtml).not.toContain(DEMO_BANNER);
    expect(realHtml).not.toContain("Seaside Demo HOA");

    const crossed = await app.request(
      "http://localhost/a/seaside-demo/dashboard",
      { headers: { Cookie: `tango_session=${jordan}` } },
      env,
    );
    expect(crossed.status).toBe(200);
    const crossedHtml = await crossed.text();
    expect(crossedHtml).toContain(DEMO_BANNER);
    expect(crossedHtml).toContain("Riley Coast");
    expect(crossedHtml).not.toContain("Jordan Lee");
    expect(crossedHtml).not.toContain("jordan.lee@example.com");

    const file = await app.request(
      "http://localhost/a/seaside-demo/documents/doc_demo_covenants/file",
      { headers: { Cookie: "tango_demo=owner" } },
      env,
    );
    expect(file.status).toBe(200);
    const text = await file.text();
    expect(text).toContain("Seaside Demo HOA");
    expect(text).not.toContain("Tang O Mar Drive");
    expect(text).not.toContain("\u2014");
    expect(text).not.toContain("\u2013");
  });
});
