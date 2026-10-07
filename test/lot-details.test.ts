import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { importOwners } from "../src/lib/import-owners";
import { parseOwnersCsv } from "../src/lib/csv";
import { sha256Hex } from "../src/lib/tokens";
import type { Association, User } from "../src/types";
import { propertyPage } from "../src/views/resident";

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

const NOTE = "GATE CODE 4412";

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

describe("lot details", () => {
  it("leaves house name and mailing empty when those columns are absent", () => {
    const parsed = parseOwnersCsv("email,name,lot_number,street_address\na@example.com,Ada,1,Street\n", {
      city: "Miramar Beach",
      state: "FL",
      postalCode: "32550",
      today: "2026-10-07",
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0]).toMatchObject({
      houseName: "",
      city: "",
      state: "",
      postalCode: "",
      mailingStreet: "",
      mailingCity: "",
      mailingState: "",
      mailingPostalCode: "",
    });
  });

  it("shows house name, mailing, and phones on a lot, and hides admin notes from the owner", async () => {
    const { sqlite, db } = openPortal();
    sqlite.exec(`
      INSERT INTO users (id, email, name, phone, created_at)
      VALUES ('user_alex', 'alex.kim@example.com', 'Alex Kim', '850-555-0199', '2026-10-02T00:00:00Z');
      INSERT INTO memberships (id, association_id, user_id, role_id, is_admin, status, created_at)
      VALUES ('mem_alex', 'assoc_tango_mar', 'user_alex', 'homeowner', 0, 'active', '2026-10-02T00:00:00Z');
      INSERT INTO property_owners (id, association_id, property_id, user_id, is_primary, created_at)
      VALUES ('own_alex', 'assoc_tango_mar', 'prop_14', 'user_alex', 0, '2026-10-02T00:00:00Z');
    `);
    const app = createApp();
    const env = portalEnv(db);
    const jordan = await signIn(sqlite, "user_jordan");
    const sam = await signIn(sqlite, "user_sam");
    try {
      const saved = await app.request(
        "http://localhost/a/tango-mar/admin/lots/prop_14",
        post(jordan, {
          lot_number: "14",
          street_address: "Lot 14, Tang O Mar Drive",
          lot_type: "improved",
          status: "active",
          house_name: "MELOMAR",
          city: "Santa Rosa Beach",
          state: "FL",
          postal_code: "32459",
          mailing_street: "100 Oak Street",
          mailing_city: "Destin",
          mailing_state: "FL",
          mailing_postal_code: "32541",
          admin_notes: NOTE,
          return_to: "ledger",
        }),
        env,
      );
      expect(saved.status).toBe(303);
      expect(saved.headers.get("Location")).toBe("/a/tango-mar/admin/ledger/prop_14");
      expect(sqlite.prepare("SELECT house_name, city, state, postal_code, mailing_street, mailing_city, admin_notes FROM properties WHERE id = 'prop_14'").get()).toEqual({
        house_name: "MELOMAR",
        city: "Santa Rosa Beach",
        state: "FL",
        postal_code: "32459",
        mailing_street: "100 Oak Street",
        mailing_city: "Destin",
        admin_notes: NOTE,
      });

      const roster = await app.request("http://localhost/a/tango-mar/admin/owners", { headers: { Cookie: `tango_session=${jordan}` } }, env);
      expect(roster.status).toBe(200);
      const rosterHtml = await roster.text();
      expect(rosterHtml).toContain("<h1>Owners & lots</h1>");
      expect(rosterHtml).toContain("MELOMAR");
      expect(rosterHtml).toContain("Lot 14, Tang O Mar Drive<br>Santa Rosa Beach, FL 32459");
      expect(rosterHtml).toContain("Mailing address (if different)");
      expect(rosterHtml).toContain('name="house_name"');
      expect(rosterHtml).not.toContain("such as MELOMAR");
      expect(rosterHtml).not.toContain("AVERITTS FAVORITE");
      expect(rosterHtml).toContain("100 Oak Street");
      expect(rosterHtml).toContain("850-555-0102");
      expect(rosterHtml).toContain(NOTE);
      expect(rosterHtml).not.toContain("850-555-0199");
      const users = rosterHtml.slice(rosterHtml.indexOf('id="logins"'));
      expect(users).toContain("<h2>Users</h2>");
      expect(users).toContain("Last login");
      expect(users).toContain("jordan.lee@example.com");
      expect(users).not.toContain(">Balance<");
      expect(users).not.toContain(NOTE);

      const ledger = await app.request(
        "http://localhost/a/tango-mar/admin/ledger/prop_14",
        { headers: { Cookie: `tango_session=${jordan}` } },
        env,
      );
      const ledgerHtml = await ledger.text();
      expect(ledgerHtml).toContain("MELOMAR");
      expect(ledgerHtml).toContain("Lot 14, Tang O Mar Drive<br>Santa Rosa Beach, FL 32459");
      expect(ledgerHtml).toContain("Mailing address (if different)<br>100 Oak Street<br>Destin, FL 32541");
      expect(ledgerHtml).toContain('name="city"');
      expect(ledgerHtml).toContain('value="Santa Rosa Beach"');
      expect(ledgerHtml).toContain('name="postal_code"');
      expect(ledgerHtml).not.toContain("such as MELOMAR");
      expect(ledgerHtml).not.toContain("AVERITTS FAVORITE");
      expect(ledgerHtml).not.toContain('placeholder="MELOMAR"');
      expect(ledgerHtml).toContain("850-555-0102");
      expect(ledgerHtml).toContain("850-555-0199");
      expect(ledgerHtml).toContain("Phone numbers");
      expect(ledgerHtml).toContain(NOTE);
      expect(ledgerHtml).not.toContain("\u2014");

      const ownerLot = await app.request("http://localhost/a/tango-mar/lots/prop_14", { headers: { Cookie: `tango_session=${sam}` } }, env);
      expect(ownerLot.status).toBe(200);
      const ownerHtml = await ownerLot.text();
      expect(ownerHtml).toContain("MELOMAR");
      expect(ownerHtml).toContain("Lot 14, Tang O Mar Drive<br>Santa Rosa Beach, FL 32459");
      expect(ownerHtml).toContain("Mailing address (if different)<br>100 Oak Street<br>Destin, FL 32541");
      expect(ownerHtml).toContain("850-555-0102");
      expect(ownerHtml).toContain("850-555-0199");
      expect(ownerHtml).toContain("Sam Rivera (primary)");
      expect(ownerHtml).not.toContain(NOTE);
      expect(ownerHtml).not.toContain("Admin notes");
      expect(ownerHtml).not.toContain("admin_notes");

      const dashboard = await app.request("http://localhost/a/tango-mar/dashboard", { headers: { Cookie: `tango_session=${sam}` } }, env);
      const dashHtml = await dashboard.text();
      expect(dashHtml).toContain("MELOMAR");
      expect(dashHtml).toContain('href="/a/tango-mar/lots/prop_14"');
      expect(dashHtml).toContain("Santa Rosa Beach, FL 32459");
      expect(dashHtml).toContain("Mailing address (if different): 100 Oak Street, Destin, FL 32541");
      expect(dashHtml).not.toContain(NOTE);
      expect(dashHtml).not.toContain("admin_notes");

      const otherLot = await app.request("http://localhost/a/tango-mar/lots/prop_3", { headers: { Cookie: `tango_session=${sam}` } }, env);
      expect(otherLot.status).toBe(403);
      expect(await otherLot.text()).not.toContain(NOTE);

      const adminAttempt = await app.request(
        "http://localhost/a/tango-mar/admin/ledger/prop_14",
        { headers: { Cookie: `tango_session=${sam}` } },
        env,
      );
      expect(adminAttempt.status).toBe(403);
      expect(await adminAttempt.text()).not.toContain(NOTE);
    } finally {
      sqlite.close();
    }
  });

  it("imports house name, mailing, and phone, and does not clear them or admin notes on a blank cell", async () => {
    const { sqlite, db } = openPortal();
    sqlite.prepare("UPDATE properties SET admin_notes = ? WHERE id = 'prop_27'").run(NOTE);
    try {
      const row = {
        line: 2,
        email: "casey.nguyen@example.com",
        name: "Casey Nguyen",
        lotNumber: "27",
        streetAddress: "Lot 27, Tang O Mar Drive",
        role: "homeowner" as const,
        isAdmin: null,
        startingBalanceCents: 0,
        balanceAsOf: "2026-10-07",
        phone: "850-555-0142",
        city: "Miramar Beach",
        state: "FL",
        postalCode: "32550",
        houseName: "MELOMAR",
        mailingStreet: "100 Main Street",
        mailingCity: "Destin",
        mailingState: "FL",
        mailingPostalCode: "32541",
        owner2Name: "",
        owner2Email: "",
        owner2Phone: "",
      };
      const imported = await importOwners(db, tango, actor, [row]);
      expect(imported.errors).toEqual([]);
      expect(
        sqlite.prepare("SELECT house_name, mailing_street, mailing_city, admin_notes FROM properties WHERE id = 'prop_27'").get(),
      ).toEqual({
        house_name: "MELOMAR",
        mailing_street: "100 Main Street",
        mailing_city: "Destin",
        admin_notes: NOTE,
      });

      const kept = await importOwners(db, tango, actor, [
        { ...row, houseName: "", mailingStreet: "", phone: "", city: "", state: "", postalCode: "" },
      ]);
      expect(kept.errors).toEqual([]);
      expect(sqlite.prepare("SELECT house_name, city, state, postal_code, mailing_street, phone FROM properties p JOIN property_owners po ON po.property_id = p.id JOIN users u ON u.id = po.user_id WHERE p.id = 'prop_27' AND po.is_primary = 1").get()).toEqual({
        house_name: "MELOMAR",
        city: "Miramar Beach",
        state: "FL",
        postal_code: "32550",
        mailing_street: "100 Main Street",
        phone: "850-555-0142",
      });
      expect(sqlite.prepare("SELECT admin_notes FROM properties WHERE id = 'prop_27'").get()).toEqual({ admin_notes: NOTE });

      const zipped = parseOwnersCsv(
        "email,name,lot_number,street_address,zip\ncasey.nguyen@example.com,Casey Nguyen,27,\"Lot 27, Tang O Mar Drive\",32541\n",
        { city: "Miramar Beach", state: "FL", postalCode: "32550", today: "2026-10-07" },
      );
      expect(zipped.errors).toEqual([]);
      const applied = await importOwners(db, tango, actor, zipped.rows);
      expect(applied.errors).toEqual([]);
      expect(sqlite.prepare("SELECT city, state, postal_code, house_name FROM properties WHERE id = 'prop_27'").get()).toEqual({
        city: "Miramar Beach",
        state: "FL",
        postal_code: "32541",
        house_name: "MELOMAR",
      });
    } finally {
      sqlite.close();
    }
  });

  it("does not give the owner property page a place to render admin notes", () => {
    const html = propertyPage({
      association: tango,
      lotNumber: "14",
      houseName: "MELOMAR",
      streetAddress: "Lot 14, Tang O Mar Drive",
      city: "Miramar Beach",
      state: "FL",
      postalCode: "32550",
      mailingStreet: "100 Oak Street",
      mailingCity: "Destin",
      mailingState: "FL",
      mailingPostalCode: "32541",
      contacts: [{ name: "Sam Rivera", phone: "850-555-0102", isPrimary: true }],
    });
    expect(html).toContain("MELOMAR");
    expect(html).toContain("Lot 14, Tang O Mar Drive<br>Miramar Beach, FL 32550");
    expect(html).toContain("Mailing address (if different)<br>100 Oak Street<br>Destin, FL 32541");
    expect(html).toContain("850-555-0102");
    expect(html).not.toContain("Admin notes");
    expect(html).not.toContain("admin_notes");
    expect(html).not.toContain("\u2014");
    expect(html).not.toContain("\u2013");
  });

  it("shows only the stored property address and says mailing matches when mailing is blank", () => {
    const html = propertyPage({
      association: tango,
      lotNumber: "14",
      houseName: "",
      streetAddress: "Lot 14, Tang O Mar Drive",
      city: "",
      state: "",
      postalCode: "",
      mailingStreet: "",
      mailingCity: "",
      mailingState: "",
      mailingPostalCode: "",
      contacts: [],
    });
    expect(html).toContain("Lot 14, Tang O Mar Drive");
    expect(html).not.toContain("Miramar Beach");
    expect(html).toContain("Mailing address matches the property address.");
    expect(html).not.toContain("Mailing address (if different)<br>");
    expect(html).not.toContain("such as MELOMAR");
    expect(html).not.toContain("\u2014");
    expect(html).not.toContain("\u2013");
  });
});
