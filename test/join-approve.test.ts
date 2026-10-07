import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { isCheckConstraint } from "../src/lib/errors";
import { changeLoginEmail } from "../src/lib/login-email";
import { sha256Hex } from "../src/lib/tokens";
import {
  approvalSummary,
  approveJoinRequest,
  planLotLink,
  planMembership,
  planUserName,
  welcomeEmail,
  type LotCandidate,
} from "../src/lib/join-approve";
import {
  countPendingJoinRequests,
  declineJoinRequest,
  deleteJoinRequest,
  joinRequestNoticeHref,
  joinRequestNoticeTitle,
  listJoinRequests,
  notificationsForUser,
  retireLegacyJoinNotices,
  reviewJoinRequest,
  unreadCount,
} from "../src/db";
import type { Association } from "../src/types";
import { adminHome, joinRequestsPage, ownersPage } from "../src/views/admin";
import { dashboardPage, noticesPage } from "../src/views/resident";

const ASSOCIATION = "assoc_tango_mar";

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

function openPortal(includeApproval = true): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of ["migrations/0001_schema.sql", "migrations/0002_seed_tango_mar.sql", "migrations/0003_join_requests.sql"]) {
    sqlite.exec(readFileSync(file, "utf8"));
  }
  if (includeApproval) {
    sqlite.exec(readFileSync("migrations/0004_join_request_approved.sql", "utf8"));
    sqlite.exec(readFileSync("migrations/0005_admin_improvements.sql", "utf8"));
  }
  return { sqlite, db: new SqliteD1(sqlite) as unknown as D1Database };
}

function insertRequest(
  sqlite: DatabaseSync,
  row: { id: string; name: string; email: string; address?: string; status?: string },
): void {
  sqlite
    .prepare(
      `INSERT INTO join_requests (id, association_id, name, email, address, note, status, created_at)
       VALUES (?, ?, ?, ?, ?, '', ?, '2026-10-06T12:00:00Z')`,
    )
    .run(row.id, ASSOCIATION, row.name, row.email, row.address ?? "", row.status ?? "pending");
}

function openPortalWithoutJoinTable(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of ["migrations/0001_schema.sql", "migrations/0002_seed_tango_mar.sql"]) {
    sqlite.exec(readFileSync(file, "utf8"));
  }
  return { sqlite, db: new SqliteD1(sqlite) as unknown as D1Database };
}

function insertNotice(
  sqlite: DatabaseSync,
  row: { id: string; kind: string; title: string; body: string; href: string; userId?: string },
): void {
  sqlite
    .prepare(
      `INSERT INTO notifications (id, association_id, user_id, kind, title, body, href, read_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, '2026-10-06T12:00:00Z')`,
    )
    .run(row.id, ASSOCIATION, row.userId ?? "user_jordan", row.kind, row.title, row.body, row.href);
}

function count(sqlite: DatabaseSync, sql: string, ...params: (string | number)[]): number {
  const row = sqlite.prepare(sql).get(...params) as { n: number };
  return Number(row.n);
}

const lot = (id: string, lotNumber: string, streetAddress: string, ownerCount: number, ownedByUser = false): LotCandidate => ({
  id,
  lotNumber,
  streetAddress,
  ownerCount,
  ownedByUser,
});

describe("join approval planning", () => {
  it("links one empty lot and leaves ambiguous or occupied lots alone", () => {
    const properties = [
      lot("p14", "14", "Lot 14, Tang O Mar Drive", 1),
      lot("p99", "99", "99 Tang O Mar Drive", 0),
      lot("p100", "100", "Shared House", 0),
      lot("p101", "101", "Shared House", 0),
    ];
    expect(planLotLink("  Lot #99 ", properties)).toEqual({ kind: "link", propertyId: "p99", lotNumber: "99" });
    expect(planLotLink("99 Tang O Mar Drive", properties)).toEqual({ kind: "link", propertyId: "p99", lotNumber: "99" });
    expect(planLotLink("", properties)).toEqual({ kind: "skip", reason: "blank" });
    expect(planLotLink("no such place", properties)).toEqual({ kind: "skip", reason: "none" });
    expect(planLotLink("Shared House", properties)).toEqual({ kind: "skip", reason: "ambiguous" });
    expect(planLotLink("14", properties)).toEqual({ kind: "skip", reason: "occupied", lotNumber: "14" });
    expect(planLotLink("14", [{ ...properties[0], ownedByUser: true }])).toEqual({
      kind: "already",
      propertyId: "p14",
      lotNumber: "14",
    });
  });

  it("reuses a name and keeps an active staff role", () => {
    expect(planUserName("Sam Rivera", "Someone Else")).toBe("Sam Rivera");
    expect(planUserName("  ", "Pat Example")).toBe("Pat Example");
    expect(planUserName(null, "Pat Example")).toBe("Pat Example");
    expect(planMembership(null)).toEqual({ roleId: "homeowner", isAdmin: 0 });
    expect(planMembership({ role_id: "homeowner", status: "inactive" })).toEqual({ roleId: "homeowner", isAdmin: 0 });
    expect(planMembership({ role_id: "officer", status: "active" })).toEqual({ roleId: "board", isAdmin: 1 });
    expect(planMembership({ role_id: "board", status: "active", is_admin: 1 })).toEqual({ roleId: "board", isAdmin: 1 });
    expect(planMembership({ role_id: "board", status: "active", is_admin: 0 })).toEqual({ roleId: "board", isAdmin: 0 });
    expect(planMembership({ role_id: "officer", status: "inactive" })).toEqual({ roleId: "homeowner", isAdmin: 0 });
  });

  it("tells the person to use resident login and does not include a magic link", () => {
    const letter = welcomeEmail({ associationName: "Tango Mar", email: "pat@example.com", name: "Pat Example" });
    expect(letter.subject).toBe("You are approved for Tango Mar");
    expect(letter.text).toContain("https://mytangomar.com/login");
    expect(letter.text).toContain("https://mytangomar.com");
    expect(letter.text).toContain("pat@example.com");
    expect(letter.text).toContain("send you a link to log in");
    expect(letter.text).not.toContain("/auth/verify");
    expect(letter.text).not.toContain("token=");
    expect(letter.text).not.toContain("\u2014");
    const summary = approvalSummary({
      createdUser: true,
      roleId: "homeowner",
      lot: { kind: "linked", lotNumber: "99" },
      emailSent: false,
    });
    expect(summary).toContain("Homeowner login created.");
    expect(summary).toContain("The login is ready, but the welcome email was not sent.");
    expect(summary).not.toContain("\u2014");
    expect(
      approvalSummary({
        createdUser: false,
        roleId: "homeowner",
        lot: { kind: "skipped", reason: "blank" },
        emailSent: true,
      }),
    ).toContain("Existing login reused.");
  });
});

