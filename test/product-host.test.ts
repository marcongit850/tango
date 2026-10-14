import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { canonicalPortalUrl, legacyRedirectTarget, mapLegacyPath } from "../src/lib/hosts";
import { ownerNoticeEmail } from "../src/lib/email";
import { normalizeNeighborhoodCode, normalizeVanitySlug, resetNeighborhoodRateLimit } from "../src/lib/neighborhood";
import { CONTACT_INBOX, resetContactRateLimit } from "../src/lib/contact";

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
  for (const file of ["migrations/0001_schema.sql", "migrations/0002_seed_tango_mar.sql", "migrations/0017_neighborhood_codes.sql"]) {
    sqlite.exec(readFileSync(file, "utf8"));
  }
  return { sqlite, db: new SqliteD1(sqlite) as unknown as D1Database };
}

function portalEnv(db: D1Database, extra: Record<string, string> = {}): Env {
  return {
    DB: db,
    APP_ENV: "production",
    EMAIL_FROM: "Tang-O-Mar <donotreply@mytangomar.com>",
    DOCUMENTS: {} as R2Bucket,
    LEGACY_HOST_REDIRECT: "0",
    PLATFORM_ADMIN_EMAILS: "jordan.lee@example.com",
    ...extra,
  } as Env;
}

const PRODUCT = "https://myhoadashboard.com";

function post(app: ReturnType<typeof createApp>, env: Env, path: string, fields: Record<string, string>, ip = "203.0.113.10") {
  return app.request(
    `${PRODUCT}${path}`,
    {
      method: "POST",
      headers: {
        Origin: PRODUCT,
        "Content-Type": "application/x-www-form-urlencoded",
        "CF-Connecting-IP": ip,
      },
      body: new URLSearchParams(fields),
    },
    env,
  );
}

