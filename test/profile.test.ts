import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { activeLoginEmails } from "../src/db";
import { emailChangedLetter, emailChangeLetter } from "../src/lib/login-email";
import { uniqueLoginEmails } from "../src/lib/email";
import { sha256Hex } from "../src/lib/tokens";

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
];

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

  async batch(statements: SqliteStatement[]): Promise<{ meta: { changes: number }; results: [] }[]> {
    this.sqlite.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

function openPortal(includeNotices = true): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of MIGRATIONS) {
    if (!includeNotices && file.endsWith("0014_email_preferences.sql")) continue;
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
    .run(`sess_${userId}_${crypto.randomUUID()}`, userId, await sha256Hex(token), "2099-01-01T00:00:00.000Z", "2026-10-06T00:00:00.000Z");
  return token;
}

function post(token: string, body: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: {
      Cookie: `tango_session=${token}`,
      Origin: "http://localhost",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body),
  };
}

function flash(response: Response): string {
  const parts = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  return decodeURIComponent(`${response.headers.get("Set-Cookie") ?? ""};${parts.join(";")}`);
}

function headerAccount(html: string): string {
  const start = html.indexOf('<div class="account">');
  return html.slice(start, html.indexOf("</div>", start));
}

function count(sqlite: DatabaseSync, sql: string, ...params: (string | number)[]): number {
  const row = sqlite.prepare(sql).get(...params) as { n: number };
  return Number(row.n);
}

const sentEmails: { to: string; subject: string; text: string }[] = [];
const originalFetch = globalThis.fetch;

afterEach(() => {
  sentEmails.length = 0;
  globalThis.fetch = originalFetch;
});

function mockResend(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string[]; subject?: string; text?: string };
    sentEmails.push({ to: body.to?.[0] ?? "", subject: body.subject ?? "", text: body.text ?? "" });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
}

describe("email change letters", () => {
  it("confirms at the new address and tells the old address after the change", () => {
    const confirm = emailChangeLetter({
      associationName: "Tango Mar",
      link: "https://mytangomar.com/auth/verify?token=abc",
      minutes: 20,
    });
    expect(confirm.subject).toBe("Confirm your email for Tango Mar");
    expect(confirm.text).toContain("https://mytangomar.com/auth/verify?token=abc");
    expect(confirm.text).toContain("Your login stays the same until you open the link.");
    expect(confirm.text).not.toContain("\u2014");
    expect(confirm.text).not.toContain("\u2013");
    const notice = emailChangedLetter({ associationName: "Tango Mar", newEmail: "sam.new@example.com" });
    expect(notice.text).toContain("sam.new@example.com");
    expect(notice.text).toContain("If you did not ask for this, contact the board.");
    expect(notice.text).not.toContain("\u2014");
    expect(notice.text).not.toContain("\u2013");
  });
});