describe("approve join request", () => {
  it("rejects approved status until the migration is applied, without creating a login", async () => {
    const { sqlite, db } = openPortal(false);
    insertRequest(sqlite, { id: "jr-early", name: "Pat Example", email: "pat@example.com", address: "99" });
    const before = count(sqlite, "SELECT COUNT(*) AS n FROM users");
    await expect(approveJoinRequest(db, { associationId: ASSOCIATION, requestId: "jr-early" })).rejects.toSatisfy(isCheckConstraint);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM users")).toBe(before);
    expect(sqlite.prepare("SELECT status FROM join_requests WHERE id = 'jr-early'").get()).toEqual({ status: "pending" });
    sqlite.exec(readFileSync("migrations/0004_join_request_approved.sql", "utf8"));
    expect(sqlite.prepare("SELECT name, status FROM join_requests WHERE id = 'jr-early'").get()).toEqual({
      name: "Pat Example",
      status: "pending",
    });
    const result = await approveJoinRequest(db, { associationId: ASSOCIATION, requestId: "jr-early" });
    expect(result).toMatchObject({ ok: true, createdUser: true, roleId: "homeowner" });
    sqlite.close();
  });

  it("creates a homeowner login and links an unoccupied lot", async () => {
    const { sqlite, db } = openPortal();
    sqlite
      .prepare(
        `INSERT INTO properties (id, association_id, lot_number, street_address, city, state, postal_code, status, created_at)
         VALUES ('prop_99', ?, '99', '99 Tang O Mar Drive', 'Miramar Beach', 'FL', '32550', 'active', '2026-10-06T00:00:00Z')`,
      )
      .run(ASSOCIATION);
    insertRequest(sqlite, { id: "jr-pat", name: "Pat Example", email: "pat@example.com", address: "Lot #99" });

    const result = await approveJoinRequest(db, { associationId: ASSOCIATION, requestId: "jr-pat" });
    expect(result).toMatchObject({
      ok: true,
      email: "pat@example.com",
      name: "Pat Example",
      createdUser: true,
      roleId: "homeowner",
      lot: { kind: "linked", lotNumber: "99" },
    });
    expect(sqlite.prepare("SELECT name FROM users WHERE email = 'pat@example.com'").get()).toEqual({ name: "Pat Example" });
    const membership = sqlite
      .prepare(
        `SELECT m.role_id, m.status
         FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.association_id = ? AND u.email = 'pat@example.com'`,
      )
      .get(ASSOCIATION);
    expect(membership).toEqual({ role_id: "homeowner", status: "active" });
    const linked = sqlite
      .prepare(
        `SELECT p.lot_number, po.is_primary
         FROM property_owners po
         JOIN properties p ON p.id = po.property_id
         JOIN users u ON u.id = po.user_id
         WHERE po.association_id = ? AND u.email = 'pat@example.com'`,
      )
      .get(ASSOCIATION);
    expect(linked).toEqual({ lot_number: "99", is_primary: 1 });
    expect(sqlite.prepare("SELECT status FROM join_requests WHERE id = 'jr-pat'").get()).toEqual({ status: "approved" });
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM magic_links")).toBe(0);
    expect(await approveJoinRequest(db, { associationId: ASSOCIATION, requestId: "jr-pat" })).toEqual({
      ok: false,
      reason: "missing",
    });
    sqlite.close();
  });

  it("reuses an existing login and does not replace the name or an occupied lot", async () => {
    const { sqlite, db } = openPortal();
    insertRequest(sqlite, {
      id: "jr-sam",
      name: "Someone Else",
      email: "Sam.Rivera@example.com",
      address: "14",
    });
    const result = await approveJoinRequest(db, { associationId: ASSOCIATION, requestId: "jr-sam" });
    expect(result).toMatchObject({
      ok: true,
      email: "sam.rivera@example.com",
      name: "Sam Rivera",
      createdUser: false,
      roleId: "homeowner",
      lot: { kind: "already", lotNumber: "14" },
    });
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM users WHERE email = 'sam.rivera@example.com' COLLATE NOCASE")).toBe(1);
    expect(sqlite.prepare("SELECT name FROM users WHERE email = 'sam.rivera@example.com'").get()).toEqual({ name: "Sam Rivera" });
    expect(
      count(sqlite, "SELECT COUNT(*) AS n FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'sam.rivera@example.com'"),
    ).toBe(1);
    expect(sqlite.prepare("SELECT status FROM join_requests WHERE id = 'jr-sam'").get()).toEqual({ status: "approved" });
    sqlite.close();
  });

  it("keeps an active admin board role and can approve a reviewed request without a lot", async () => {
    const { sqlite, db } = openPortal();
    insertRequest(sqlite, { id: "jr-jordan", name: "Jordan Lee", email: "jordan.lee@example.com", status: "reviewed" });
    const result = await approveJoinRequest(db, { associationId: ASSOCIATION, requestId: "jr-jordan" });
    expect(result).toMatchObject({
      ok: true,
      createdUser: false,
      roleId: "board",
      isAdmin: 1,
      lot: { kind: "skipped", reason: "blank" },
    });
    expect(
      sqlite
        .prepare("SELECT role_id, status, is_admin FROM memberships WHERE association_id = ? AND user_id = 'user_jordan'")
        .get(ASSOCIATION),
    ).toEqual({ role_id: "board", status: "active", is_admin: 1 });
    sqlite.close();
  });

  it("activates an inactive homeowner without renaming them", async () => {
    const { sqlite, db } = openPortal();
    sqlite.prepare("UPDATE memberships SET status = 'inactive' WHERE user_id = 'user_casey'").run();
    insertRequest(sqlite, { id: "jr-casey", name: "Not Casey", email: "casey.nguyen@example.com" });
    const result = await approveJoinRequest(db, { associationId: ASSOCIATION, requestId: "jr-casey" });
    expect(result).toMatchObject({ ok: true, createdUser: false, roleId: "homeowner", name: "Casey Nguyen" });
    expect(sqlite.prepare("SELECT role_id, status FROM memberships WHERE user_id = 'user_casey'").get()).toEqual({
      role_id: "homeowner",
      status: "active",
    });
    sqlite.close();
  });

  it("does not approve a request with an invalid email", async () => {
    const { sqlite, db } = openPortal();
    insertRequest(sqlite, { id: "jr-bad", name: "Bad", email: "not-an-email" });
    expect(await approveJoinRequest(db, { associationId: ASSOCIATION, requestId: "jr-bad" })).toEqual({
      ok: false,
      reason: "invalid_email",
    });
    expect(sqlite.prepare("SELECT status FROM join_requests WHERE id = 'jr-bad'").get()).toEqual({ status: "pending" });
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM users WHERE email = 'not-an-email'")).toBe(0);
    sqlite.close();
  });

  it("does not link a lot that already has a different owner", async () => {
    const { sqlite, db } = openPortal();
    insertRequest(sqlite, { id: "jr-neighbor", name: "Neighbor", email: "neighbor@example.com", address: "Lot 14" });
    const result = await approveJoinRequest(db, { associationId: ASSOCIATION, requestId: "jr-neighbor" });
    expect(result).toMatchObject({
      ok: true,
      createdUser: true,
      roleId: "homeowner",
      lot: { kind: "skipped", reason: "occupied", lotNumber: "14" },
    });
    expect(
      count(
        sqlite,
        `SELECT COUNT(*) AS n FROM property_owners po
         JOIN users u ON u.id = po.user_id
         WHERE u.email = 'neighbor@example.com'`,
      ),
    ).toBe(0);
    expect(sqlite.prepare("SELECT user_id FROM property_owners WHERE id = 'own_sam'").get()).toEqual({ user_id: "user_sam" });
    sqlite.close();
  });
});

