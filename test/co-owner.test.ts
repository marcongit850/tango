import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { parseOwnersCsv, type OwnerCsvRow } from "../src/lib/csv";
import { importOwners } from "../src/lib/import-owners";
import { sha256Hex } from "../src/lib/tokens";
import type { Association, User } from "../src/types";

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
];

const tango: Association = {
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

const actor: User = { id: "user_jordan", email: "jordan.lee@example.com", name: "Jordan Lee", phone: "850-555-0101" };

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
  return decodeURIComponent(response.headers.get("Set-Cookie") ?? "");
}

function links(sqlite: DatabaseSync, propertyId: string): { email: string; is_primary: number }[] {
  return sqlite
    .prepare(
      `SELECT u.email, po.is_primary
       FROM property_owners po
       JOIN users u ON u.id = po.user_id
       WHERE po.property_id = ?
       ORDER BY po.is_primary DESC, u.email`,
    )
    .all(propertyId) as { email: string; is_primary: number }[];
}

function ownerRow(overrides: Partial<OwnerCsvRow> & Pick<OwnerCsvRow, "email" | "name" | "lotNumber">): OwnerCsvRow {
  return {
    line: 2,
    streetAddress: `Lot ${overrides.lotNumber}, Tang O Mar Drive`,
    role: "homeowner",
    isAdmin: null,
    startingBalanceCents: 0,
    balanceAsOf: "2026-10-07",
    phone: "",
    city: "Miramar Beach",
    state: "FL",
    postalCode: "32550",
    houseName: "",
    mailingStreet: "",
    mailingCity: "",
    mailingState: "",
    mailingPostalCode: "",
    owner2Name: "",
    owner2Email: "",
    owner2Phone: "",
    ...overrides,
  };
}

