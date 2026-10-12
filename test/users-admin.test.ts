import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { formatDateTime } from "../src/lib/dates";
import {
  isAdmin,
  isBoardOrAdmin,
  MASTER_ADMIN_EDIT_MESSAGE,
  membershipForSignInRole,
  signInRoleLabel,
  userListGroup,
} from "../src/lib/access";
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

function openPortal(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of MIGRATIONS) sqlite.exec(readFileSync(file, "utf8"));
  return { sqlite, db: new SqliteD1(sqlite) as unknown as D1Database };
}

function portalEnv(db: D1Database): Env {
  return {
    DB: db,
    APP_ENV: "production",
    EMAIL_FROM: "Tang-O-Mar <donotreply@mytangomar.com>",
    DOCUMENTS: {} as R2Bucket,
    RESEND_API_KEY: "",
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

function fold(html: string, userId: string): string {
  const marker = `user-detail-${userId}`;
  const at = html.indexOf(marker);
  const start = html.lastIndexOf("<details", at);
  const end = html.indexOf("</details>", at);
  return html.slice(start, end);
}

function nav(html: string): string {
  const start = html.indexOf('<p class="actions">');
  return html.slice(start, html.indexOf("</p>", start));
}

function usersPanel(html: string): string {
  const start = html.indexOf('id="users"');
  return start === -1 ? html : html.slice(start);
}

describe("sign-in role labels", () => {
  it("derives Owner, Board member, and Admin from the access helpers", () => {
    expect(signInRoleLabel({ role_id: "homeowner", status: "active", is_admin: 0 })).toBe("Owner");
    expect(signInRoleLabel({ role_id: "homeowner", status: "active", is_admin: 1 })).toBe("Admin");
    expect(signInRoleLabel({ role_id: "board", status: "active", is_admin: 0 })).toBe("Board member");
    expect(signInRoleLabel({ role_id: "board", status: "active", is_admin: 1 })).toBe("Board member");
    expect(signInRoleLabel({ role_id: "officer", status: "active", is_admin: 0 })).toBe("Board member");
    expect(membershipForSignInRole("owner")).toEqual({ roleId: "homeowner", isAdmin: false });
    expect(membershipForSignInRole("board")).toEqual({ roleId: "board", isAdmin: false });
    expect(membershipForSignInRole("admin")).toEqual({ roleId: "homeowner", isAdmin: true });
    expect(membershipForSignInRole("officer")).toBeNull();
    expect(signInRoleLabel({ role_id: "homeowner", status: "active", is_admin: membershipForSignInRole("admin")?.isAdmin ? 1 : 0 })).toBe("Admin");
    expect(isAdmin({ role_id: "officer", status: "active", is_admin: 0 })).toBe(true);
    expect(isAdmin({ role_id: "homeowner", status: "active", is_admin: 1 })).toBe(true);
    expect(isBoardOrAdmin({ role_id: "homeowner", status: "active", is_admin: 0 })).toBe(false);
    expect(isBoardOrAdmin({ role_id: "homeowner", status: "active", is_admin: 1 })).toBe(true);
    expect(isBoardOrAdmin({ role_id: "board", status: "active", is_admin: 0 })).toBe(true);
    expect(userListGroup("board")).toBe("board");
    expect(userListGroup("owners")).toBe("owners");
    expect(userListGroup("all")).toBe("all");
    expect(userListGroup(undefined)).toBe("all");
    expect(userListGroup("admin")).toBe("all");
  });
});

describe("admin users page", () => {
  it("lists people who can sign in, with lots, role, edit access, and last sign-in", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    sqlite.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run("2026-04-02T15:30:00.000Z", "user_sam");
    sqlite
      .prepare(
        "INSERT INTO property_owners (id, association_id, property_id, user_id, is_primary, created_at) VALUES (?, ?, ?, ?, 0, ?)",
      )
      .run("own_sam_3", "assoc_tango_mar", "prop_3", "user_sam", "2026-10-02T15:00:00.000Z");
    sqlite
      .prepare("INSERT INTO users (id, email, name, phone, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("user_invited", "invited.person@example.com", "Invited Person", "850-555-0199", "2026-10-07T00:00:00.000Z");
    sqlite
      .prepare(
        "INSERT INTO memberships (id, association_id, user_id, role_id, is_admin, status, created_at) VALUES (?, ?, ?, ?, 0, 'invited', ?)",
      )
      .run("mem_invited", "assoc_tango_mar", "user_invited", "homeowner", "2026-10-07T00:00:00.000Z");
    sqlite
      .prepare("INSERT INTO users (id, email, name, phone, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("user_gone", "gone.person@example.com", "Gone Person", "", "2026-10-07T00:00:00.000Z");
    sqlite
      .prepare(
        "INSERT INTO memberships (id, association_id, user_id, role_id, is_admin, status, created_at) VALUES (?, ?, ?, ?, 0, 'inactive', ?)",
      )
      .run("mem_gone", "assoc_tango_mar", "user_gone", "homeowner", "2026-10-07T00:00:00.000Z");
    sqlite
      .prepare(
        `INSERT INTO associations (id, slug, name, legal_name, address_line1, city, state, postal_code, county, timezone, created_at)
         VALUES ('assoc_other', 'other-shore', 'Other Shore', 'Other Shore', '', '', '', '', '', 'America/Chicago', '2026-10-01T15:00:00Z')`,
      )
      .run();
    sqlite
      .prepare("INSERT INTO users (id, email, name, phone, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("user_other", "other.person@example.com", "Other Person", "", "2026-10-07T00:00:00.000Z");
    sqlite
      .prepare(
        "INSERT INTO memberships (id, association_id, user_id, role_id, is_admin, status, created_at) VALUES (?, ?, ?, ?, 0, 'active', ?)",
      )
      .run("mem_other", "assoc_other", "user_other", "homeowner", "2026-10-07T00:00:00.000Z");
    const jordan = await signIn(sqlite, "user_jordan");

    try {
      const page = await app.request("http://localhost/a/tango-mar/admin/users", { headers: { Cookie: `tango_session=${jordan}` } }, env);
      expect(page.status).toBe(200);
      const html = await page.text();
      const links = nav(html);
      expect(links.indexOf("Owners & lots")).toBeGreaterThan(-1);
      expect(links.indexOf("Owners & lots")).toBeLessThan(links.indexOf(">Users<"));
      expect(links.indexOf(">Users<")).toBeLessThan(links.indexOf("CSV import"));
      expect(html).toContain('<a class="button " href="/a/tango-mar/admin/users">Users</a>');
      expect(html).toContain("<h1>Users</h1>");
      expect(html).toContain('class="active" href="/a/tango-mar/admin/users">All');
      expect(html).toContain('href="/a/tango-mar/admin/users?group=board">Board and admins');
      expect(html).toContain('href="/a/tango-mar/admin/users?group=owners">Owners only');
      expect(html).toContain('placeholder="Name, email, lot, role, or consent"');
      expect(html).toContain('href="/a/tango-mar/admin/consent.csv">Download consent log (CSV)');
      expect(html).toContain('<summary class="button">Add user</summary>');
      expect(html).toContain(">No lot<");
      expect(html).toContain('name="role"');
      expect(html).toContain(">Consent<");
      expect(html).toContain('src="/owners-roster.js"');
      expect(html).toContain('class="user-roster"');
      expect(html).not.toContain("\u2014");
      expect(html).not.toContain("\u2013");

      const sam = fold(html, "user_sam");
      expect(sam).toContain("Sam Rivera");
      expect(sam).toContain("sam.rivera@example.com");
      expect(sam).toContain(">Owner<");
      expect(sam).toContain(">No<");
      expect(sam).toContain(formatDateTime("2026-04-02T15:30:00.000Z", "America/Chicago"));
      expect(sam.indexOf('href="/a/tango-mar/admin/ledger/prop_3">Lot 3')).toBeLessThan(
        sam.indexOf('href="/a/tango-mar/admin/ledger/prop_14">Lot 14'),
      );
      expect(sam).toContain('<span class="lot-kicker">Consent</span>No');
      expect(sam).toContain('data-search="Sam Rivera sam.rivera@example.com Owner No No 3 lot 3 14 lot 14"');
      expect(sam).toContain('action="/a/tango-mar/admin/owners/user_sam/role"');
      expect(sam).toContain('name="is_admin"');
      expect(sam).toContain('name="status" value="active"');
      expect(sam).toContain('name="next" value="/a/tango-mar/admin/users"');
      expect(sam).toContain(">Active<");
      expect(sam).toContain("850-555-0102");

      const jordanFold = fold(html, "user_jordan");
      expect(jordanFold).toContain(">Board member<");
      expect(jordanFold).toContain(">Yes<");
      expect(jordanFold).toContain(">Never<");
      expect(jordanFold).toContain("Master admin");
      expect(jordanFold).toContain("disabled");
      expect(jordanFold).toContain('href="/a/tango-mar/admin/ledger/prop_3">Lot 3');
      expect(jordanFold).not.toContain("Lot 14");

      const invited = fold(html, "user_invited");
      expect(invited).toContain(">Owner<");
      expect(invited).toContain(">Never<");
      expect(invited).toContain(">Invited<");
      expect(invited).toContain(">None<");
      expect(html).not.toContain("Gone Person");
      expect(html).not.toContain("Other Person");

      const owners = await app.request(
        "http://localhost/a/tango-mar/admin/users?group=owners",
        { headers: { Cookie: `tango_session=${jordan}` } },
        env,
      );
      const ownersHtml = await owners.text();
      expect(ownersHtml).toContain('class="active" href="/a/tango-mar/admin/users?group=owners">Owners only');
      const ownersPanel = usersPanel(ownersHtml);
      expect(ownersPanel).toContain("Sam Rivera");
      expect(ownersPanel).toContain("Invited Person");
      expect(ownersPanel).not.toContain("Jordan Lee");
      expect(fold(ownersHtml, "user_sam")).toContain('name="next" value="/a/tango-mar/admin/users?group=owners"');

      const board = await app.request(
        "http://localhost/a/tango-mar/admin/users?group=board",
        { headers: { Cookie: `tango_session=${jordan}` } },
        env,
      );
      const boardHtml = await board.text();
      const boardPanel = usersPanel(boardHtml);
      expect(boardPanel).toContain("Jordan Lee");
      expect(boardPanel).not.toContain("Sam Rivera");
      expect(boardPanel).not.toContain("Casey Nguyen");
      expect(fold(boardHtml, "user_jordan")).toContain('name="next" value="/a/tango-mar/admin/users?group=board"');

      const unknown = await app.request(
        "http://localhost/a/tango-mar/admin/users?group=nope",
        { headers: { Cookie: `tango_session=${jordan}` } },
        env,
      );
      expect(await unknown.text()).toContain("Casey Nguyen");
    } finally {
      sqlite.close();
    }
  });

  it("lets a view-only board member read the page and blocks their writes", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    sqlite
      .prepare("INSERT INTO users (id, email, name, phone, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("user_board", "board.viewer@example.com", "Board Viewer", "", "2026-10-06T00:00:00.000Z");
    sqlite
      .prepare(
        "INSERT INTO memberships (id, association_id, user_id, role_id, is_admin, status, created_at) VALUES (?, ?, ?, ?, 0, 'active', ?)",
      )
      .run("mem_board", "assoc_tango_mar", "user_board", "board", "2026-10-06T00:00:00.000Z");
    const board = await signIn(sqlite, "user_board");
    const sam = await signIn(sqlite, "user_sam");

    try {
      const loggedOut = await app.request("http://localhost/a/tango-mar/admin/users", {}, env);
      expect(loggedOut.status).toBe(303);
      expect(loggedOut.headers.get("Location")).toBe("/login?next=%2Fa%2Ftango-mar%2Fadmin%2Fusers");

      const homeowner = await app.request("http://localhost/a/tango-mar/admin/users", { headers: { Cookie: `tango_session=${sam}` } }, env);
      expect(homeowner.status).toBe(403);

      const page = await app.request("http://localhost/a/tango-mar/admin/users", { headers: { Cookie: `tango_session=${board}` } }, env);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("View only. Edit access is required to create, edit, or delete.");
      expect(html).toContain("Board Viewer");
      expect(fold(html, "user_board")).toContain(">Board member<");
      expect(fold(html, "user_board")).toContain(">No<");
      expect(html).not.toContain("/role");
      expect(html).not.toContain('name="is_admin"');
      expect(html).not.toContain(">Add user<");
      expect(html).not.toContain('name="property_id"');
      expect(html).toContain('href="/a/tango-mar/admin/consent.csv">Download consent log (CSV)');
      expect(fold(html, "user_sam")).toContain(">Active<");
      expect(fold(html, "user_sam")).not.toContain("<form");

      const denied = await app.request(
        "http://localhost/a/tango-mar/admin/owners/user_sam/role",
        post(board, { role_id: "board", status: "active", is_admin: "1", next: "/a/tango-mar/admin/users" }),
        env,
      );
      expect(denied.status).toBe(403);
      const still = sqlite.prepare("SELECT role_id, is_admin FROM memberships WHERE user_id = ?").get("user_sam") as {
        role_id: string;
        is_admin: number;
      };
      expect(still).toEqual({ role_id: "homeowner", is_admin: 0 });

      const deniedAdd = await app.request(
        "http://localhost/a/tango-mar/admin/users",
        post(board, { name: "Nope", email: "nope@example.com", phone: "", role: "board", property_id: "" }),
        env,
      );
      expect(deniedAdd.status).toBe(403);
      expect(sqlite.prepare("SELECT id FROM users WHERE email = 'nope@example.com'").get()).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  it("reuses the role route, including master and last-admin rules", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const jordan = await signIn(sqlite, "user_jordan");

    try {
      const granted = await app.request(
        "http://localhost/a/tango-mar/admin/owners/user_sam/role",
        post(jordan, { role_id: "homeowner", status: "active", is_admin: "1", next: "/a/tango-mar/admin/users" }),
        env,
      );
      expect(granted.status).toBe(303);
      expect(granted.headers.get("Location")).toBe("/a/tango-mar/admin/users");
      expect(flash(granted)).toContain("Role saved.");
      const adminSam = sqlite.prepare("SELECT role_id, is_admin, status FROM memberships WHERE user_id = ?").get("user_sam") as {
        role_id: string;
        is_admin: number;
        status: string;
      };
      expect(adminSam).toEqual({ role_id: "homeowner", is_admin: 1, status: "active" });

      const listed = await app.request("http://localhost/a/tango-mar/admin/users?group=board", { headers: { Cookie: `tango_session=${jordan}` } }, env);
      const listedHtml = await listed.text();
      expect(fold(listedHtml, "user_sam")).toContain(">Admin<");
      expect(fold(listedHtml, "user_sam")).toContain(">Yes<");

      const ownersOnly = await app.request(
        "http://localhost/a/tango-mar/admin/users?group=owners",
        { headers: { Cookie: `tango_session=${jordan}` } },
        env,
      );
      expect(usersPanel(await ownersOnly.text())).not.toContain("Sam Rivera");

      const revoked = await app.request(
        "http://localhost/a/tango-mar/admin/owners/user_sam/role",
        post(jordan, { role_id: "homeowner", status: "active", next: "/a/tango-mar/admin/users?group=board" }),
        env,
      );
      expect(revoked.headers.get("Location")).toBe("/a/tango-mar/admin/users?group=board");
      const plainSam = sqlite.prepare("SELECT is_admin FROM memberships WHERE user_id = ?").get("user_sam") as { is_admin: number };
      expect(plainSam.is_admin).toBe(0);

      const master = await app.request(
        "http://localhost/a/tango-mar/admin/owners/user_jordan/role",
        post(jordan, { role_id: "board", status: "active", next: "/a/tango-mar/admin/users" }),
        env,
      );
      expect(master.status).toBe(303);
      expect(master.headers.get("Location")).toBe("/a/tango-mar/admin/users");
      expect(flash(master)).toContain(MASTER_ADMIN_EDIT_MESSAGE);
      const stillMaster = sqlite.prepare("SELECT is_admin, is_master FROM memberships WHERE user_id = ?").get("user_jordan") as {
        is_admin: number;
        is_master: number;
      };
      expect(stillMaster).toEqual({ is_admin: 1, is_master: 1 });

      sqlite.prepare("UPDATE memberships SET is_master = 0 WHERE user_id = ?").run("user_jordan");
      const lastAdmin = await app.request(
        "http://localhost/a/tango-mar/admin/owners/user_jordan/role",
        post(jordan, { role_id: "board", status: "active", next: "/a/tango-mar/admin/users" }),
        env,
      );
      expect(lastAdmin.headers.get("Location")).toBe("/a/tango-mar/admin/users");
      expect(flash(lastAdmin)).toContain("Keep at least one person with edit access.");
      const kept = sqlite.prepare("SELECT is_admin FROM memberships WHERE user_id = ?").get("user_jordan") as { is_admin: number };
      expect(kept.is_admin).toBe(1);

      const stray = await app.request(
        "http://localhost/a/tango-mar/admin/owners/user_casey/role",
        post(jordan, { role_id: "board", status: "active", is_admin: "0", next: "/a/tango-mar/dashboard" }),
        env,
      );
      expect(stray.headers.get("Location")).toBe("/a/tango-mar/admin/owners/user_casey");
      const casey = sqlite.prepare("SELECT role_id, is_admin FROM memberships WHERE user_id = ?").get("user_casey") as {
        role_id: string;
        is_admin: number;
      };
      expect(casey).toEqual({ role_id: "board", is_admin: 0 });
    } finally {
      sqlite.close();
    }
  });

  it("shows consent wording from the old list and keeps the CSV link", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const revokedAt = "2026-04-02T15:30:00.000Z";
    sqlite
      .prepare(
        `INSERT INTO electronic_notice_consent (
           id, association_id, user_id, owner_name, lots, email, action, reason, ip, user_agent, session_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, '', '', '', '', ?)`,
      )
      .run("consent_sam_old", "assoc_tango_mar", "user_sam", "Sam Rivera", "14", "sam.rivera@example.com", "granted", "2026-04-01T15:30:00.000Z");
    sqlite
      .prepare(
        `INSERT INTO electronic_notice_consent (
           id, association_id, user_id, owner_name, lots, email, action, reason, ip, user_agent, session_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, '', '', '', '', ?)`,
      )
      .run("consent_sam", "assoc_tango_mar", "user_sam", "Sam Rivera", "14", "sam.rivera@example.com", "revoked", revokedAt);
    sqlite
      .prepare(
        `INSERT INTO electronic_notice_consent (
           id, association_id, user_id, owner_name, lots, email, action, reason, ip, user_agent, session_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, '', '', '', '', ?)`,
      )
      .run("consent_jordan", "assoc_tango_mar", "user_jordan", "Jordan Lee", "3", "jordan.lee@example.com", "granted", "2026-04-01T15:30:00.000Z");
    const jordan = await signIn(sqlite, "user_jordan");

    try {
      const page = await app.request("http://localhost/a/tango-mar/admin/users", { headers: { Cookie: `tango_session=${jordan}` } }, env);
      const html = await page.text();
      const revoked = `Revoked ${formatDateTime(revokedAt, "America/Chicago")}`;
      const sam = fold(html, "user_sam");
      expect(sam).toContain(`<span class="lot-kicker">Consent</span>${revoked}`);
      expect(sam).toContain(`data-search="Sam Rivera sam.rivera@example.com Owner No ${revoked} 14 lot 14"`);
      const jordanFold = fold(html, "user_jordan");
      expect(jordanFold).toContain('<span class="lot-kicker">Consent</span>Yes');
      expect(jordanFold).toContain("data-search=");
      expect(jordanFold.slice(jordanFold.indexOf("data-search="), jordanFold.indexOf("data-search=") + 180)).toContain("Yes");
      expect(html).toContain('href="/a/tango-mar/admin/consent.csv">Download consent log (CSV)');
      expect(html).not.toContain("\u2014");
      expect(html).not.toContain("\u2013");

      const owners = await app.request("http://localhost/a/tango-mar/admin/owners", { headers: { Cookie: `tango_session=${jordan}` } }, env);
      const ownersHtml = await owners.text();
      expect(ownersHtml).toContain("<h1>Owners & lots</h1>");
      expect(ownersHtml).not.toContain('id="logins"');
      expect(ownersHtml).not.toContain("<h2>Users</h2>");
      expect(ownersHtml).not.toContain("Download consent log (CSV)");
      expect(ownersHtml).not.toContain("#logins");
    } finally {
      sqlite.close();
    }
  });

  it("adds a user with or without a lot and leaves an existing login unchanged", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const jordan = await signIn(sqlite, "user_jordan");
    const sam = await signIn(sqlite, "user_sam");

    try {
      const board = await app.request(
        "http://localhost/a/tango-mar/admin/users",
        post(jordan, { name: "Pat Lee", email: " Pat.Lee@Example.com ", phone: "850-555-0177", role: "board", property_id: "" }),
        env,
      );
      expect(board.status).toBe(303);
      expect(board.headers.get("Location")).toBe("/a/tango-mar/admin/users");
      expect(flash(board)).toContain("ok:Pat Lee added. They can sign in with a magic link at their email.");
      const pat = sqlite.prepare("SELECT id, name, phone FROM users WHERE email = 'pat.lee@example.com'").get() as {
        id: string;
        name: string;
        phone: string;
      };
      expect(pat).toEqual({ id: pat.id, name: "Pat Lee", phone: "850-555-0177" });
      expect(sqlite.prepare("SELECT role_id, is_admin, is_master, status FROM memberships WHERE user_id = ?").get(pat.id)).toEqual({
        role_id: "board",
        is_admin: 0,
        is_master: 0,
        status: "active",
      });
      expect(sqlite.prepare("SELECT id FROM property_owners WHERE user_id = ?").get(pat.id)).toBeUndefined();
      expect(sqlite.prepare("SELECT id FROM magic_links WHERE email = 'pat.lee@example.com'").get()).toBeUndefined();

      const withLot = await app.request(
        "http://localhost/a/tango-mar/admin/users",
        post(jordan, { name: "Ada Cole", email: "ada.cole@example.com", phone: "", role: "admin", property_id: "prop_14" }),
        env,
      );
      expect(flash(withLot)).toContain("ok:Ada Cole added as an owner of lot 14. They can sign in with a magic link at their email.");
      const ada = sqlite.prepare("SELECT id FROM users WHERE email = 'ada.cole@example.com'").get() as { id: string };
      expect(sqlite.prepare("SELECT role_id, is_admin, status FROM memberships WHERE user_id = ?").get(ada.id)).toEqual({
        role_id: "homeowner",
        is_admin: 1,
        status: "active",
      });
      expect(sqlite.prepare("SELECT property_id, is_primary FROM property_owners WHERE user_id = ?").get(ada.id)).toEqual({
        property_id: "prop_14",
        is_primary: 0,
      });
      expect(sqlite.prepare("SELECT id FROM magic_links WHERE email = 'ada.cole@example.com'").get()).toBeUndefined();

      const owner = await app.request(
        "http://localhost/a/tango-mar/admin/users",
        post(jordan, { name: "Riley Chen", email: "riley.chen@example.com", phone: "", role: "owner", property_id: "" }),
        env,
      );
      expect(flash(owner)).toContain("ok:Riley Chen added. They can sign in with a magic link at their email.");
      const riley = sqlite.prepare("SELECT id FROM users WHERE email = 'riley.chen@example.com'").get() as { id: string };
      expect(sqlite.prepare("SELECT role_id, is_admin FROM memberships WHERE user_id = ?").get(riley.id)).toEqual({
        role_id: "homeowner",
        is_admin: 0,
      });

      const listed = await app.request("http://localhost/a/tango-mar/admin/users", { headers: { Cookie: `tango_session=${jordan}` } }, env);
      const listedHtml = await listed.text();
      expect(fold(listedHtml, pat.id)).toContain(">Board member<");
      expect(fold(listedHtml, pat.id)).toContain(">None<");
      expect(fold(listedHtml, ada.id)).toContain(">Admin<");
      expect(fold(listedHtml, ada.id)).toContain('href="/a/tango-mar/admin/ledger/prop_14">Lot 14');
      expect(fold(listedHtml, riley.id)).toContain(">Owner<");

      const again = await app.request(
        "http://localhost/a/tango-mar/admin/users",
        post(jordan, { name: "Not Sam", email: "SAM.RIVERA@example.com", phone: "850-555-0000", role: "admin", property_id: "" }),
        env,
      );
      expect(flash(again)).toContain("ok:Sam Rivera already has a sign-in.");
      expect(sqlite.prepare("SELECT name, phone FROM users WHERE id = 'user_sam'").get()).toEqual({
        name: "Sam Rivera",
        phone: "850-555-0102",
      });
      expect(sqlite.prepare("SELECT role_id, is_admin FROM memberships WHERE user_id = 'user_sam'").get()).toEqual({
        role_id: "homeowner",
        is_admin: 0,
      });
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'sam.rivera@example.com'").get()).toEqual({ n: 1 });

      const linked = await app.request(
        "http://localhost/a/tango-mar/admin/users",
        post(jordan, { name: "Not Jordan", email: "jordan.lee@example.com", phone: "", role: "owner", property_id: "prop_14" }),
        env,
      );
      expect(flash(linked)).toContain("ok:Jordan Lee added as an owner of lot 14. They can sign in with a magic link at their email.");
      expect(sqlite.prepare("SELECT role_id, is_admin, is_master FROM memberships WHERE user_id = 'user_jordan'").get()).toEqual({
        role_id: "board",
        is_admin: 1,
        is_master: 1,
      });

      const duplicateLot = await app.request(
        "http://localhost/a/tango-mar/admin/users",
        post(jordan, { name: "Sam Rivera", email: "sam.rivera@example.com", phone: "", role: "owner", property_id: "prop_14" }),
        env,
      );
      expect(flash(duplicateLot)).toContain("ok:Sam Rivera is already an owner of lot 14.");

      const badEmail = await app.request(
        "http://localhost/a/tango-mar/admin/users",
        post(jordan, { name: "Nope", email: "not-an-email", phone: "", role: "owner", property_id: "" }),
        env,
      );
      expect(flash(badEmail)).toContain("warn:Enter a valid email.");
      const badLot = await app.request(
        "http://localhost/a/tango-mar/admin/users",
        post(jordan, { name: "Nope", email: "nope-lot@example.com", phone: "", role: "board", property_id: "missing" }),
        env,
      );
      expect(flash(badLot)).toContain("warn:Choose a lot on this association.");
      expect(sqlite.prepare("SELECT id FROM users WHERE email = 'nope-lot@example.com'").get()).toBeUndefined();
      const badRole = await app.request(
        "http://localhost/a/tango-mar/admin/users",
        post(jordan, { name: "Nope", email: "nope-role@example.com", phone: "", role: "officer", property_id: "" }),
        env,
      );
      expect(flash(badRole)).toContain("warn:Choose a valid role.");
      expect(sqlite.prepare("SELECT id FROM users WHERE email = 'nope-role@example.com'").get()).toBeUndefined();

      const resident = await app.request(
        "http://localhost/a/tango-mar/admin/users",
        post(sam, { name: "Nope", email: "resident-add@example.com", phone: "", role: "admin", property_id: "" }),
        env,
      );
      expect(resident.status).toBe(403);
      expect(sqlite.prepare("SELECT id FROM users WHERE email = 'resident-add@example.com'").get()).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });
});