describe("owner login filters", () => {
  const association: Association = {
    id: ASSOCIATION,
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

  it("uses small Everyone and Past due only filters", () => {
    const everyone = ownersPage(association, [], [], false);
    const pastDue = ownersPage(association, [], [], true);
    expect(everyone).toContain("<h2>Users</h2>");
    expect(everyone).toContain('id="logins"');
    expect(everyone).not.toContain(">Logins<");
    expect(everyone).toContain(">Everyone<");
    expect(everyone).toContain(">Past due only<");
    expect(everyone).toContain('class="filters"');
    expect(everyone).toContain('class="active" href="/a/tango-mar/admin/owners#logins">Everyone');
    expect(everyone).not.toContain("All owners");
    expect(everyone).not.toContain(">Delinquent<");
    expect(everyone).not.toContain('class="button" href="/a/tango-mar/admin/owners#logins"');
    expect(pastDue).toContain("<h2>Delinquent accounts</h2>");
    expect(pastDue).toContain('id="logins"');
    expect(pastDue).not.toContain(">Logins<");
    expect(pastDue).toContain('class="active" href="/a/tango-mar/admin/owners?delinquent=1#logins">Past due only');
  });
});

describe("join requests admin page", () => {
  const association: Association = {
    id: ASSOCIATION,
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

  it("offers approve, decline, and delete, and keeps approve off an approved request", () => {
    const html = joinRequestsPage(association, [
      { id: "pending-1", name: "Pat", email: "pat@example.com", address: "99", note: "", status: "pending", created_at: "2026-10-06T12:00:00Z" },
      { id: "reviewed-1", name: "Rae", email: "rae@example.com", address: "", note: "", status: "reviewed", created_at: "2026-10-05T12:00:00Z" },
      { id: "approved-1", name: "Ada", email: "ada@example.com", address: "", note: "", status: "approved", created_at: "2026-10-04T12:00:00Z" },
      { id: "declined-1", name: "Noe", email: "noe@example.com", address: "", note: "", status: "declined", created_at: "2026-10-03T12:00:00Z" },
    ]);
    expect(html).toContain("/admin/join-requests/pending-1/approve");
    expect(html).toContain("/admin/join-requests/pending-1/reviewed");
    expect(html).toContain("/admin/join-requests/pending-1/decline");
    expect(html).toContain("/admin/join-requests/pending-1/delete");
    expect(html).toContain(">Approve<");
    expect(html).toContain(">Decline<");
    expect(html).toContain(">Mark reviewed<");
    expect(html).toContain(">Delete<");
    expect(html).toContain("Delete this join request? This cannot be undone.");
    expect(html).toContain('name="confirm" value="yes"');
    expect(html).not.toContain('type="checkbox" name="confirm"');
    expect(html).toContain("/admin/join-requests/reviewed-1/approve");
    expect(html).toContain("/admin/join-requests/reviewed-1/decline");
    expect(html).not.toContain("/admin/join-requests/reviewed-1/reviewed");
    expect(html).not.toContain("/admin/join-requests/approved-1/approve");
    expect(html).not.toContain("/admin/join-requests/approved-1/decline");
    expect(html).toContain("/admin/join-requests/approved-1/delete");
    expect(html).toContain("/admin/join-requests/declined-1/approve");
    expect(html).not.toContain("/admin/join-requests/declined-1/decline");
    expect(html).toContain("Approved");
    expect(html).toContain("Declined");
    expect(html).toContain("Approve creates a login and sends a welcome email. Decline does not. Delete removes the request. A lot links only if the address matches one empty lot.");
    expect(html).toContain('class="actions join-actions"');
    expect(html).not.toContain("\u2014");
  });

  it("turns officers into board admins and allows a declined request", () => {
    const { sqlite } = openPortal();
    expect(sqlite.prepare("SELECT role_id, is_admin FROM memberships WHERE user_id = 'user_jordan'").get()).toEqual({
      role_id: "board",
      is_admin: 1,
    });
    expect(sqlite.prepare("SELECT id FROM roles WHERE id = 'officer'").get()).toBeUndefined();
    expect(sqlite.prepare("SELECT lot_type FROM properties WHERE id = 'prop_3'").get()).toEqual({ lot_type: "improved" });
    insertRequest(sqlite, { id: "jr-no", name: "Noe", email: "noe@example.com", status: "declined" });
    expect(sqlite.prepare("SELECT status FROM join_requests WHERE id = 'jr-no'").get()).toEqual({ status: "declined" });
    sqlite.close();
  });
});

describe("login email", () => {
  it("changes the address and keeps the user id and lot link", async () => {
    const { sqlite, db } = openPortal();
    const result = await changeLoginEmail(db, "user_sam", "  Sam.New@Example.com ");
    expect(result).toEqual({ ok: true, email: "sam.new@example.com", changed: true });
    expect(sqlite.prepare("SELECT id, email FROM users WHERE id = 'user_sam'").get()).toEqual({
      id: "user_sam",
      email: "sam.new@example.com",
    });
    expect(sqlite.prepare("SELECT user_id FROM property_owners WHERE property_id = 'prop_14'").get()).toEqual({
      user_id: "user_sam",
    });
    expect(sqlite.prepare("SELECT id FROM users WHERE email = 'sam.rivera@example.com'").get()).toBeUndefined();
    sqlite.close();
  });

  it("rejects an email another person already uses", async () => {
    const { sqlite, db } = openPortal();
    const result = await changeLoginEmail(db, "user_sam", "Jordan.Lee@example.com");
    expect(result).toEqual({ ok: false, reason: "taken" });
    expect(sqlite.prepare("SELECT email FROM users WHERE id = 'user_sam'").get()).toEqual({
      email: "sam.rivera@example.com",
    });
    sqlite.close();
  });

  it("rejects a blank or malformed email and leaves the row alone when unchanged", async () => {
    const { sqlite, db } = openPortal();
    expect(await changeLoginEmail(db, "user_sam", "not-an-email")).toEqual({ ok: false, reason: "invalid" });
    expect(await changeLoginEmail(db, "user_sam", "sam.rivera@example.com")).toEqual({
      ok: true,
      email: "sam.rivera@example.com",
      changed: false,
    });
    expect(sqlite.prepare("SELECT email FROM users WHERE id = 'user_sam'").get()).toEqual({
      email: "sam.rivera@example.com",
    });
    sqlite.close();
  });
});

describe("owner name and phone", () => {
  function portalEnv(db: D1Database): Env {
    return {
      DB: db,
      APP_ENV: "production",
      EMAIL_FROM: "Tango Mar <donotreply@mytangomar.com>",
      DOCUMENTS: {} as R2Bucket,
    } as Env;
  }

  async function signIn(sqlite: DatabaseSync, userId: string): Promise<string> {
    const token = `session-${userId}`;
    sqlite
      .prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(`sess_${userId}`, userId, await sha256Hex(token), "2099-01-01T00:00:00.000Z", "2026-10-06T00:00:00.000Z");
    return token;
  }

  function postProfile(token: string, body: Record<string, string>): RequestInit {
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

  it("saves a name and phone and shows them on the person page", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const token = await signIn(sqlite, "user_jordan");
    try {
      const saved = await app.request(
        "http://localhost/a/tango-mar/admin/owners/user_sam/profile",
        postProfile(token, { name: "  Samantha Rivera  ", phone: "  850-555-0199  " }),
        env,
      );
      expect(saved.status).toBe(303);
      expect(saved.headers.get("Location")).toBe("/a/tango-mar/admin/owners/user_sam");
      expect(decodeURIComponent(saved.headers.get("Set-Cookie") ?? "")).toContain("ok:Name and phone saved.");

      const page = await app.request(
        "http://localhost/a/tango-mar/admin/owners/user_sam",
        { headers: { Cookie: `tango_session=${token}; tango_flash=ok:Name and phone saved.` } },
        env,
      );
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("Name and phone saved.");
      expect(html).toContain("<h1>Samantha Rivera</h1>");
      expect(html).toContain("sam.rivera@example.com · 850-555-0199");
      expect(html).toContain('value="Samantha Rivera"');
      expect(html).toContain('value="850-555-0199"');
      expect(html).toContain('action="/a/tango-mar/admin/owners/user_sam/email"');
      expect(sqlite.prepare("SELECT id, email, name, phone FROM users WHERE id = 'user_sam'").get()).toEqual({
        id: "user_sam",
        email: "sam.rivera@example.com",
        name: "Samantha Rivera",
        phone: "850-555-0199",
      });
      expect(sqlite.prepare("SELECT user_id FROM property_owners WHERE property_id = 'prop_14'").get()).toEqual({
        user_id: "user_sam",
      });
      expect(sqlite.prepare("SELECT action, actor_user_id, entity_type, entity_id, detail FROM audit_log WHERE action = 'profile_change'").get()).toEqual({
        action: "profile_change",
        actor_user_id: "user_jordan",
        entity_type: "user",
        entity_id: "user_sam",
        detail: "Sam Rivera to Samantha Rivera, 850-555-0102 to 850-555-0199",
      });
    } finally {
      sqlite.close();
    }
  });

  it("requires a name, clears a blank phone, and skips an unchanged save", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const token = await signIn(sqlite, "user_jordan");
    try {
      const blank = await app.request(
        "http://localhost/a/tango-mar/admin/owners/user_sam/profile",
        postProfile(token, { name: "   ", phone: "850-555-0199" }),
        env,
      );
      expect(blank.status).toBe(303);
      expect(decodeURIComponent(blank.headers.get("Set-Cookie") ?? "")).toContain("warn:Enter a name.");
      expect(sqlite.prepare("SELECT name, phone FROM users WHERE id = 'user_sam'").get()).toEqual({
        name: "Sam Rivera",
        phone: "850-555-0102",
      });

      const cleared = await app.request(
        "http://localhost/a/tango-mar/admin/owners/user_sam/profile",
        postProfile(token, { name: "Sam Rivera", phone: "" }),
        env,
      );
      expect(cleared.status).toBe(303);
      expect(sqlite.prepare("SELECT name, phone FROM users WHERE id = 'user_sam'").get()).toEqual({
        name: "Sam Rivera",
        phone: "",
      });
      const page = await app.request(
        "http://localhost/a/tango-mar/admin/owners/user_sam",
        { headers: { Cookie: `tango_session=${token}` } },
        env,
      );
      const html = await page.text();
      expect(html).toContain("<h1>Sam Rivera</h1>");
      expect(html).toContain("<p>sam.rivera@example.com</p>");
      expect(html).not.toContain("850-555-0102");

      const same = await app.request(
        "http://localhost/a/tango-mar/admin/owners/user_sam/profile",
        postProfile(token, { name: "Sam Rivera", phone: "" }),
        env,
      );
      expect(same.status).toBe(303);
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'profile_change'").get()).toEqual({ n: 1 });
    } finally {
      sqlite.close();
    }
  });

  it("refuses a homeowner", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const token = await signIn(sqlite, "user_sam");
    try {
      const refused = await app.request(
        "http://localhost/a/tango-mar/admin/owners/user_sam/profile",
        postProfile(token, { name: "Not Allowed", phone: "850-555-0199" }),
        env,
      );
      expect(refused.status).toBe(403);
      expect(sqlite.prepare("SELECT name, phone FROM users WHERE id = 'user_sam'").get()).toEqual({
        name: "Sam Rivera",
        phone: "850-555-0102",
      });
    } finally {
      sqlite.close();
    }
  });
});

