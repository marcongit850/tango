import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { deletePersonAccount, listOwners } from "../src/db";
import { MASTER_ADMIN_DELETE_MESSAGE, MASTER_ADMIN_EDIT_MESSAGE } from "../src/lib/access";
import { importOwners } from "../src/lib/import-owners";
import { sha256Hex } from "../src/lib/tokens";
import type { Association } from "../src/types";
import { adminHome, ownerDetailPage, ownersPage } from "../src/views/admin";

const THROUGH_FOLDERS = [
  "migrations/0001_schema.sql",
  "migrations/0002_seed_tango_mar.sql",
  "migrations/0003_join_requests.sql",
  "migrations/0004_join_request_approved.sql",
  "migrations/0005_admin_improvements.sql",
  "migrations/0006_notice_attachments.sql",
  "migrations/0007_message_reviewed.sql",
  "migrations/0008_document_folders.sql",
];

const MASTER = "migrations/0009_master_admin.sql";

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

function apply(sqlite: DatabaseSync, files: string[]): void {
  for (const file of files) sqlite.exec(readFileSync(file, "utf8"));
}

function openSeed(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  apply(sqlite, THROUGH_FOLDERS);
  return sqlite;
}

function addMarcAndNeighbor(sqlite: DatabaseSync): void {
  sqlite.exec(`
    INSERT INTO users (id, email, name, phone, created_at) VALUES
      ('user_marc', 'marc@whpinc.com', 'Marc', '', '2026-10-02T00:00:00Z'),
      ('user_pat', 'pat@example.com', 'Pat Lee', '', '2026-10-03T00:00:00Z'),
      ('user_quinn', 'quinn@example.com', 'Quinn Harper', '', '2026-10-03T01:00:00Z');
    INSERT INTO associations (id, slug, name, legal_name, created_at) VALUES
      ('assoc_other', 'other-shore', 'Other Shore', 'Other Shore POA', '2026-10-03T00:00:00Z');
    INSERT INTO memberships (id, association_id, user_id, role_id, is_admin, status, created_at) VALUES
      ('mem_marc', 'assoc_tango_mar', 'user_marc', 'board', 0, 'inactive', '2026-10-02T00:00:00Z'),
      ('mem_pat', 'assoc_other', 'user_pat', 'board', 1, 'active', '2026-10-03T00:00:00Z'),
      ('mem_quinn', 'assoc_other', 'user_quinn', 'homeowner', 1, 'active', '2026-10-04T00:00:00Z');
  `);
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

describe("master admin migration", () => {
  it("uses Jordan on the demo roster when Marc is not a member", () => {
    const sqlite = openSeed();
    try {
      apply(sqlite, [MASTER]);
      expect(sqlite.prepare("SELECT user_id, is_admin, status FROM memberships WHERE is_master = 1").all()).toEqual([
        { user_id: "user_jordan", is_admin: 1, status: "active" },
      ]);
      expect(() => apply(sqlite, [MASTER])).toThrow(/is_master|duplicate column/i);
    } finally {
      sqlite.close();
    }
  });

  it("marks marc@whpinc.com per association and leaves other neighborhoods their own master", () => {
    const sqlite = openSeed();
    try {
      addMarcAndNeighbor(sqlite);
      apply(sqlite, [MASTER]);
      expect(
        sqlite.prepare("SELECT role_id, is_admin, is_master, status FROM memberships WHERE user_id = 'user_marc'").get(),
      ).toEqual({ role_id: "board", is_admin: 1, is_master: 1, status: "active" });
      expect(sqlite.prepare("SELECT is_master FROM memberships WHERE user_id = 'user_jordan'").get()).toEqual({ is_master: 0 });
      expect(sqlite.prepare("SELECT user_id FROM memberships WHERE association_id = 'assoc_other' AND is_master = 1").get()).toEqual({
        user_id: "user_pat",
      });
      expect(sqlite.prepare("SELECT is_master FROM memberships WHERE user_id = 'user_quinn'").get()).toEqual({ is_master: 0 });
      expect(() => sqlite.prepare("UPDATE memberships SET is_master = 1 WHERE user_id = 'user_jordan'").run()).toThrow(/unique/i);
      expect(() => sqlite.prepare("DELETE FROM memberships WHERE user_id = 'user_marc'").run()).toThrow(/master admin cannot be deleted/i);
      expect(() => sqlite.prepare("UPDATE memberships SET is_admin = 0 WHERE user_id = 'user_marc'").run()).toThrow(/check constraint/i);
    } finally {
      sqlite.close();
    }
  });
});

describe("master admin protection", () => {
  it("blocks delete and edit-access removal for the master, and still allows both for other people", async () => {
    const sqlite = openSeed();
    addMarcAndNeighbor(sqlite);
    apply(sqlite, [MASTER]);
    const db = new SqliteD1(sqlite) as unknown as D1Database;
    const app = createApp();
    const env = portalEnv(db);
    const jordan = await signIn(sqlite, "user_jordan");
    const marc = await signIn(sqlite, "user_marc");
    const quinn = await signIn(sqlite, "user_quinn");
    try {
      expect(await deletePersonAccount(db, "assoc_tango_mar", "user_marc")).toBe("master");
      expect(sqlite.prepare("SELECT id FROM users WHERE id = 'user_marc'").get()).toEqual({ id: "user_marc" });

      const owners = await listOwners(db, "assoc_tango_mar");
      const marcRow = owners.find((owner) => owner.user_id === "user_marc");
      const samRow = owners.find((owner) => owner.user_id === "user_sam");
      expect(marcRow).toMatchObject({ is_master: 1, is_admin: 1 });
      expect(samRow).toMatchObject({ is_master: 0, is_admin: 0 });

      const listHtml = ownersPage(tango, [], owners, false, true);
      expect(listHtml).toContain("marc@whpinc.com");
      expect(listHtml.slice(listHtml.indexOf("marc@whpinc.com"), listHtml.indexOf("marc@whpinc.com") + 500)).toContain("Master admin");
      expect(listHtml.slice(listHtml.indexOf("sam.rivera@example.com"), listHtml.indexOf("sam.rivera@example.com") + 400)).not.toContain(
        "Master admin",
      );

      const detail = ownerDetailPage({ association: tango, owner: marcRow!, balance: 0, lots: [], properties: [] });
      expect(detail).toContain("Master admin");
      expect(detail).toContain('<input type="hidden" name="is_admin" value="1">');
      expect(detail).toContain('type="checkbox" value="1" checked disabled');
      expect(detail).toContain(MASTER_ADMIN_EDIT_MESSAGE);
      expect(detail).toContain(MASTER_ADMIN_DELETE_MESSAGE);
      expect(detail).not.toContain('action="/a/tango-mar/admin/owners/user_marc/delete"');
      expect(detail).not.toContain("\u2014");
      const samDetail = ownerDetailPage({ association: tango, owner: samRow!, balance: 0, lots: [], properties: [] });
      expect(samDetail).toContain('name="is_admin" value="1"');
      expect(samDetail).toContain('action="/a/tango-mar/admin/owners/user_sam/delete"');
      expect(samDetail).not.toContain("checked disabled");

      const home = adminHome({
        association: tango,
        lots: 1,
        members: 1,
        delinquent: 0,
        waiting: 0,
        pendingJoins: null,
        outstandingCents: 0,
        admins: [
          { user_id: "user_marc", name: "Marc", email: "marc@whpinc.com", is_master: 1 },
          { user_id: "user_jordan", name: "Jordan Lee", email: "jordan.lee@example.com" },
        ],
        audit: [],
      });
      expect(home).toContain('<a href="/a/tango-mar/admin/owners/user_marc">Marc</a><span class="muted">marc@whpinc.com</span><span class="muted">Master admin</span>');
      expect(home).not.toContain("jordan.lee@example.com</span><span class=\"muted\">Master admin</span>");
      expect(home).not.toContain("\u2014");

      const marcPage = await app.request("http://localhost/a/tango-mar/admin/owners/user_marc", { headers: { Cookie: `tango_session=${jordan}` } }, env);
      expect(marcPage.status).toBe(200);
      const marcHtml = await marcPage.text();
      expect(marcHtml).toContain("Master admin");
      expect(marcHtml).toContain("checked disabled");
      expect(marcHtml).not.toContain('action="/a/tango-mar/admin/owners/user_marc/delete"');
      expect(marcHtml).not.toContain("\u2014");

      const cleared = await app.request(
        "http://localhost/a/tango-mar/admin/owners/user_marc/role",
        post(jordan, { role_id: "board", status: "active" }),
        env,
      );
      expect(cleared.status).toBe(303);
      expect(flash(cleared)).toContain(`warn:${MASTER_ADMIN_EDIT_MESSAGE}`);
      expect(sqlite.prepare("SELECT is_admin, is_master, status FROM memberships WHERE user_id = 'user_marc'").get()).toEqual({
        is_admin: 1,
        is_master: 1,
        status: "active",
      });

      const inactive = await app.request(
        "http://localhost/a/tango-mar/admin/owners/user_marc/role",
        post(jordan, { role_id: "board", status: "inactive", is_admin: "1" }),
        env,
      );
      expect(inactive.status).toBe(303);
      expect(flash(inactive)).toContain(`warn:${MASTER_ADMIN_EDIT_MESSAGE}`);
      expect(sqlite.prepare("SELECT status, is_admin FROM memberships WHERE user_id = 'user_marc'").get()).toEqual({
        status: "active",
        is_admin: 1,
      });

      const kept = await app.request(
        "http://localhost/a/tango-mar/admin/owners/user_marc/role",
        post(jordan, { role_id: "homeowner", status: "active", is_admin: "1" }),
        env,
      );
      expect(kept.status).toBe(303);
      expect(flash(kept)).toContain("ok:Role saved.");
      expect(sqlite.prepare("SELECT role_id, is_admin, is_master FROM memberships WHERE user_id = 'user_marc'").get()).toEqual({
        role_id: "homeowner",
        is_admin: 1,
        is_master: 1,
      });

      const removed = await app.request(
        "http://localhost/a/tango-mar/admin/owners/user_marc/delete",
        post(jordan, { confirm: "yes" }),
        env,
      );
      expect(removed.status).toBe(303);
      expect(flash(removed)).toContain(`warn:${MASTER_ADMIN_DELETE_MESSAGE}`);
      expect(flash(removed)).not.toContain("\u2014");
      expect(sqlite.prepare("SELECT id FROM users WHERE id = 'user_marc'").get()).toEqual({ id: "user_marc" });

      const granted = await app.request(
        "http://localhost/a/tango-mar/admin/owners/user_sam/role",
        post(jordan, { role_id: "homeowner", status: "active", is_admin: "1" }),
        env,
      );
      expect(granted.status).toBe(303);
      expect(flash(granted)).toContain("ok:Role saved.");
      const revoked = await app.request(
        "http://localhost/a/tango-mar/admin/owners/user_sam/role",
        post(jordan, { role_id: "homeowner", status: "active" }),
        env,
      );
      expect(revoked.status).toBe(303);
      expect(flash(revoked)).toContain("ok:Role saved.");
      expect(sqlite.prepare("SELECT is_admin, is_master FROM memberships WHERE user_id = 'user_sam'").get()).toEqual({
        is_admin: 0,
        is_master: 0,
      });

      const casey = await app.request(
        "http://localhost/a/tango-mar/admin/owners/user_casey/delete",
        post(jordan, { confirm: "yes" }),
        env,
      );
      expect(casey.status).toBe(303);
      expect(flash(casey)).toContain("ok:Casey Nguyen deleted.");
      expect(sqlite.prepare("SELECT id FROM users WHERE id = 'user_casey'").get()).toBeUndefined();

      const demoteJordan = await app.request(
        "http://localhost/a/tango-mar/admin/owners/user_jordan/role",
        post(marc, { role_id: "board", status: "active" }),
        env,
      );
      expect(demoteJordan.status).toBe(303);
      expect(flash(demoteJordan)).toContain("ok:Role saved.");
      expect(sqlite.prepare("SELECT is_admin, is_master FROM memberships WHERE user_id = 'user_jordan'").get()).toEqual({
        is_admin: 0,
        is_master: 0,
      });

      const deleteJordan = await app.request(
        "http://localhost/a/tango-mar/admin/owners/user_jordan/delete",
        post(marc, { confirm: "yes" }),
        env,
      );
      expect(deleteJordan.status).toBe(303);
      expect(flash(deleteJordan)).toContain("ok:Jordan Lee deleted.");
      expect(sqlite.prepare("SELECT id FROM users WHERE id = 'user_jordan'").get()).toBeUndefined();
      expect(sqlite.prepare("SELECT is_master FROM memberships WHERE user_id = 'user_marc'").get()).toEqual({ is_master: 1 });

      const patPage = await app.request(
        "http://localhost/a/other-shore/admin/owners/user_pat",
        { headers: { Cookie: `tango_session=${quinn}` } },
        env,
      );
      expect(patPage.status).toBe(200);
      const patHtml = await patPage.text();
      expect(patHtml).toContain("Master admin");
      expect(patHtml).toContain("checked disabled");
      expect(patHtml).not.toContain('action="/a/other-shore/admin/owners/user_pat/delete"');

      const deletePat = await app.request(
        "http://localhost/a/other-shore/admin/owners/user_pat/delete",
        post(quinn, { confirm: "yes" }),
        env,
      );
      expect(deletePat.status).toBe(303);
      expect(flash(deletePat)).toContain(`warn:${MASTER_ADMIN_DELETE_MESSAGE}`);
      expect(sqlite.prepare("SELECT is_master FROM memberships WHERE user_id = 'user_pat'").get()).toEqual({ is_master: 1 });

      const revokeQuinn = await app.request(
        "http://localhost/a/other-shore/admin/owners/user_quinn/role",
        post(quinn, { role_id: "homeowner", status: "active" }),
        env,
      );
      expect(revokeQuinn.status).toBe(303);
      expect(flash(revokeQuinn)).toContain("ok:Role saved.");
      expect(sqlite.prepare("SELECT is_admin, is_master FROM memberships WHERE user_id = 'user_quinn'").get()).toEqual({
        is_admin: 0,
        is_master: 0,
      });

      const imported = await importOwners(
        db,
        tango,
        { id: "user_marc", email: "marc@whpinc.com", name: "Marc", phone: "" },
        [
          {
            line: 2,
            email: "marc@whpinc.com",
            name: "Marc",
            lotNumber: "88",
            streetAddress: "88 Tang O Mar Drive",
            role: "board",
            isAdmin: false,
            startingBalanceCents: 0,
            balanceAsOf: "2026-10-06",
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
          },
        ],
      );
      expect(imported.errors).toEqual([{ line: 2, message: MASTER_ADMIN_EDIT_MESSAGE }]);
      expect(sqlite.prepare("SELECT is_admin, is_master FROM memberships WHERE user_id = 'user_marc'").get()).toEqual({
        is_admin: 1,
        is_master: 1,
      });
    } finally {
      sqlite.close();
    }
  });
});
