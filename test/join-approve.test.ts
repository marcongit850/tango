import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { isCheckConstraint } from "../src/lib/errors";
import { changeLoginEmail } from "../src/lib/login-email";
import {
  approvalSummary,
  approveJoinRequest,
  planLotLink,
  planMembership,
  planUserName,
  welcomeEmail,
  type LotCandidate,
} from "../src/lib/join-approve";
import type { Association } from "../src/types";
import { joinRequestsPage } from "../src/views/admin";

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
    expect(html).toContain("does not create a login");
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