describe("add owner to a lot", () => {
  it("creates a co-owner, keeps the primary, and lets that person see the lot", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const jordan = await signIn(sqlite, "user_jordan");
    try {
      const roster = await app.request("http://localhost/a/tango-mar/admin/owners", { headers: { Cookie: `tango_session=${jordan}` } }, env);
      expect(roster.status).toBe(200);
      const before = await roster.text();
      expect(before).toContain("<strong>Add owner to this lot</strong>");
      expect(before).toContain('action="/a/tango-mar/admin/lots/prop_27/owners"');
      expect(before).not.toContain("\u2014");
      expect(before).not.toContain("\u2013");

      const lot = await app.request(
        "http://localhost/a/tango-mar/admin/ledger/prop_27",
        { headers: { Cookie: `tango_session=${jordan}` } },
        env,
      );
      expect(await lot.text()).toContain("<strong>Add owner to this lot</strong>");

      const added = await app.request(
        "http://localhost/a/tango-mar/admin/lots/prop_27/owners",
        post(jordan, {
          name: "Alex Kim",
          email: " Alex.Kim@Example.com ",
          phone: "850-555-0199",
          return_to: "ledger",
        }),
        env,
      );
      expect(added.status).toBe(303);
      expect(added.headers.get("Location")).toBe("/a/tango-mar/admin/ledger/prop_27");
      expect(flash(added)).toContain(
        "ok:Alex Kim added as an owner of lot 27. They can sign in with a magic link at their email.",
      );
      expect(links(sqlite, "prop_27")).toEqual([
        { email: "casey.nguyen@example.com", is_primary: 1 },
        { email: "alex.kim@example.com", is_primary: 0 },
      ]);
      const alex = sqlite.prepare("SELECT id, name, phone FROM users WHERE email = 'alex.kim@example.com'").get() as {
        id: string;
        name: string;
        phone: string;
      };
      expect(alex).toEqual({ id: alex.id, name: "Alex Kim", phone: "850-555-0199" });
      expect(sqlite.prepare("SELECT role_id, status, is_admin, is_master FROM memberships WHERE user_id = ?").get(alex.id)).toEqual({
        role_id: "homeowner",
        status: "active",
        is_admin: 0,
        is_master: 0,
      });
      expect(sqlite.prepare("SELECT action, detail FROM audit_log WHERE action = 'owner_add'").get()).toEqual({
        action: "owner_add",
        detail: "Alex Kim added as an owner of lot 27.",
      });

      const again = await app.request(
        "http://localhost/a/tango-mar/admin/lots/prop_27/owners",
        post(jordan, { name: "Someone Else", email: "alex.kim@example.com", phone: "850-555-0000", return_to: "owners" }),
        env,
      );
      expect(flash(again)).toContain("ok:Alex Kim is already an owner of lot 27.");
      expect(sqlite.prepare("SELECT name, phone FROM users WHERE id = ?").get(alex.id)).toEqual({
        name: "Alex Kim",
        phone: "850-555-0199",
      });
      expect(links(sqlite, "prop_27")).toEqual([
        { email: "casey.nguyen@example.com", is_primary: 1 },
        { email: "alex.kim@example.com", is_primary: 0 },
      ]);

      const updated = await app.request(
        "http://localhost/a/tango-mar/admin/owners",
        { headers: { Cookie: `tango_session=${jordan}` } },
        env,
      );
      const html = await updated.text();
      expect(html).toContain("alex.kim@example.com");
      expect(html).toContain(">Primary<");
      expect(html).toContain(`action="/a/tango-mar/admin/lots/prop_27/owners/${alex.id}/remove"`);
      expect(html).toContain(`value="${alex.id}"`);
      expect(html).toContain("Make primary");
      expect(html).toContain("Remove from lot");

      const token = await signIn(sqlite, alex.id);
      const dashboard = await app.request(
        "http://localhost/a/tango-mar/dashboard",
        { headers: { Cookie: `tango_session=${token}` } },
        env,
      );
      expect(dashboard.status).toBe(200);
      const dash = await dashboard.text();
      expect(dash).toContain("Lot 27");
      expect(dash).toContain("$1,600.50");
      expect(dash).toContain("2026-27-ANNUAL");
      expect(dash).toContain("OPEN-27");
      expect(dash).not.toContain("Lot 14");

      const invoices = await app.request(
        "http://localhost/a/tango-mar/invoices",
        { headers: { Cookie: `tango_session=${token}` } },
        env,
      );
      expect(invoices.status).toBe(200);
      const invoiceHtml = await invoices.text();
      expect(invoiceHtml).toContain("2026-27-ANNUAL");
      expect(invoiceHtml).toContain("OPEN-27");
      expect(invoiceHtml).toContain("Lot 27");

      const ownLot = await app.request(
        "http://localhost/a/tango-mar/lots/prop_27",
        { headers: { Cookie: `tango_session=${token}` } },
        env,
      );
      expect(ownLot.status).toBe(200);
      const ownHtml = await ownLot.text();
      expect(ownHtml).toContain("Lot 27");
      expect(ownHtml).toContain("Casey Nguyen (primary)");
      const ownInvoice = await app.request(
        "http://localhost/a/tango-mar/invoices/invoice_casey_2026",
        { headers: { Cookie: `tango_session=${token}` } },
        env,
      );
      expect(ownInvoice.status).toBe(200);
      const otherLot = await app.request(
        "http://localhost/a/tango-mar/lots/prop_14",
        { headers: { Cookie: `tango_session=${token}` } },
        env,
      );
      expect(otherLot.status).toBe(403);
      const otherInvoice = await app.request(
        "http://localhost/a/tango-mar/invoices/invoice_sam_2026",
        { headers: { Cookie: `tango_session=${token}` } },
        env,
      );
      expect(otherInvoice.status).toBe(403);
    } finally {
      sqlite.close();
    }
  });

  it("reuses a board login without changing role, edit access, or the primary owner", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const jordan = await signIn(sqlite, "user_jordan");
    try {
      const added = await app.request(
        "http://localhost/a/tango-mar/admin/lots/prop_14/owners",
        post(jordan, { name: "Not Jordan", email: "JORDAN.LEE@example.com", phone: "850-555-0000" }),
        env,
      );
      expect(flash(added)).toContain("ok:Jordan Lee added as an owner of lot 14.");
      expect(sqlite.prepare("SELECT name, phone FROM users WHERE id = 'user_jordan'").get()).toEqual({
        name: "Jordan Lee",
        phone: "850-555-0101",
      });
      expect(sqlite.prepare("SELECT role_id, status, is_admin, is_master FROM memberships WHERE user_id = 'user_jordan'").get()).toEqual({
        role_id: "board",
        status: "active",
        is_admin: 1,
        is_master: 1,
      });
      expect(links(sqlite, "prop_14")).toEqual([
        { email: "sam.rivera@example.com", is_primary: 1 },
        { email: "jordan.lee@example.com", is_primary: 0 },
      ]);
      expect(links(sqlite, "prop_3")).toEqual([{ email: "jordan.lee@example.com", is_primary: 1 }]);
    } finally {
      sqlite.close();
    }
  });

  it("fills a blank name and phone, reactivates a homeowner, and keeps edit access", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    sqlite.exec(`
      INSERT INTO users (id, email, name, phone, created_at)
      VALUES ('user_blank', 'blank@example.com', '', '', '2026-10-02T00:00:00Z');
      INSERT INTO memberships (id, association_id, user_id, role_id, is_admin, status, created_at)
      VALUES ('mem_blank', 'assoc_tango_mar', 'user_blank', 'homeowner', 1, 'inactive', '2026-10-02T00:00:00Z');
    `);
    const jordan = await signIn(sqlite, "user_jordan");
    try {
      const added = await app.request(
        "http://localhost/a/tango-mar/admin/lots/prop_14/owners",
        post(jordan, { name: "Blair Stone", email: "blank@example.com", phone: "850-555-0160" }),
        env,
      );
      expect(flash(added)).toContain("ok:Blair Stone added as an owner of lot 14.");
      expect(sqlite.prepare("SELECT name, phone FROM users WHERE id = 'user_blank'").get()).toEqual({
        name: "Blair Stone",
        phone: "850-555-0160",
      });
      expect(sqlite.prepare("SELECT role_id, status, is_admin, is_master FROM memberships WHERE user_id = 'user_blank'").get()).toEqual({
        role_id: "homeowner",
        status: "active",
        is_admin: 1,
        is_master: 0,
      });
      expect(links(sqlite, "prop_14")).toEqual([
        { email: "sam.rivera@example.com", is_primary: 1 },
        { email: "blank@example.com", is_primary: 0 },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("makes the first owner primary when the lot has none", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    sqlite
      .prepare(
        `INSERT INTO properties (
           id, association_id, lot_number, street_address, city, state, postal_code, status, lot_type, created_at
         ) VALUES ('prop_99', 'assoc_tango_mar', '99', 'Lot 99, Tang O Mar Drive', 'Miramar Beach', 'FL', '32550', 'active', 'unimproved', '2026-10-02T00:00:00Z')`,
      )
      .run();
    const jordan = await signIn(sqlite, "user_jordan");
    try {
      const added = await app.request(
        "http://localhost/a/tango-mar/admin/lots/prop_99/owners",
        post(jordan, { name: "Riley Chen", email: "riley.chen@example.com", phone: "" }),
        env,
      );
      expect(flash(added)).toContain("Riley Chen added as an owner of lot 99.");
      expect(links(sqlite, "prop_99")).toEqual([{ email: "riley.chen@example.com", is_primary: 1 }]);
    } finally {
      sqlite.close();
    }
  });

  it("refuses a bad email and a person without edit access", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    sqlite.exec(`
      INSERT INTO users (id, email, name, phone, created_at)
      VALUES ('user_viewer', 'viewer@example.com', 'View Only', '', '2026-10-02T00:00:00Z');
      INSERT INTO memberships (id, association_id, user_id, role_id, is_admin, is_master, status, created_at)
      VALUES ('mem_viewer', 'assoc_tango_mar', 'user_viewer', 'board', 0, 0, 'active', '2026-10-02T00:00:00Z');
    `);
    const jordan = await signIn(sqlite, "user_jordan");
    const sam = await signIn(sqlite, "user_sam");
    const viewer = await signIn(sqlite, "user_viewer");
    try {
      const bad = await app.request(
        "http://localhost/a/tango-mar/admin/lots/prop_14/owners",
        post(jordan, { name: "Nope", email: "not-an-email", phone: "" }),
        env,
      );
      expect(bad.status).toBe(303);
      expect(flash(bad)).toContain("warn:Enter a valid email.");
      expect(sqlite.prepare("SELECT id FROM users WHERE email = 'not-an-email'").get()).toBeUndefined();

      const viewerPage = await app.request(
        "http://localhost/a/tango-mar/admin/owners",
        { headers: { Cookie: `tango_session=${viewer}` } },
        env,
      );
      expect(viewerPage.status).toBe(200);
      expect(await viewerPage.text()).not.toContain("<strong>Add owner to this lot</strong>");
      const viewerLot = await app.request(
        "http://localhost/a/tango-mar/admin/ledger/prop_14",
        { headers: { Cookie: `tango_session=${viewer}` } },
        env,
      );
      expect(await viewerLot.text()).not.toContain("<strong>Add owner to this lot</strong>");
      const denied = await app.request(
        "http://localhost/a/tango-mar/admin/lots/prop_14/owners",
        post(viewer, { name: "Nope", email: "nope@example.com", phone: "" }),
        env,
      );
      expect(denied.status).toBe(403);
      const resident = await app.request(
        "http://localhost/a/tango-mar/admin/lots/prop_14/owners",
        post(sam, { name: "Nope", email: "nope@example.com", phone: "" }),
        env,
      );
      expect(resident.status).toBe(403);
      expect(sqlite.prepare("SELECT id FROM users WHERE email = 'nope@example.com'").get()).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  it("promotes the oldest remaining owner and can remove the last one", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const jordan = await signIn(sqlite, "user_jordan");
    try {
      const zoe = await app.request(
        "http://localhost/a/tango-mar/admin/lots/prop_14/owners",
        post(jordan, { name: "Zoe Adams", email: "zoe.adams@example.com", phone: "" }),
        env,
      );
      expect(zoe.status).toBe(303);
      const amy = await app.request(
        "http://localhost/a/tango-mar/admin/lots/prop_14/owners",
        post(jordan, { name: "Amy Ng", email: "amy.ng@example.com", phone: "" }),
        env,
      );
      expect(amy.status).toBe(303);
      const zoeId = (sqlite.prepare("SELECT id FROM users WHERE email = 'zoe.adams@example.com'").get() as { id: string }).id;
      const amyId = (sqlite.prepare("SELECT id FROM users WHERE email = 'amy.ng@example.com'").get() as { id: string }).id;
      sqlite.prepare("UPDATE property_owners SET created_at = ? WHERE property_id = 'prop_14' AND user_id = ?").run("2026-10-03T00:00:00.000Z", zoeId);
      sqlite.prepare("UPDATE property_owners SET created_at = ? WHERE property_id = 'prop_14' AND user_id = ?").run("2026-10-04T00:00:00.000Z", amyId);

      const removedCoOwner = await app.request(
        `http://localhost/a/tango-mar/admin/lots/prop_14/owners/${amyId}/remove`,
        post(jordan, {}),
        env,
      );
      expect(flash(removedCoOwner)).toContain("ok:Amy Ng removed from lot 14.");
      expect(flash(removedCoOwner)).not.toContain("is now the primary owner");
      expect(links(sqlite, "prop_14")).toEqual([
        { email: "sam.rivera@example.com", is_primary: 1 },
        { email: "zoe.adams@example.com", is_primary: 0 },
      ]);
      expect(sqlite.prepare("SELECT id FROM users WHERE id = ?").get(amyId)).toEqual({ id: amyId });

      const readded = await app.request(
        "http://localhost/a/tango-mar/admin/lots/prop_14/owners",
        post(jordan, { name: "Amy Ng", email: "amy.ng@example.com", phone: "" }),
        env,
      );
      expect(readded.status).toBe(303);
      sqlite.prepare("UPDATE property_owners SET created_at = ? WHERE property_id = 'prop_14' AND user_id = ?").run("2026-10-04T00:00:00.000Z", amyId);

      const removedPrimary = await app.request(
        "http://localhost/a/tango-mar/admin/lots/prop_14/owners/user_sam/remove",
        post(jordan, { return_to: "owners" }),
        env,
      );
      expect(removedPrimary.headers.get("Location")).toBe("/a/tango-mar/admin/owners#lots");
      expect(flash(removedPrimary)).toContain("Sam Rivera removed from lot 14. Zoe Adams is now the primary owner.");
      expect(links(sqlite, "prop_14")).toEqual([
        { email: "zoe.adams@example.com", is_primary: 1 },
        { email: "amy.ng@example.com", is_primary: 0 },
      ]);
      expect(sqlite.prepare("SELECT id FROM users WHERE id = 'user_sam'").get()).toEqual({ id: "user_sam" });

      const primary = await app.request(
        "http://localhost/a/tango-mar/admin/lots/prop_14/owner",
        post(jordan, { user_id: amyId, return_to: "ledger" }),
        env,
      );
      expect(primary.status).toBe(303);
      expect(primary.headers.get("Location")).toBe("/a/tango-mar/admin/ledger/prop_14");
      expect(flash(primary)).toContain("ok:Amy Ng is now the primary owner of lot 14.");
      expect(links(sqlite, "prop_14")).toEqual([
        { email: "amy.ng@example.com", is_primary: 1 },
        { email: "zoe.adams@example.com", is_primary: 0 },
      ]);

      const removedNext = await app.request(
        `http://localhost/a/tango-mar/admin/lots/prop_14/owners/${amyId}/remove`,
        post(jordan, {}),
        env,
      );
      expect(flash(removedNext)).toContain("Amy Ng removed from lot 14. Zoe Adams is now the primary owner.");
      expect(links(sqlite, "prop_14")).toEqual([{ email: "zoe.adams@example.com", is_primary: 1 }]);

      const removedLast = await app.request(
        `http://localhost/a/tango-mar/admin/lots/prop_14/owners/${zoeId}/remove`,
        post(jordan, {}),
        env,
      );
      expect(flash(removedLast)).toContain("ok:Zoe Adams removed from lot 14.");
      expect(flash(removedLast)).not.toContain("is now the primary owner");
      expect(links(sqlite, "prop_14")).toEqual([]);
      expect(sqlite.prepare("SELECT id FROM users WHERE id = ?").get(zoeId)).toEqual({ id: zoeId });
      expect(sqlite.prepare("SELECT id FROM memberships WHERE user_id = ?").get(zoeId)).toBeTruthy();
      expect(sqlite.prepare("SELECT action FROM audit_log WHERE action = 'owner_remove'").all()).toHaveLength(4);
    } finally {
      sqlite.close();
    }
  });
});

describe("owner csv co-owner", () => {
  const defaults = { city: "Miramar Beach", state: "FL", postalCode: "32550", today: "2026-10-07" };

  it("reads owner2 columns and ignores a blank second email", () => {
    const parsed = parseOwnersCsv(
      [
        "email,name,lot_number,street_address,owner2_name,owner2_email,owner2_phone",
        "ada@example.com,Ada,8,Street,Blake,Blake@Example.com,850-555-0108",
        "bea@example.com,Bea,9,Street,Casey,,850-555-0109",
      ].join("\n"),
      defaults,
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0]).toMatchObject({
      owner2Name: "Blake",
      owner2Email: "blake@example.com",
      owner2Phone: "850-555-0108",
    });
    expect(parsed.rows[1]).toMatchObject({ owner2Name: "", owner2Email: "", owner2Phone: "" });

    const bad = parseOwnersCsv(
      ["email,name,lot_number,street_address,owner2_email", "ada@example.com,Ada,8,Street,not-an-email"].join("\n"),
      defaults,
    );
    expect(bad.rows).toHaveLength(0);
    expect(bad.errors[0].message).toMatch(/Second owner email/);

    const sample = parseOwnersCsv(readFileSync("samples/tango-mar-owners.csv", "utf8"), defaults);
    expect(sample.errors).toEqual([]);
    expect(sample.rows.find((row) => row.lotNumber === "14")).toMatchObject({
      email: "sam.rivera@example.com",
      owner2Name: "Alex Kim",
      owner2Email: "alex.kim@example.com",
      owner2Phone: "850-555-0199",
    });
    expect(sample.rows.find((row) => row.lotNumber === "27")?.owner2Email).toBe("");
  });

  it("links owner2 as a co-owner and does not let a later row take primary", async () => {
    const { sqlite, db } = openPortal();
    try {
      const withCoOwner = await importOwners(db, tango, actor, [
        ownerRow({
          email: "casey.nguyen@example.com",
          name: "Casey Nguyen",
          lotNumber: "27",
          phone: "850-555-0142",
          owner2Name: "Alex Kim",
          owner2Email: "Alex.Kim@Example.com",
          owner2Phone: "850-555-0199",
        }),
      ]);
      expect(withCoOwner.errors).toEqual([]);
      expect(withCoOwner.createdUsers).toBe(1);
      expect(withCoOwner.updatedUsers).toBe(1);
      expect(links(sqlite, "prop_27")).toEqual([
        { email: "casey.nguyen@example.com", is_primary: 1 },
        { email: "alex.kim@example.com", is_primary: 0 },
      ]);
      const alex = sqlite.prepare("SELECT id FROM users WHERE email = 'alex.kim@example.com'").get() as { id: string };
      expect(sqlite.prepare("SELECT role_id, is_admin, is_master, status FROM memberships WHERE user_id = ?").get(alex.id)).toEqual({
        role_id: "homeowner",
        status: "active",
        is_admin: 0,
        is_master: 0,
      });

      const boardCoOwner = await importOwners(db, tango, actor, [
        ownerRow({
          email: "casey.nguyen@example.com",
          name: "Casey Nguyen",
          lotNumber: "27",
          owner2Name: "Not Jordan",
          owner2Email: "jordan.lee@example.com",
          owner2Phone: "850-555-0000",
        }),
      ]);
      expect(boardCoOwner.errors).toEqual([]);
      expect(boardCoOwner.createdUsers).toBe(0);
      expect(sqlite.prepare("SELECT name, phone FROM users WHERE id = 'user_jordan'").get()).toEqual({
        name: "Jordan Lee",
        phone: "850-555-0101",
      });
      expect(sqlite.prepare("SELECT role_id, is_admin, is_master FROM memberships WHERE user_id = 'user_jordan'").get()).toEqual({
        role_id: "board",
        is_admin: 1,
        is_master: 1,
      });
      expect(links(sqlite, "prop_27")).toEqual([
        { email: "casey.nguyen@example.com", is_primary: 1 },
        { email: "alex.kim@example.com", is_primary: 0 },
        { email: "jordan.lee@example.com", is_primary: 0 },
      ]);

      const secondRow = await importOwners(db, tango, actor, [
        ownerRow({
          email: "pat.lee@example.com",
          name: "Pat Lee",
          lotNumber: "14",
          role: "board",
          isAdmin: true,
        }),
      ]);
      expect(secondRow.errors).toEqual([]);
      expect(secondRow.createdUsers).toBe(1);
      expect(links(sqlite, "prop_14")).toEqual([
        { email: "sam.rivera@example.com", is_primary: 1 },
        { email: "pat.lee@example.com", is_primary: 0 },
      ]);
      const again = await importOwners(db, tango, actor, [
        ownerRow({ email: "pat.lee@example.com", name: "Pat Lee", lotNumber: "14", role: "board", isAdmin: true }),
      ]);
      expect(again.createdUsers).toBe(0);
      expect(again.updatedUsers).toBe(1);
      expect(links(sqlite, "prop_14")).toEqual([
        { email: "sam.rivera@example.com", is_primary: 1 },
        { email: "pat.lee@example.com", is_primary: 0 },
      ]);

      const fresh = await importOwners(db, tango, actor, [
        ownerRow({
          email: "riley.chen@example.com",
          name: "Riley Chen",
          lotNumber: "99",
          streetAddress: "Lot 99, Tang O Mar Drive",
          owner2Name: "Blake Chen",
          owner2Email: "blake.chen@example.com",
          owner2Phone: "850-555-0190",
        }),
      ]);
      expect(fresh.createdUsers).toBe(2);
      expect(fresh.errors).toEqual([]);
      const property = sqlite.prepare("SELECT id FROM properties WHERE association_id = 'assoc_tango_mar' AND lot_number = '99'").get() as {
        id: string;
      };
      expect(links(sqlite, property.id)).toEqual([
        { email: "riley.chen@example.com", is_primary: 1 },
        { email: "blake.chen@example.com", is_primary: 0 },
      ]);

      const samePerson = await importOwners(db, tango, actor, [
        ownerRow({
          email: "riley.chen@example.com",
          name: "Riley Chen",
          lotNumber: "99",
          owner2Email: "riley.chen@example.com",
          owner2Name: "Riley Chen",
        }),
      ]);
      expect(samePerson.errors).toEqual([]);
      expect(links(sqlite, property.id)).toEqual([
        { email: "riley.chen@example.com", is_primary: 1 },
        { email: "blake.chen@example.com", is_primary: 0 },
      ]);
    } finally {
      sqlite.close();
    }
  });
});