describe("my profile", () => {
  it("links the signed-in name to the profile and leaves the rest of the header in place", async () => {
    const { sqlite, db } = openPortal();
    try {
      const app = createApp();
      const sam = await signIn(sqlite, "user_sam");
      const page = await app.request("http://localhost/a/tango-mar/dashboard", { headers: { Cookie: `tango_session=${sam}` } }, portalEnv(db));
      expect(page.status).toBe(200);
      const html = await page.text();
      const account = headerAccount(html);
      expect(account).toContain('class="account-name" href="/a/tango-mar/profile">Sam Rivera</a>');
      expect(account).toContain("Log out");
      expect(account).not.toContain("Admin");
      const nav = html.slice(html.indexOf("<nav>"), html.indexOf("</nav>"));
      expect(nav).not.toContain("/profile");
      expect(nav).toContain("Dashboard");
    } finally {
      sqlite.close();
    }
  });

  it("shows name, phone, and mailing address without the lot address or admin notes", async () => {
    const { sqlite, db } = openPortal();
    try {
      sqlite
        .prepare("UPDATE properties SET house_name = ?, admin_notes = ? WHERE id = 'prop_14'")
        .run("Beach House", "SECRET GATE 4412");
      const app = createApp();
      const sam = await signIn(sqlite, "user_sam");
      const page = await app.request("http://localhost/a/tango-mar/profile", { headers: { Cookie: `tango_session=${sam}` } }, portalEnv(db));
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("<h1>My profile</h1>");
      expect(html).toContain('name="name"');
      expect(html).toContain('value="Sam Rivera"');
      expect(html).toContain('value="850-555-0102"');
      expect(html).toContain("sam.rivera@example.com");
      expect(html).toContain("Mailing address for Lot 14, Beach House");
      expect(html).toContain("Add another owner");
      expect(html).toContain('action="/a/tango-mar/profile/lots/prop_14"');
      expect(html).not.toContain("SECRET GATE 4412");
      expect(html).not.toContain("Tang O Mar Drive");
      expect(html).not.toContain("admin_notes");
      expect(html).not.toContain('name="street_address"');
      expect(html).not.toContain("\u2014");
      expect(html).not.toContain("\u2013");
      const loggedOut = await app.request("http://localhost/a/tango-mar/profile", {}, portalEnv(db));
      expect(loggedOut.status).toBe(303);
      expect(loggedOut.headers.get("Location")).toContain("/login");
    } finally {
      sqlite.close();
    }
  });

  it("saves a name without a staff notice, and a phone with a notice and an audit row", async () => {
    const { sqlite, db } = openPortal();
    try {
      const app = createApp();
      const sam = await signIn(sqlite, "user_sam");
      const renamed = await app.request(
        "http://localhost/a/tango-mar/profile",
        post(sam, { name: "Samantha Rivera", phone: "850-555-0102" }),
        portalEnv(db),
      );
      expect(renamed.status).toBe(303);
      expect(flash(renamed)).toContain("Name and phone saved.");
      expect(sqlite.prepare("SELECT name, phone FROM users WHERE id = 'user_sam'").get()).toEqual({
        name: "Samantha Rivera",
        phone: "850-555-0102",
      });
      expect(count(sqlite, "SELECT COUNT(*) AS n FROM notifications WHERE kind = 'profile'")).toBe(0);
      expect(count(sqlite, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'profile_name'")).toBe(1);

      const phoned = await app.request(
        "http://localhost/a/tango-mar/profile",
        post(sam, { name: "Samantha Rivera", phone: "850-555-0199" }),
        portalEnv(db),
      );
      expect(phoned.status).toBe(303);
      expect(sqlite.prepare("SELECT phone FROM users WHERE id = 'user_sam'").get()).toEqual({ phone: "850-555-0199" });
      const notice = sqlite.prepare("SELECT user_id, title, kind FROM notifications WHERE kind = 'profile'").get() as {
        user_id: string;
        title: string;
        kind: string;
      };
      expect(notice).toEqual({ user_id: "user_jordan", title: "Phone number updated", kind: "profile" });
      expect(count(sqlite, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'profile_phone'")).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it("updates mailing address on an owned lot and ignores the lot address and admin notes", async () => {
    const { sqlite, db } = openPortal();
    try {
      sqlite.prepare("UPDATE properties SET admin_notes = ? WHERE id = 'prop_14'").run("SECRET GATE 4412");
      const app = createApp();
      const sam = await signIn(sqlite, "user_sam");
      const saved = await app.request(
        "http://localhost/a/tango-mar/profile/lots/prop_14",
        post(sam, {
          mailing_street: "PO Box 12",
          mailing_city: "Destin",
          mailing_state: "FL",
          mailing_postal_code: "32541",
          street_address: "Hacked street",
          admin_notes: "Hacked notes",
          house_name: "Hacked house",
        }),
        portalEnv(db),
      );
      expect(saved.status).toBe(303);
      expect(flash(saved)).toContain("Mailing address saved.");
      expect(sqlite.prepare("SELECT street_address, house_name, admin_notes, mailing_street, mailing_city, mailing_state, mailing_postal_code FROM properties WHERE id = 'prop_14'").get()).toEqual({
        street_address: "Lot 14, Tang O Mar Drive",
        house_name: "",
        admin_notes: "SECRET GATE 4412",
        mailing_street: "PO Box 12",
        mailing_city: "Destin",
        mailing_state: "FL",
        mailing_postal_code: "32541",
      });
      const notice = sqlite.prepare("SELECT user_id, title FROM notifications WHERE kind = 'profile'").get() as {
        user_id: string;
        title: string;
      };
      expect(notice).toEqual({ user_id: "user_jordan", title: "Mailing address updated" });
      expect(count(sqlite, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'profile_mailing'")).toBe(1);

      const other = await app.request(
        "http://localhost/a/tango-mar/profile/lots/prop_3",
        post(sam, { mailing_street: "Should not save", mailing_city: "", mailing_state: "", mailing_postal_code: "" }),
        portalEnv(db),
      );
      expect(other.status).toBe(303);
      expect(flash(other)).toContain("Choose one of your lots.");
      expect(sqlite.prepare("SELECT mailing_street FROM properties WHERE id = 'prop_3'").get()).toEqual({ mailing_street: "" });
    } finally {
      sqlite.close();
    }
  });

  it("changes the login email only after the confirmation link, then writes to the old address", async () => {
    const { sqlite, db } = openPortal();
    try {
      mockResend();
      const app = createApp();
      const sam = await signIn(sqlite, "user_sam");
      const env = portalEnv(db, "re_test_key");
      const taken = await app.request(
        "http://localhost/a/tango-mar/profile/email",
        post(sam, { email: "casey.nguyen@example.com" }),
        env,
      );
      expect(taken.status).toBe(303);
      expect(flash(taken)).toContain("That email is already used.");
      expect(sentEmails).toHaveLength(0);

      const same = await app.request(
        "http://localhost/a/tango-mar/profile/email",
        post(sam, { email: "Sam.Rivera@example.com" }),
        env,
      );
      expect(same.status).toBe(303);
      expect(flash(same)).toContain("That is already your email.");

      const sent = await app.request(
        "http://localhost/a/tango-mar/profile/email",
        post(sam, { email: "sam.new@example.com" }),
        env,
      );
      expect(sent.status).toBe(303);
      expect(flash(sent)).toContain("Check the new email.");
      expect(sqlite.prepare("SELECT email FROM users WHERE id = 'user_sam'").get()).toEqual({ email: "sam.rivera@example.com" });
      expect(sentEmails).toHaveLength(1);
      expect(sentEmails[0]?.to).toBe("sam.new@example.com");
      const link = sentEmails[0]?.text.match(/http:\/\/localhost\/auth\/verify\?token=[a-f0-9]{64}/)?.[0];
      expect(link).toBeTruthy();

      const confirmed = await app.request(link!, {}, env);
      expect(confirmed.status).toBe(303);
      expect(confirmed.headers.get("Location")).toBe("/a/tango-mar/profile");
      expect(flash(confirmed)).toContain("Your email is updated.");
      expect(sqlite.prepare("SELECT email FROM users WHERE id = 'user_sam'").get()).toEqual({ email: "sam.new@example.com" });
      expect(sentEmails[1]?.to).toBe("sam.rivera@example.com");
      expect(sentEmails[1]?.text).toContain("sam.new@example.com");
      const notice = sqlite.prepare("SELECT user_id, title FROM notifications WHERE kind = 'profile'").get() as {
        user_id: string;
        title: string;
      };
      expect(notice).toEqual({ user_id: "user_jordan", title: "Login email changed" });
      expect(count(sqlite, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'profile_email'")).toBe(1);
      expect(sqlite.prepare("SELECT action, reason, email FROM electronic_notice_consent").get()).toEqual({
        action: "revoked",
        reason: "email_changed",
        email: "sam.new@example.com",
      });

      const again = await app.request("http://localhost/a/tango-mar/profile", { headers: { Cookie: `tango_session=${sam}` } }, env);
      expect(await again.text()).toContain("sam.new@example.com");
    } finally {
      sqlite.close();
    }
  });

  it("shows the confirmation link locally when email is not configured and refuses a taken address at confirm time", async () => {
    const { sqlite, db } = openPortal();
    try {
      const app = createApp();
      const sam = await signIn(sqlite, "user_sam");
      const env = portalEnv(db);
      const sent = await app.request(
        "http://localhost/a/tango-mar/profile/email",
        post(sam, { email: "sam.new@example.com" }),
        env,
      );
      expect(sent.status).toBe(200);
      const html = await sent.text();
      const link = html.match(/href="(http:\/\/localhost\/auth\/verify\?token=[a-f0-9]{64})"/)?.[1];
      expect(link).toBeTruthy();
      expect(sqlite.prepare("SELECT email FROM users WHERE id = 'user_sam'").get()).toEqual({ email: "sam.rivera@example.com" });

      sqlite
        .prepare("INSERT INTO users (id, email, name, phone, created_at) VALUES (?, ?, '', '', ?)")
        .run("user_pat", "sam.new@example.com", "2026-10-07T00:00:00.000Z");
      const blocked = await app.request(link!, {}, env);
      expect(blocked.status).toBe(400);
      expect(await blocked.text()).toContain("Email not changed");
      expect(sqlite.prepare("SELECT email FROM users WHERE id = 'user_sam'").get()).toEqual({ email: "sam.rivera@example.com" });
    } finally {
      sqlite.close();
    }
  });

  it("asks the board to add another owner and does not create the login until approval", async () => {
    const { sqlite, db } = openPortal();
    try {
      sqlite
        .prepare(
          `INSERT INTO properties (id, association_id, lot_number, street_address, city, state, postal_code, status, created_at, lot_type)
           VALUES ('prop_15', 'assoc_tango_mar', '15', 'Lot 15, Tang O Mar Drive', 'Miramar Beach', 'FL', '32550', 'active', '2026-10-06T00:00:00.000Z', 'improved')`,
        )
        .run();
      sqlite
        .prepare(
          `INSERT INTO property_owners (id, association_id, property_id, user_id, is_primary, created_at)
           VALUES ('own_sam_15', 'assoc_tango_mar', 'prop_15', 'user_sam', 1, '2026-10-06T00:00:00.000Z')`,
        )
        .run();
      const app = createApp();
      const sam = await signIn(sqlite, "user_sam");
      const jordan = await signIn(sqlite, "user_jordan");
      const env = portalEnv(db);
      const before = count(sqlite, "SELECT COUNT(*) AS n FROM users");
      const page = await app.request("http://localhost/a/tango-mar/profile", { headers: { Cookie: `tango_session=${sam}` } }, env);
      const html = await page.text();
      expect(html).toContain('name="property_id"');
      expect(html).toContain("Lot 15");
      expect(html).toContain("Lot 14");

      const ownEmail = await app.request(
        "http://localhost/a/tango-mar/profile/owner",
        post(sam, { name: "Sam Again", email: "sam.rivera@example.com", property_id: "prop_14" }),
        env,
      );
      expect(flash(ownEmail)).toContain("Use a different email.");

      const otherLot = await app.request(
        "http://localhost/a/tango-mar/profile/owner",
        post(sam, { name: "Pat Example", email: "pat@example.com", property_id: "prop_3" }),
        env,
      );
      expect(flash(otherLot)).toContain("Choose one of your lots.");

      const requested = await app.request(
        "http://localhost/a/tango-mar/profile/owner",
        post(sam, { name: "Pat Example", email: "Pat@Example.com", property_id: "prop_14" }),
        env,
      );
      expect(requested.status).toBe(303);
      expect(flash(requested)).toContain("Request sent.");
      expect(count(sqlite, "SELECT COUNT(*) AS n FROM users")).toBe(before);
      const request = sqlite
        .prepare("SELECT name, email, address, property_id, status FROM join_requests")
        .get() as { name: string; email: string; address: string; property_id: string; status: string };
      expect(request).toEqual({
        name: "Pat Example",
        email: "pat@example.com",
        address: "Lot 14",
        property_id: "prop_14",
        status: "pending",
      });
      const waiting = sqlite.prepare("SELECT user_id, kind, title FROM notifications WHERE kind = 'join_request'").all() as {
        user_id: string;
        kind: string;
        title: string;
      }[];
      expect(waiting.every((row) => row.user_id === "user_jordan")).toBe(true);
      expect(waiting[0]?.title).toBe("Second owner request for lot 14");
      expect(count(sqlite, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'co_owner_request'")).toBe(1);

      const duplicate = await app.request(
        "http://localhost/a/tango-mar/profile/owner",
        post(sam, { name: "Pat Example", email: "pat@example.com", property_id: "prop_14" }),
        env,
      );
      expect(flash(duplicate)).toContain("A request for that email is already waiting.");

      const requestId = (sqlite.prepare("SELECT id FROM join_requests").get() as { id: string }).id;
      const approved = await app.request(
        `http://localhost/a/tango-mar/admin/join-requests/${requestId}/approve`,
        post(jordan, {}),
        env,
      );
      expect(approved.status).toBe(303);
      expect(flash(approved)).toContain("Added as another owner of lot 14.");
      expect(flash(approved)).toContain("The login is ready, but the welcome email was not sent.");
      const owners = sqlite
        .prepare(
          `SELECT u.email, po.is_primary
           FROM property_owners po
           JOIN users u ON u.id = po.user_id
           WHERE po.property_id = 'prop_14'
           ORDER BY po.is_primary DESC, u.email`,
        )
        .all() as { email: string; is_primary: number }[];
      expect(owners).toEqual([
        { email: "sam.rivera@example.com", is_primary: 1 },
        { email: "pat@example.com", is_primary: 0 },
      ]);
      expect(sqlite.prepare("SELECT status FROM join_requests WHERE id = ?").get(requestId)).toEqual({ status: "approved" });
    } finally {
      sqlite.close();
    }
  });

  it("saves announcement email and an append-only consent log, and skips broadcast email when off", async () => {
    const { sqlite, db } = openPortal();
    try {
      const app = createApp();
      const sam = await signIn(sqlite, "user_sam");
      const jordan = await signIn(sqlite, "user_jordan");
      const env = portalEnv(db);
      const page = await app.request("http://localhost/a/tango-mar/profile", { headers: { Cookie: `tango_session=${sam}` } }, env);
      const html = await page.text();
      expect(html).toContain("Email me portal announcements and updates");
      expect(html).toContain("Electronic Notice Consent");
      expect(html).toContain("I consent to receiving official association notices electronically at this email address.");
      expect(html).toContain("I agree");
      expect(html).toMatch(/name="email_announcements"[^>]*checked/);
      expect(html).not.toMatch(/name="electronic_consent"[^>]*checked/);
      expect(html.indexOf("Save name and phone")).toBeLessThan(html.indexOf("Electronic Notice Consent"));
      expect(html.indexOf("Electronic Notice Consent")).toBeLessThan(html.indexOf("<h2>Email</h2>"));
      expect(html).not.toContain("\u2014");
      expect(html).not.toContain("\u2013");

      const saved = await app.request(
        "http://localhost/a/tango-mar/profile/notices",
        {
          method: "POST",
          headers: {
            Cookie: `tango_session=${sam}`,
            Origin: "http://localhost",
            "Content-Type": "application/x-www-form-urlencoded",
            "CF-Connecting-IP": "203.0.113.10",
            "User-Agent": "ProfileTest",
          },
          body: new URLSearchParams({ electronic_consent: "1" }),
        },
        env,
      );
      expect(saved.status).toBe(303);
      expect(flash(saved)).toContain("Email preferences saved.");
      expect(sqlite.prepare("SELECT email_announcements FROM users WHERE id = 'user_sam'").get()).toEqual({ email_announcements: 0 });
      const granted = sqlite.prepare("SELECT action, email, lots, ip, user_agent, session_id, reason FROM electronic_notice_consent").get() as {
        action: string;
        email: string;
        lots: string;
        ip: string;
        user_agent: string;
        session_id: string;
        reason: string;
      };
      expect(granted.action).toBe("granted");
      expect(granted.email).toBe("sam.rivera@example.com");
      expect(granted.lots).toBe("14");
      expect(granted.ip).toBe("203.0.113.10");
      expect(granted.user_agent).toBe("ProfileTest");
      expect(granted.reason).toBe("");
      expect(granted.session_id.startsWith("sess_user_sam_")).toBe(true);
      expect(count(sqlite, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'profile_announcements'")).toBe(1);
      expect(count(sqlite, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'consent_granted'")).toBe(1);

      const owners = uniqueLoginEmails(await activeLoginEmails(db, "assoc_tango_mar", "owners")).map((row) => row.email);
      expect(owners).not.toContain("sam.rivera@example.com");
      expect(owners).toContain("jordan.lee@example.com");

      mockResend();
      const confirm = await app.request(
        "http://localhost/a/tango-mar/profile/email",
        post(sam, { email: "sam.optout@example.com" }),
        portalEnv(db, "re_test"),
      );
      expect(confirm.status).toBe(303);
      expect(sentEmails[0]?.to).toBe("sam.optout@example.com");
      sentEmails.length = 0;
      const reminder = await app.request(
        "http://localhost/a/tango-mar/admin/owners/user_sam/remind",
        post(jordan, {}),
        portalEnv(db, "re_test"),
      );
      expect(reminder.status).toBe(303);
      expect(sentEmails.some((message) => message.to === "sam.rivera@example.com" && message.subject.includes("balance reminder"))).toBe(true);

      const revoked = await app.request(
        "http://localhost/a/tango-mar/profile/notices",
        post(sam, { email_announcements: "1" }),
        env,
      );
      expect(flash(revoked)).toContain("Email preferences saved.");
      const history = sqlite
        .prepare("SELECT action, reason FROM electronic_notice_consent ORDER BY created_at, id")
        .all() as { action: string; reason: string }[];
      expect(history).toEqual([
        { action: "granted", reason: "" },
        { action: "revoked", reason: "" },
      ]);
      expect(sqlite.prepare("SELECT email_announcements FROM users WHERE id = 'user_sam'").get()).toEqual({ email_announcements: 1 });

      const admin = await app.request(
        "http://localhost/a/tango-mar/admin/owners/user_sam",
        { headers: { Cookie: `tango_session=${jordan}` } },
        env,
      );
      const adminHtml = await admin.text();
      expect(adminHtml).toContain("Current status: Revoked");
      expect(adminHtml).toContain(">On<");
      expect(adminHtml).toContain("Granted");
      expect(adminHtml).toContain("203.0.113.10");
      expect(adminHtml).not.toContain("Delete consent");
      const roster = await app.request("http://localhost/a/tango-mar/admin/owners", { headers: { Cookie: `tango_session=${jordan}` } }, env);
      const rosterHtml = await roster.text();
      const users = rosterHtml.slice(rosterHtml.indexOf('id="logins"'));
      expect(users).toContain(">Consent<");
      expect(users).toContain("Revoked");
      const csv = await app.request("http://localhost/a/tango-mar/admin/consent.csv", { headers: { Cookie: `tango_session=${jordan}` } }, env);
      expect(csv.headers.get("Content-Type")).toContain("text/csv");
      const csvText = await csv.text();
      expect(csvText).toContain("user_id,owner_name,lots,email,action,reason,created_at_utc,ip,user_agent,session_id");
      expect(csvText).toContain("granted");
      expect(csvText).toContain("revoked");
      expect(csvText).toContain("sam.rivera@example.com");
      const homeownerCsv = await app.request("http://localhost/a/tango-mar/admin/consent.csv", { headers: { Cookie: `tango_session=${sam}` } }, env);
      expect(homeownerCsv.status).toBe(403);
    } finally {
      sqlite.close();
    }
  });

  it("still opens My profile before the email preferences migration is applied", async () => {
    const { sqlite, db } = openPortal(false);
    try {
      const app = createApp();
      const sam = await signIn(sqlite, "user_sam");
      const env = portalEnv(db);
      const page = await app.request("http://localhost/a/tango-mar/profile", { headers: { Cookie: `tango_session=${sam}` } }, env);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Email me portal announcements and updates");
      const saved = await app.request("http://localhost/a/tango-mar/profile/notices", post(sam, { email_announcements: "1", electronic_consent: "1" }), env);
      expect(saved.status).toBe(303);
      expect(flash(saved)).toContain("Apply the email preferences migration");
      const owners = uniqueLoginEmails(await activeLoginEmails(db, "assoc_tango_mar", "owners")).map((row) => row.email);
      expect(owners).toContain("sam.rivera@example.com");
    } finally {
      sqlite.close();
    }
  });
});