describe("MyHOADashboard host", () => {
  beforeEach(() => {
    resetNeighborhoodRateLimit();
    resetContactRateLimit();
  });

  it("serves the product page on the product host and keeps Tang-O-Mar on the legacy host", async () => {
    const { db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const product = await app.request(`${PRODUCT}/`, {}, env);
    expect(product.status).toBe(200);
    const html = await product.text();
    expect(html).toContain("MyHOADashboard");
    expect(html).toContain("Enter your neighborhood code");
    expect(html).toContain('href="/demo">See the demo</a>');
    expect(html).toContain('href="#contact">Contact</a>');
    expect(html).toContain('id="contact" class="fields contact-form"');
    expect(html).toContain('src="/brand/myhoadashboard-logo.png"');
    expect(html).toContain('href="/brand/favicon.ico"');
    expect(html).toContain('href="/brand/apple-touch-icon.png"');
    expect(html).toContain('href="/brand/icon-192.png"');
    expect(html).toContain('href="/brand/icon-512.png"');
    expect(html).toContain("Why use us");
    expect(html).toContain("How it works");
    expect(html).toContain('href="/bring-this-to-your-hoa">Bring this to your HOA</a>');
    expect(html).toContain('class="product-band"');
    expect(html).toContain('href="#faq">FAQ</a>');
    expect(html).toContain("How do owners sign in?");
    expect(html).toContain("How are dues paid?");
    expect(html).toContain("How does electronic notice consent work?");
    expect(html).toContain("Enter code");
    expect(html).toContain("Manage your HOA");
    expect(html).toContain("Owner portal");
    expect(html).toContain("Estoppel requests");
    expect(html).toContain("Card numbers are not stored");
    expect(html).toContain("Electronic notice consent");
    expect(html).not.toMatch(/Tang-O-Mar|tango-mar-boardwalk|tango-mar-mark/);
    expect(html).not.toMatch(/\u2013|\u2014/);
    expect(html).not.toMatch(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/);
    expect(html).not.toMatch(/background-image/i);
    const footer = html.slice(html.indexOf('<footer class="product-footer">'));
    expect(footer).not.toContain(">MyHOADashboard</a>");
    expect(footer).toContain('href="/demo">See the demo</a>');
    expect(footer).toContain('href="/bring-this-to-your-hoa">Bring this to your HOA</a>');
    expect(footer).toContain('href="#contact">Contact</a>');
    expect(footer).toContain('href="/privacy">Privacy Policy</a>');
    expect(footer).toContain('href="/terms">Terms of Use</a>');

    const legacy = await app.request("https://mytangomar.com/", {}, env);
    expect(legacy.status).toBe(200);
    const legacyHtml = await legacy.text();
    expect(legacyHtml).toContain("Welcome to Tang-O-Mar");
    expect(legacyHtml).toContain('href="/favicon.ico"');
    expect(legacyHtml).not.toContain("/brand/favicon.ico");

    const www = await app.request("https://www.myhoadashboard.com/", {}, env);
    expect(www.status).toBe(200);
    expect(await www.text()).toContain("Enter your neighborhood code");

    const bring = await app.request(`${PRODUCT}/bring-this-to-your-hoa`, {}, env);
    expect(bring.status).toBe(200);
    const bringHtml = await bring.text();
    expect(bringHtml).toContain("<title>Bring This to Your HOA · MyHOADashboard</title>");
    expect(bringHtml).toContain('class="pitch product-pitch"');
    expect(bringHtml).toContain("The same portal a neighborhood opens after you enter its code.");
    expect(bringHtml).toContain("$99/month");
    expect(bringHtml).not.toContain("you're viewing now");
    expect(bringHtml).not.toContain("tango-mar-logo");
    const bringFooter = bringHtml.slice(bringHtml.indexOf('<footer class="product-footer">'));
    expect(bringFooter).not.toContain(">MyHOADashboard</a>");
    expect(bringFooter).toContain('href="/demo">See the demo</a>');
    expect(bringHtml).not.toMatch(/\u2013|\u2014/);
  });

  it("redirects code 850 to /tangomar and rejects a bad code", async () => {
    const { db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const good = await post(app, env, "/neighborhood", { code: "850" }, "203.0.113.20");
    expect(good.status).toBe(303);
    expect(good.headers.get("Location")).toBe(`${PRODUCT}/tangomar`);

    const bad = await post(app, env, "/neighborhood", { code: "999" }, "203.0.113.21");
    expect(bad.status).toBe(404);
    const html = await bad.text();
    expect(html).toContain("That neighborhood code was not found");
    expect(html).not.toMatch(/\u2013|\u2014/);
  });

  it("rate limits neighborhood code lookups", async () => {
    const { db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    for (let n = 0; n < 8; n += 1) {
      const response = await post(app, env, "/neighborhood", { code: "999" }, "203.0.113.30");
      expect(response.status).toBe(404);
    }
    const blocked = await post(app, env, "/neighborhood", { code: "850" }, "203.0.113.30");
    expect(blocked.status).toBe(429);
    expect(await blocked.text()).toContain("Please wait a few minutes");
  });

  it("maps /tangomar onto Tang-O-Mar login and keeps /a/tango-mar working", async () => {
    const { db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const login = await app.request(`${PRODUCT}/tangomar/login`, {}, env);
    expect(login.status).toBe(200);
    const html = await login.text();
    expect(html).toContain("Sign in to Tang-O-Mar Dashboard");
    expect(html).toContain('action="/tangomar/login"');
    expect(html).toContain('href="/favicon.ico"');
    expect(html).not.toContain("/brand/favicon.ico");

    const landing = await app.request(`${PRODUCT}/tangomar`, {}, env);
    expect(landing.status).toBe(200);
    expect(await landing.text()).toContain("Welcome to Tang-O-Mar");

    const old = await app.request(`${PRODUCT}/a/tango-mar`, {}, env);
    expect(old.status).toBe(302);
    expect(old.headers.get("Location")).toBe("/tangomar");
    const dash = await app.request(`${PRODUCT}/tangomar/dashboard`, {}, env);
    expect(dash.status).toBe(303);
    expect(dash.headers.get("Location")).toBe("/tangomar/login?next=%2Ftangomar%2Fdashboard");
    const legacyDash = await app.request("http://localhost/a/tango-mar/dashboard", {}, env);
    expect(legacyDash.status).toBe(303);
    expect(legacyDash.headers.get("Location")).toContain("/login?next=");
  });

  it("sets a host-only session cookie on the product host", async () => {
    const { db } = openPortal();
    const app = createApp();
    const env = portalEnv(db, { APP_ENV: "development" });
    const posted = await post(app, env, "/tangomar/login", { email: "sam.rivera@example.com", next: "/tangomar/dashboard" });
    expect(posted.status).toBe(200);
    const html = await posted.text();
    const link = html.match(/href="(https:\/\/myhoadashboard\.com\/tangomar\/auth\/verify\?token=[a-f0-9]+)"/);
    expect(link?.[1]).toBeTruthy();
    const verified = await app.request(link?.[1] ?? "", {}, env);
    expect(verified.status).toBe(303);
    const setCookie = verified.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("tango_session=");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie.toLowerCase()).not.toContain("domain=");
    expect(verified.headers.get("Location")).toBe("/tangomar/dashboard");
    const token = setCookie.split("tango_session=")[1]?.split(";")[0] ?? "";
    const dashboard = await app.request(`${PRODUCT}/tangomar/dashboard`, { headers: { Cookie: `tango_session=${token}` } }, env);
    expect(dashboard.status).toBe(200);
    expect(await dashboard.text()).toContain("Tang-O-Mar");
  });

  it("leaves mytangomar.com in place until the redirect flag is on", async () => {
    const { db } = openPortal();
    const app = createApp();
    const off = await app.request("https://mytangomar.com/a/tango-mar/documents?id=1", {}, portalEnv(db));
    expect(off.status).not.toBe(301);

    const on = await app.request(
      "https://www.mytangomar.com/auth/verify?token=abc",
      {},
      portalEnv(db, { LEGACY_HOST_REDIRECT: "1" }),
    );
    expect(on.status).toBe(301);
    expect(on.headers.get("Location")).toBe(`${PRODUCT}/tangomar/auth/verify?token=abc`);

    const doc = await app.request(
      "https://mytangomar.com/a/tango-mar/documents?id=1",
      {},
      portalEnv(db, { LEGACY_HOST_REDIRECT: "1" }),
    );
    expect(doc.status).toBe(301);
    expect(doc.headers.get("Location")).toBe(`${PRODUCT}/tangomar/documents?id=1`);
    expect(mapLegacyPath("/login")).toBe("/tangomar/login");
    expect(legacyRedirectTarget("https://mytangomar.com/")).toBe(`${PRODUCT}/tangomar`);
  });

  it("uses the association canonical base in email links", () => {
    expect(canonicalPortalUrl({ slug: "tango-mar", vanity_slug: "tangomar" }, "/documents")).toBe(`${PRODUCT}/tangomar/documents`);
    expect(canonicalPortalUrl({ slug: "tango-mar", vanity_slug: "tangomar" }, "/invoices")).toBe(`${PRODUCT}/tangomar/invoices`);
    expect(canonicalPortalUrl({ slug: "tango-mar", vanity_slug: "tangomar" }, "/auth/verify?token=abc")).toBe(
      `${PRODUCT}/tangomar/auth/verify?token=abc`,
    );
    expect(canonicalPortalUrl({ slug: "tango-mar", vanity_slug: "" }, "/news/ann-1")).toBe(
      "https://mytangomar.com/a/tango-mar/news/ann-1",
    );
    const letter = ownerNoticeEmail({
      associationName: "Tang-O-Mar",
      slug: "tango-mar",
      kind: "document",
      title: "Covenants",
      summary: "Updated rules.",
      canonicalBase: `${PRODUCT}/tangomar`,
    });
    expect(letter.href).toBe(`${PRODUCT}/tangomar/documents`);
    expect(normalizeNeighborhoodCode("850")).toBe("850");
    expect(normalizeNeighborhoodCode("12")).toBeNull();
    expect(normalizeVanitySlug("tangomar")).toBe("tangomar");
    expect(normalizeVanitySlug("demo")).toBeNull();
  });

  it("lets a platform admin edit the code and slug, and rejects bad values", async () => {
    const { sqlite, db } = openPortal();
    sqlite.exec(
      "INSERT INTO associations (id, slug, name, legal_name) VALUES ('assoc_other', 'other-shore', 'Other Shore', 'Other Shore HOA')",
    );
    const app = createApp();
    const env = portalEnv(db, { APP_ENV: "development" });
    const posted = await post(app, env, "/tangomar/login", { email: "jordan.lee@example.com" });
    const html = await posted.text();
    const link = html.match(/href="(https:\/\/myhoadashboard\.com\/tangomar\/auth\/verify\?token=[a-f0-9]+)"/);
    const verified = await app.request(link?.[1] ?? "", {}, env);
    const token = (verified.headers.get("set-cookie") ?? "").split("tango_session=")[1]?.split(";")[0] ?? "";
    const cookie = { Cookie: `tango_session=${token}`, Origin: PRODUCT, "Content-Type": "application/x-www-form-urlencoded" };

    const page = await app.request(`${PRODUCT}/platform/associations`, { headers: { Cookie: cookie.Cookie } }, env);
    expect(page.status).toBe(200);
    const adminHtml = await page.text();
    expect(adminHtml).toContain("Neighborhood code");
    expect(adminHtml).toContain("value=\"850\"");
    expect(adminHtml).toContain("value=\"tangomar\"");

    const reserved = await app.request(
      `${PRODUCT}/platform/associations/assoc_other`,
      { method: "POST", headers: cookie, body: new URLSearchParams({ neighborhood_code: "222", vanity_slug: "demo" }) },
      env,
    );
    expect(reserved.status).toBe(400);
    expect(await reserved.text()).toContain("reserved");

    const duplicate = await app.request(
      `${PRODUCT}/platform/associations/assoc_other`,
      { method: "POST", headers: cookie, body: new URLSearchParams({ neighborhood_code: "850", vanity_slug: "other-shore" }) },
      env,
    );
    expect(duplicate.status).toBe(409);

    const saved = await app.request(
      `${PRODUCT}/platform/associations/assoc_other`,
      { method: "POST", headers: cookie, body: new URLSearchParams({ neighborhood_code: "222", vanity_slug: "othershore" }) },
      env,
    );
    expect(saved.status).toBe(303);
    const found = await post(app, env, "/neighborhood", { code: "222" }, "203.0.113.40");
    expect(found.status).toBe(303);
    expect(found.headers.get("Location")).toBe(`${PRODUCT}/othershore`);
  });

  it("sends the contact form without showing an email address", async () => {
    const { db } = openPortal();
    const app = createApp();
    const env = portalEnv(db, { RESEND_API_KEY: "re_test" });
    const calls: { body: Record<string, unknown> }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      calls.push({ body: JSON.parse(String(init?.body)) });
      return new Response("{}", { status: 200 });
    };
    try {
      const sent = await post(app, env, "/contact", {
        name: "Pat Lee",
        email: "pat@example.com",
        neighborhood: "Gulf Pines",
        message: "Please tell me about the portal.",
      });
      expect(sent.status).toBe(303);
      expect(calls[0]?.body.to).toEqual([CONTACT_INBOX]);
      const again = await app.request(`${PRODUCT}/?sent=1#contact`, {}, env);
      const sentHtml = await again.text();
      expect(sentHtml).toContain("Your message was sent.");
      expect(sentHtml).toContain('id="contact" class="fields contact-form open"');
      expect(sentHtml).not.toContain(CONTACT_INBOX);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("points each association logo at that association, and the dashboard when signed in", async () => {
    const { sqlite, db } = openPortal();
    sqlite.exec(
      "INSERT INTO associations (id, slug, name, legal_name, neighborhood_code, vanity_slug) VALUES ('assoc_other', 'other-shore', 'Other Shore', 'Other Shore HOA', '222', 'othershore')",
    );
    const app = createApp();
    const env = portalEnv(db, { APP_ENV: "development" });

    const login = await app.request(`${PRODUCT}/tangomar/login`, {}, env);
    expect(login.status).toBe(200);
    const loginHtml = await login.text();
    expect(loginHtml).toContain('<a class="brand" href="/tangomar">');
    expect(loginHtml).toContain('<a class="home-footer-brand" href="/tangomar">');
    expect(loginHtml).toContain('href="/tangomar">Home</a>');
    expect(loginHtml).not.toContain('<a class="brand" href="/">');

    const other = await app.request(`${PRODUCT}/othershore/login`, {}, env);
    expect(other.status).toBe(200);
    expect(await other.text()).toContain('<a class="brand" href="/othershore">');

    const posted = await post(app, env, "/tangomar/login", { email: "sam.rivera@example.com" });
    const link = (await posted.text()).match(/href="(https:\/\/myhoadashboard\.com\/tangomar\/auth\/verify\?token=[a-f0-9]+)"/);
    const verified = await app.request(link?.[1] ?? "", {}, env);
    const token = (verified.headers.get("set-cookie") ?? "").split("tango_session=")[1]?.split(";")[0] ?? "";
    const dashboard = await app.request(`${PRODUCT}/tangomar/dashboard`, { headers: { Cookie: `tango_session=${token}` } }, env);
    expect(dashboard.status).toBe(200);
    const dashHtml = await dashboard.text();
    expect(dashHtml).toContain('<a class="brand" href="/tangomar/dashboard">');
    expect(dashHtml).not.toContain('<a class="brand" href="/">');
  });

  it("still accepts a magic link that was emailed on mytangomar.com", async () => {
    const { db } = openPortal();
    const app = createApp();
    const env = portalEnv(db, { APP_ENV: "development", LEGACY_HOST_REDIRECT: "1" });
    const posted = await post(app, env, "/tangomar/login", { email: "sam.rivera@example.com" });
    const token = ((await posted.text()).match(/token=([a-f0-9]{64})/) ?? [])[1] ?? "";
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const legacy = await app.request(`https://www.mytangomar.com/auth/verify?token=${token}`, {}, env);
    expect(legacy.status).toBe(301);
    expect(legacy.headers.get("Location")).toBe(`${PRODUCT}/tangomar/auth/verify?token=${token}`);
    const verified = await app.request(legacy.headers.get("Location") ?? "", {}, env);
    expect(verified.status).toBe(303);
    expect(verified.headers.get("set-cookie") ?? "").toContain("tango_session=");
  });
});