describe("delete a person or a lot", () => {
  function portalEnv(db: D1Database): Env {
    return {
      DB: db,
      APP_ENV: "production",
      EMAIL_FROM: "Tango Mar <donotreply@mytangomar.com>",
      DOCUMENTS: {} as R2Bucket,
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

  it("requires confirm, refuses a homeowner, keeps the last admin, and deletes a person", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    sqlite
      .prepare(
        `INSERT INTO magic_links (id, email, association_id, token_hash, redirect_path, expires_at, created_at)
         VALUES ('ml_casey', 'casey.nguyen@example.com', ?, 'hash', '', '2099-01-01T00:00:00.000Z', '2026-10-06T00:00:00.000Z')`,
      )
      .run(ASSOCIATION);
    const adminToken = await signIn(sqlite, "user_jordan");
    const ownerToken = await signIn(sqlite, "user_sam");
    await signIn(sqlite, "user_casey");
    try {
      const page = await app.request(
        "http://localhost/a/tango-mar/admin/owners/user_casey",
        { headers: { Cookie: `tango_session=${adminToken}` } },
        env,
      );
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('action="/a/tango-mar/admin/owners/user_casey/delete"');
      expect(html).toContain('type="checkbox" name="confirm" value="yes"');
      expect(html).not.toContain("onsubmit=");

      const unconfirmed = await app.request(
        "http://localhost/a/tango-mar/admin/owners/user_casey/delete",
        post(adminToken, {}),
        env,
      );
      expect(unconfirmed.status).toBe(303);
      expect(decodeURIComponent(unconfirmed.headers.get("Set-Cookie") ?? "")).toContain("warn:Confirm the delete first.");
      expect(sqlite.prepare("SELECT id FROM users WHERE id = 'user_casey'").get()).toEqual({ id: "user_casey" });

      const refused = await app.request(
        "http://localhost/a/tango-mar/admin/owners/user_casey/delete",
        post(ownerToken, { confirm: "yes" }),
        env,
      );
      expect(refused.status).toBe(403);
      expect(sqlite.prepare("SELECT id FROM users WHERE id = 'user_casey'").get()).toEqual({ id: "user_casey" });

      const lastAdmin = await app.request(
        "http://localhost/a/tango-mar/admin/owners/user_jordan/delete",
        post(adminToken, { confirm: "yes" }),
        env,
      );
      expect(lastAdmin.status).toBe(303);
      expect(decodeURIComponent(lastAdmin.headers.get("Set-Cookie") ?? "")).toContain(
        "warn:Keep at least one person with admin access.",
      );
      expect(sqlite.prepare("SELECT id FROM users WHERE id = 'user_jordan'").get()).toEqual({ id: "user_jordan" });

      const removed = await app.request(
        "http://localhost/a/tango-mar/admin/owners/user_casey/delete",
        post(adminToken, { confirm: "yes" }),
        env,
      );
      expect(removed.status).toBe(303);
      expect(removed.headers.get("Location")).toBe("/a/tango-mar/admin/owners#logins");
      expect(decodeURIComponent(removed.headers.get("Set-Cookie") ?? "")).toContain("ok:Casey Nguyen deleted.");
      expect(sqlite.prepare("SELECT id FROM users WHERE id = 'user_casey'").get()).toBeUndefined();
      expect(sqlite.prepare("SELECT id FROM memberships WHERE user_id = 'user_casey'").get()).toBeUndefined();
      expect(sqlite.prepare("SELECT id FROM property_owners WHERE user_id = 'user_casey'").get()).toBeUndefined();
      expect(sqlite.prepare("SELECT id FROM sessions WHERE user_id = 'user_casey'").get()).toBeUndefined();
      expect(sqlite.prepare("SELECT id FROM magic_links WHERE email = 'casey.nguyen@example.com'").get()).toBeUndefined();
      expect(sqlite.prepare("SELECT id FROM notifications WHERE user_id = 'user_casey'").get()).toBeUndefined();
      expect(sqlite.prepare("SELECT id FROM messages WHERE from_user_id = 'user_casey'").get()).toBeUndefined();
      expect(sqlite.prepare("SELECT id FROM properties WHERE id = 'prop_27'").get()).toEqual({ id: "prop_27" });
      expect(count(sqlite, "SELECT COUNT(*) AS n FROM invoices WHERE property_id = 'prop_27'")).toBe(2);
      expect(sqlite.prepare("SELECT recorded_by_user_id FROM payments WHERE id = 'payment_sam_2026'").get()).toEqual({
        recorded_by_user_id: "user_jordan",
      });
      expect(sqlite.prepare("SELECT id FROM notifications WHERE id = 'note_jordan_message'").get()).toEqual({
        id: "note_jordan_message",
      });
      expect(
        sqlite.prepare("SELECT action, actor_user_id, entity_type, entity_id, detail FROM audit_log WHERE action = 'user_delete'").get(),
      ).toEqual({
        action: "user_delete",
        actor_user_id: "user_jordan",
        entity_type: "user",
        entity_id: "user_casey",
        detail: "Casey Nguyen (casey.nguyen@example.com)",
      });
    } finally {
      sqlite.close();
    }
  });

  it("keeps a login that still belongs to another association", async () => {
    const { sqlite, db } = openPortal();
    sqlite
      .prepare(
        `INSERT INTO associations (id, slug, name, legal_name, created_at)
         VALUES ('assoc_other', 'other', 'Other', 'Other Association', '2026-10-06T00:00:00Z')`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO memberships (id, association_id, user_id, role_id, is_admin, status, created_at)
         VALUES ('mem_casey_other', 'assoc_other', 'user_casey', 'homeowner', 0, 'active', '2026-10-06T00:00:00Z')`,
      )
      .run();
    const app = createApp();
    const token = await signIn(sqlite, "user_jordan");
    await signIn(sqlite, "user_casey");
    try {
      const removed = await app.request(
        "http://localhost/a/tango-mar/admin/owners/user_casey/delete",
        post(token, { confirm: "yes" }),
        portalEnv(db),
      );
      expect(removed.status).toBe(303);
      expect(decodeURIComponent(removed.headers.get("Set-Cookie") ?? "")).toContain(
        "ok:Casey Nguyen was removed from this association. The login is still used elsewhere.",
      );
      expect(sqlite.prepare("SELECT id FROM users WHERE id = 'user_casey'").get()).toEqual({ id: "user_casey" });
      expect(sqlite.prepare("SELECT user_id FROM sessions WHERE user_id = 'user_casey'").get()).toEqual({
        user_id: "user_casey",
      });
      expect(sqlite.prepare("SELECT association_id FROM memberships WHERE user_id = 'user_casey'").get()).toEqual({
        association_id: "assoc_other",
      });
      expect(sqlite.prepare("SELECT id FROM property_owners WHERE user_id = 'user_casey' AND association_id = ?").get(ASSOCIATION)).toBeUndefined();
      expect(sqlite.prepare("SELECT id FROM messages WHERE id = 'msg_casey_1'").get()).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  it("blocks a lot that still has a ledger and deletes one that is clear", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    sqlite.exec(`
      INSERT INTO properties (id, association_id, lot_number, street_address, city, state, postal_code, status, lot_type, created_at)
      VALUES
        ('prop_empty', '${ASSOCIATION}', '99', '99 Tang O Mar Drive', 'Miramar Beach', 'FL', '32550', 'active', 'improved', '2026-10-06T00:00:00Z'),
        ('prop_pay', '${ASSOCIATION}', '98', '98 Tang O Mar Drive', 'Miramar Beach', 'FL', '32550', 'active', 'unimproved', '2026-10-06T00:00:00Z');
      INSERT INTO property_owners (id, association_id, property_id, user_id, is_primary, created_at)
      VALUES ('own_empty', '${ASSOCIATION}', 'prop_empty', 'user_sam', 0, '2026-10-06T00:00:00Z');
      INSERT INTO payments (
        id, association_id, property_id, invoice_id, amount_cents, method, reference, paid_on, notes, recorded_by_user_id, created_at
      ) VALUES (
        'payment_only', '${ASSOCIATION}', 'prop_pay', NULL, 1000, 'cash', 'petty', '2026-10-01', '', 'user_jordan', '2026-10-01T00:00:00Z'
      );
      INSERT INTO messages (id, association_id, thread_id, parent_id, from_user_id, property_id, subject, body, created_at)
      VALUES (
        'msg_empty', '${ASSOCIATION}', 'msg_empty', NULL, 'user_jordan', 'prop_empty', 'Empty lot', 'Note', '2026-10-06T00:00:00Z'
      );
    `);
    const adminToken = await signIn(sqlite, "user_jordan");
    const ownerToken = await signIn(sqlite, "user_sam");
    try {
      const ledger = await app.request(
        "http://localhost/a/tango-mar/admin/ledger",
        { headers: { Cookie: `tango_session=${adminToken}` } },
        env,
      );
      expect(await ledger.text()).toContain('href="/a/tango-mar/admin/ledger/prop_14"');

      const blockedPage = await app.request(
        "http://localhost/a/tango-mar/admin/ledger/prop_14",
        { headers: { Cookie: `tango_session=${adminToken}` } },
        env,
      );
      expect(blockedPage.status).toBe(200);
      const blockedHtml = await blockedPage.text();
      expect(blockedHtml).toContain("This lot still has invoices or payments. Clear those before deleting the lot.");
      expect(blockedHtml).not.toContain('action="/a/tango-mar/admin/ledger/prop_14/delete"');
      expect(blockedHtml).toContain('href="/a/tango-mar/admin/invoices/invoice_sam_2026"');
      expect(blockedHtml).toContain("Sam Rivera");

      const blocked = await app.request(
        "http://localhost/a/tango-mar/admin/ledger/prop_14/delete",
        post(adminToken, { confirm: "yes" }),
        env,
      );
      expect(blocked.status).toBe(303);
      expect(decodeURIComponent(blocked.headers.get("Set-Cookie") ?? "")).toContain(
        "warn:This lot still has invoices or payments. Clear those before deleting the lot.",
      );
      expect(sqlite.prepare("SELECT id FROM properties WHERE id = 'prop_14'").get()).toEqual({ id: "prop_14" });
      expect(sqlite.prepare("SELECT user_id FROM property_owners WHERE property_id = 'prop_14'").get()).toEqual({
        user_id: "user_sam",
      });

      const paymentOnly = await app.request(
        "http://localhost/a/tango-mar/admin/ledger/prop_pay/delete",
        post(adminToken, { confirm: "yes" }),
        env,
      );
      expect(paymentOnly.status).toBe(303);
      expect(sqlite.prepare("SELECT id FROM properties WHERE id = 'prop_pay'").get()).toEqual({ id: "prop_pay" });
      expect(sqlite.prepare("SELECT id FROM payments WHERE id = 'payment_only'").get()).toEqual({ id: "payment_only" });

      const clearPage = await app.request(
        "http://localhost/a/tango-mar/admin/ledger/prop_empty",
        { headers: { Cookie: `tango_session=${adminToken}` } },
        env,
      );
      const clearHtml = await clearPage.text();
      expect(clearHtml).toContain('action="/a/tango-mar/admin/ledger/prop_empty/delete"');
      expect(clearHtml).toContain('type="checkbox" name="confirm" value="yes"');
      expect(clearHtml).not.toContain("onsubmit=");
      expect(clearHtml).toContain("No invoices on this lot.");

      const unconfirmed = await app.request(
        "http://localhost/a/tango-mar/admin/ledger/prop_empty/delete",
        post(adminToken, {}),
        env,
      );
      expect(unconfirmed.status).toBe(303);
      expect(decodeURIComponent(unconfirmed.headers.get("Set-Cookie") ?? "")).toContain("warn:Confirm the delete first.");
      expect(sqlite.prepare("SELECT id FROM properties WHERE id = 'prop_empty'").get()).toEqual({ id: "prop_empty" });

      const refused = await app.request(
        "http://localhost/a/tango-mar/admin/ledger/prop_empty/delete",
        post(ownerToken, { confirm: "yes" }),
        env,
      );
      expect(refused.status).toBe(403);
      expect(sqlite.prepare("SELECT id FROM properties WHERE id = 'prop_empty'").get()).toEqual({ id: "prop_empty" });

      const removed = await app.request(
        "http://localhost/a/tango-mar/admin/ledger/prop_empty/delete",
        post(adminToken, { confirm: "yes" }),
        env,
      );
      expect(removed.status).toBe(303);
      expect(removed.headers.get("Location")).toBe("/a/tango-mar/admin/ledger");
      expect(decodeURIComponent(removed.headers.get("Set-Cookie") ?? "")).toContain("ok:Lot 99 deleted.");
      expect(sqlite.prepare("SELECT id FROM properties WHERE id = 'prop_empty'").get()).toBeUndefined();
      expect(sqlite.prepare("SELECT id FROM property_owners WHERE property_id = 'prop_empty'").get()).toBeUndefined();
      expect(sqlite.prepare("SELECT property_id FROM messages WHERE id = 'msg_empty'").get()).toEqual({ property_id: null });
      expect(
        sqlite.prepare("SELECT action, actor_user_id, entity_type, entity_id, detail FROM audit_log WHERE action = 'lot_delete'").get(),
      ).toEqual({
        action: "lot_delete",
        actor_user_id: "user_jordan",
        entity_type: "property",
        entity_id: "prop_empty",
        detail: "Lot 99",
      });
    } finally {
      sqlite.close();
    }
  });
});

describe("pending join requests and notices", () => {
  const association: Association = {
    id: ASSOCIATION,
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

  async function titles(db: D1Database): Promise<string[]> {
    const rows = await notificationsForUser(db, ASSOCIATION, "user_jordan");
    return rows.map((row) => row.title);
  }

  it("keeps a pending request on the dashboard, notices, and unread badge", async () => {
    const { sqlite, db } = openPortal();
    insertRequest(sqlite, { id: "jr-pat", name: "Pat", email: "pat@example.com" });
    insertNotice(sqlite, {
      id: "note-pat",
      kind: "join_request",
      title: joinRequestNoticeTitle("Pat"),
      body: "pat@example.com",
      href: "/a/tango-mar/admin/join-requests",
    });
    expect(await countPendingJoinRequests(db, ASSOCIATION)).toBe(1);
    expect(await titles(db)).toContain("Join request from Pat");
    const notices = noticesPage(association, await notificationsForUser(db, ASSOCIATION, "user_jordan"));
    const dashboard = dashboardPage({
      association,
      name: "Jordan Lee",
      ledger: [],
      upcoming: [],
      invoices: [],
      payments: [],
      notices: await notificationsForUser(db, ASSOCIATION, "user_jordan"),
      emergencies: [],
    });
    expect(notices).toContain("Join request from Pat");
    expect(dashboard).toContain("Join request from Pat");
    expect(await unreadCount(db, ASSOCIATION, "user_jordan")).toBeGreaterThan(0);
    sqlite.close();
  });

  it("removes a deleted request from the pending count, notices, dashboard, and badge", async () => {
    const { sqlite, db } = openPortal();
    insertRequest(sqlite, { id: "jr-pat", name: "Pat", email: "pat@example.com" });
    insertRequest(sqlite, { id: "jr-sam", name: "Sam", email: "sam@example.com" });
    insertNotice(sqlite, {
      id: "note-pat",
      kind: "join_request",
      title: joinRequestNoticeTitle("Pat"),
      body: "pat@example.com",
      href: "/a/tango-mar/admin/join-requests",
    });
    insertNotice(sqlite, {
      id: "note-sam",
      kind: "join_request",
      title: joinRequestNoticeTitle("Sam"),
      body: "sam@example.com",
      href: joinRequestNoticeHref("tango-mar", "jr-sam"),
    });
    insertNotice(sqlite, {
      id: "note-dues",
      kind: "account",
      title: "Dues reminder",
      body: "Please mail a check.",
      href: "/a/tango-mar/notices",
    });
    const before = await unreadCount(db, ASSOCIATION, "user_jordan");

    expect(await deleteJoinRequest(db, ASSOCIATION, "jr-pat")).toBe(true);
    expect(await countPendingJoinRequests(db, ASSOCIATION)).toBe(1);
    expect((await listJoinRequests(db, ASSOCIATION)).map((row) => row.id)).toEqual(["jr-sam"]);
    expect(sqlite.prepare("SELECT id FROM notifications WHERE id = 'note-pat'").get()).toBeUndefined();
    expect(await titles(db)).not.toContain("Join request from Pat");
    expect(await titles(db)).toContain("Join request from Sam");
    expect(await titles(db)).toContain("Dues reminder");
    const listed = await notificationsForUser(db, ASSOCIATION, "user_jordan");
    const notices = noticesPage(association, listed);
    const dashboard = dashboardPage({
      association,
      name: "Jordan Lee",
      ledger: [],
      upcoming: [],
      invoices: [],
      payments: [],
      notices: listed,
      emergencies: [],
    });
    expect(notices).not.toContain("Join request from Pat");
    expect(dashboard).not.toContain("Join request from Pat");
    expect(notices).toContain("Join request from Sam");
    expect(await unreadCount(db, ASSOCIATION, "user_jordan")).toBe(before - 1);
    const home = adminHome({
      association,
      lots: 3,
      members: 1,
      delinquent: 0,
      waiting: 0,
      pendingJoins: await countPendingJoinRequests(db, ASSOCIATION),
      outstandingCents: 0,
      admins: [],
      audit: [],
    });
    expect(home).toContain("Join requests waiting");
    expect(home).not.toContain("Pat");
    sqlite.close();
  });

  it("hides a notice whose request was already deleted, and does not count declined, reviewed, or approved", async () => {
    const { sqlite, db } = openPortal();
    insertRequest(sqlite, { id: "jr-no", name: "Noe", email: "noe@example.com", status: "declined" });
    insertRequest(sqlite, { id: "jr-rae", name: "Rae", email: "rae@example.com", status: "reviewed" });
    insertRequest(sqlite, { id: "jr-ada", name: "Ada", email: "ada@example.com", status: "approved" });
    insertNotice(sqlite, {
      id: "note-gone",
      kind: "join_request",
      title: joinRequestNoticeTitle("Pat"),
      body: "pat@example.com",
      href: "/a/tango-mar/admin/join-requests",
    });
    insertNotice(sqlite, {
      id: "note-noe",
      kind: "join_request",
      title: joinRequestNoticeTitle("Noe"),
      body: "noe@example.com",
      href: "/a/tango-mar/admin/join-requests",
    });
    insertNotice(sqlite, {
      id: "note-rae",
      kind: "join_request",
      title: joinRequestNoticeTitle("Rae"),
      body: "rae@example.com",
      href: joinRequestNoticeHref("tango-mar", "jr-rae"),
    });
    insertNotice(sqlite, {
      id: "note-ada",
      kind: "join_request",
      title: joinRequestNoticeTitle("Ada"),
      body: "ada@example.com",
      href: joinRequestNoticeHref("tango-mar", "jr-ada"),
    });
    expect(await countPendingJoinRequests(db, ASSOCIATION)).toBe(0);
    const shown = await titles(db);
    expect(shown).not.toContain("Join request from Pat");
    expect(shown).not.toContain("Join request from Noe");
    expect(shown).not.toContain("Join request from Rae");
    expect(shown).not.toContain("Join request from Ada");
    const unread = await unreadCount(db, ASSOCIATION, "user_jordan");
    expect(unread).toBe(count(sqlite, "SELECT COUNT(*) AS n FROM notifications WHERE user_id = 'user_jordan' AND kind != 'join_request' AND read_at IS NULL"));
    sqlite.close();
  });

  it("clears the notice when a request is declined, reviewed, or approved", async () => {
    const { sqlite, db } = openPortal();
    insertRequest(sqlite, { id: "jr-no", name: "Noe", email: "noe@example.com" });
    insertRequest(sqlite, { id: "jr-rae", name: "Rae", email: "rae@example.com" });
    insertRequest(sqlite, { id: "jr-pat", name: "Pat Example", email: "pat@example.com" });
    insertNotice(sqlite, {
      id: "note-noe",
      kind: "join_request",
      title: joinRequestNoticeTitle("Noe"),
      body: "noe@example.com",
      href: "/a/tango-mar/admin/join-requests",
    });
    insertNotice(sqlite, {
      id: "note-rae",
      kind: "join_request",
      title: joinRequestNoticeTitle("Rae"),
      body: "rae@example.com",
      href: joinRequestNoticeHref("tango-mar", "jr-rae"),
    });
    insertNotice(sqlite, {
      id: "note-pat",
      kind: "join_request",
      title: joinRequestNoticeTitle("Pat Example"),
      body: "pat@example.com",
      href: joinRequestNoticeHref("tango-mar", "jr-pat"),
    });

    expect(await declineJoinRequest(db, ASSOCIATION, "jr-no")).toBe(true);
    expect(sqlite.prepare("SELECT status FROM join_requests WHERE id = 'jr-no'").get()).toEqual({ status: "declined" });
    expect(sqlite.prepare("SELECT id FROM notifications WHERE id = 'note-noe'").get()).toBeUndefined();
    expect(await countPendingJoinRequests(db, ASSOCIATION)).toBe(2);

    expect(await reviewJoinRequest(db, ASSOCIATION, "jr-rae")).toBe(true);
    expect(sqlite.prepare("SELECT id FROM notifications WHERE id = 'note-rae'").get()).toBeUndefined();
    expect(await countPendingJoinRequests(db, ASSOCIATION)).toBe(1);

    const approved = await approveJoinRequest(db, { associationId: ASSOCIATION, requestId: "jr-pat" });
    expect(approved).toMatchObject({ ok: true });
    expect(sqlite.prepare("SELECT id FROM notifications WHERE id = 'note-pat'").get()).toBeUndefined();
    expect(await countPendingJoinRequests(db, ASSOCIATION)).toBe(0);
    expect(await titles(db)).not.toContain("Join request from Noe");
    expect(await titles(db)).not.toContain("Join request from Rae");
    expect(await titles(db)).not.toContain("Join request from Pat Example");
    sqlite.close();
  });

  it("does not drop another pending request that shares an id prefix", async () => {
    const { sqlite, db } = openPortal();
    insertRequest(sqlite, { id: "jr-pat", name: "Pat", email: "pat@example.com" });
    insertRequest(sqlite, { id: "jr-pat-extra", name: "Pat Extra", email: "extra@example.com" });
    insertNotice(sqlite, {
      id: "note-pat",
      kind: "join_request",
      title: joinRequestNoticeTitle("Pat"),
      body: "pat@example.com",
      href: joinRequestNoticeHref("tango-mar", "jr-pat"),
    });
    insertNotice(sqlite, {
      id: "note-extra",
      kind: "join_request",
      title: joinRequestNoticeTitle("Pat Extra"),
      body: "extra@example.com",
      href: joinRequestNoticeHref("tango-mar", "jr-pat-extra"),
    });
    expect(await deleteJoinRequest(db, ASSOCIATION, "jr-pat")).toBe(true);
    expect(sqlite.prepare("SELECT id FROM notifications WHERE id = 'note-pat'").get()).toBeUndefined();
    expect(sqlite.prepare("SELECT id FROM notifications WHERE id = 'note-extra'").get()).toEqual({ id: "note-extra" });
    expect(await titles(db)).toEqual(expect.arrayContaining(["Join request from Pat Extra"]));
    expect(await titles(db)).not.toContain("Join request from Pat");
    expect(await countPendingJoinRequests(db, ASSOCIATION)).toBe(1);
    sqlite.close();
  });

  it("replaces an old notice when the same person asks again", async () => {
    const { sqlite, db } = openPortal();
    insertNotice(sqlite, {
      id: "note-old",
      kind: "join_request",
      title: joinRequestNoticeTitle("Pat"),
      body: "pat@example.com",
      href: "/a/tango-mar/admin/join-requests",
    });
    await retireLegacyJoinNotices(db, ASSOCIATION, { name: "Pat", email: "pat@example.com" });
    insertRequest(sqlite, { id: "jr-new", name: "Pat", email: "pat@example.com" });
    insertNotice(sqlite, {
      id: "note-new",
      kind: "join_request",
      title: joinRequestNoticeTitle("Pat"),
      body: "pat@example.com",
      href: joinRequestNoticeHref("tango-mar", "jr-new"),
    });
    expect(sqlite.prepare("SELECT id FROM notifications WHERE id = 'note-old'").get()).toBeUndefined();
    expect(await titles(db)).toContain("Join request from Pat");
    expect(await countPendingJoinRequests(db, ASSOCIATION)).toBe(1);
    sqlite.close();
  });

  it("still lists ordinary notices when the join request table is missing", async () => {
    const { sqlite, db } = openPortalWithoutJoinTable();
    const shown = await titles(db);
    expect(shown).toContain("New message from Casey Nguyen");
    expect(await unreadCount(db, ASSOCIATION, "user_jordan")).toBeGreaterThan(0);
    sqlite.close();
  });
});
