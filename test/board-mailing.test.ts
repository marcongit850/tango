import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { sha256Hex } from "../src/lib/tokens";

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
  for (const file of [
    "migrations/0001_schema.sql",
    "migrations/0002_seed_tango_mar.sql",
    "migrations/0003_join_requests.sql",
    "migrations/0004_join_request_approved.sql",
    "migrations/0005_admin_improvements.sql",
    "migrations/0006_notice_attachments.sql",
    "migrations/0007_message_reviewed.sql",
  ]) {
    sqlite.exec(readFileSync(file, "utf8"));
  }
  sqlite
    .prepare(
      `INSERT INTO associations (
         id, slug, name, legal_name, address_line1, city, state, postal_code, county, timezone, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "assoc_other",
      "other-shore",
      "Other Shore",
      "Other Shore POA",
      "1 Other Street",
      "Other City",
      "AL",
      "11111",
      "Other County",
      "America/Chicago",
      "2026-10-01T15:00:00Z",
    );
  sqlite
    .prepare("INSERT INTO users (id, email, name, phone, created_at) VALUES (?, ?, ?, ?, ?)")
    .run("user_view", "view.only@example.com", "View Only", "", "2026-10-02T00:00:00.000Z");
  sqlite
    .prepare(
      `INSERT INTO memberships (id, association_id, user_id, role_id, status, is_admin, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("mem_view", "assoc_tango_mar", "user_view", "board", "active", 0, "2026-10-02T00:00:00.000Z");
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

function post(token: string, body: Record<string, string>, origin = "http://localhost"): RequestInit {
  const headers: Record<string, string> = {
    Cookie: `tango_session=${token}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (origin) headers.Origin = origin;
  return { method: "POST", headers, body: new URLSearchParams(body) };
}

const SEEDED_LINE = "Tango Mar Property Owners Association · 31 Tang O Mar Drive, Miramar Beach, FL, 32550";
const SEEDED_ROW = {
  legal_name: "Tango Mar Property Owners Association",
  address_line1: "31 Tang O Mar Drive",
  city: "Miramar Beach",
  state: "FL",
  postal_code: "32550",
  county: "Walton County",
  timezone: "America/Chicago",
};

function mailingRow(sqlite: DatabaseSync, id = "assoc_tango_mar") {
  return sqlite
    .prepare(
      `SELECT legal_name, address_line1, city, state, postal_code, county, timezone
       FROM associations WHERE id = ?`,
    )
    .get(id);
}

describe("board mailing address", () => {
  it("shows Edit only to someone with edit access", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const admin = await signIn(sqlite, "user_jordan");
    const owner = await signIn(sqlite, "user_sam");
    const viewer = await signIn(sqlite, "user_view");
    try {
      const adminPage = await app.request("http://localhost/a/tango-mar/board", { headers: { Cookie: `tango_session=${admin}` } }, env);
      expect(adminPage.status).toBe(200);
      const adminHtml = await adminPage.text();
      expect(adminHtml).toContain(SEEDED_LINE);
      expect(adminHtml).toContain("Riley Chen");
      expect(adminHtml).toContain('<summary class="button secondary">Edit</summary>');
      expect(adminHtml).toContain('action="/a/tango-mar/board"');
      expect(adminHtml).toContain('name="legal_name"');
      expect(adminHtml).toContain('value="Tango Mar Property Owners Association"');
      expect(adminHtml).toContain('name="address_line1"');
      expect(adminHtml).toContain('value="31 Tang O Mar Drive"');
      expect(adminHtml).toContain('value="Miramar Beach"');
      expect(adminHtml).toContain('value="FL"');
      expect(adminHtml).toContain('value="32550"');
      expect(adminHtml).toContain("Save mailing address");

      const ownerPage = await app.request("http://localhost/a/tango-mar/board", { headers: { Cookie: `tango_session=${owner}` } }, env);
      expect(ownerPage.status).toBe(200);
      const ownerHtml = await ownerPage.text();
      expect(ownerHtml).toContain(SEEDED_LINE);
      expect(ownerHtml).toContain("Riley Chen");
      expect(ownerHtml).not.toContain('<summary class="button secondary">Edit</summary>');
      expect(ownerHtml).not.toContain("Save mailing address");
      expect(ownerHtml).not.toContain('name="address_line1"');

      const viewPage = await app.request("http://localhost/a/tango-mar/board", { headers: { Cookie: `tango_session=${viewer}` } }, env);
      expect(viewPage.status).toBe(200);
      const viewHtml = await viewPage.text();
      expect(viewHtml).toContain(SEEDED_LINE);
      expect(viewHtml).not.toContain('<summary class="button secondary">Edit</summary>');
      expect(viewHtml).not.toContain("Save mailing address");
    } finally {
      sqlite.close();
    }
  });

  it("saves the association mailing address and shows it on the Board page", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const admin = await signIn(sqlite, "user_jordan");
    try {
      const saved = await app.request(
        "http://localhost/a/tango-mar/board",
        post(admin, {
          legal_name: "  Tang O Mar Property Owners Association  ",
          address_line1: "100 Gulf Lane",
          city: "Destin",
          state: "FL",
          postal_code: "32541",
        }),
        env,
      );
      expect(saved.status).toBe(303);
      expect(saved.headers.get("Location")).toBe("/a/tango-mar/board");
      expect(decodeURIComponent(saved.headers.get("Set-Cookie") ?? "")).toContain("Mailing address saved.");
      expect(mailingRow(sqlite)).toEqual({
        legal_name: "Tang O Mar Property Owners Association",
        address_line1: "100 Gulf Lane",
        city: "Destin",
        state: "FL",
        postal_code: "32541",
        county: "Walton County",
        timezone: "America/Chicago",
      });
      expect(mailingRow(sqlite, "assoc_other")).toEqual({
        legal_name: "Other Shore POA",
        address_line1: "1 Other Street",
        city: "Other City",
        state: "AL",
        postal_code: "11111",
        county: "Other County",
        timezone: "America/Chicago",
      });
      expect(
        sqlite.prepare("SELECT action, actor_user_id, entity_type, entity_id, detail FROM audit_log WHERE action = 'mailing_update'").get(),
      ).toEqual({
        action: "mailing_update",
        actor_user_id: "user_jordan",
        entity_type: "association",
        entity_id: "assoc_tango_mar",
        detail: "Tang O Mar Property Owners Association, 100 Gulf Lane, Destin, FL, 32541",
      });

      const board = await app.request("http://localhost/a/tango-mar/board", { headers: { Cookie: `tango_session=${admin}` } }, env);
      expect(board.status).toBe(200);
      const html = await board.text();
      expect(html).toContain("Tang O Mar Property Owners Association · 100 Gulf Lane, Destin, FL, 32541");
      expect(html).toContain('value="100 Gulf Lane"');

      const dashboard = await app.request(
        "http://localhost/a/tango-mar/dashboard",
        { headers: { Cookie: `tango_session=${admin}` } },
        env,
      );
      expect(dashboard.status).toBe(200);
      expect(await dashboard.text()).toContain("Tang O Mar Property Owners Association");
    } finally {
      sqlite.close();
    }
  });

  it("lets a homeowner with edit access save, and refuses everyone else", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const admin = await signIn(sqlite, "user_jordan");
    const owner = await signIn(sqlite, "user_sam");
    const viewer = await signIn(sqlite, "user_view");
    try {
      const ownerWrite = await app.request(
        "http://localhost/a/tango-mar/board",
        post(owner, {
          legal_name: "Changed by owner",
          address_line1: "9 Nowhere",
          city: "Nowhere",
          state: "GA",
          postal_code: "30000",
        }),
        env,
      );
      expect(ownerWrite.status).toBe(403);
      expect(mailingRow(sqlite)).toEqual(SEEDED_ROW);

      const viewerWrite = await app.request(
        "http://localhost/a/tango-mar/board",
        post(viewer, {
          legal_name: "Changed by viewer",
          address_line1: "9 Nowhere",
          city: "Nowhere",
          state: "GA",
          postal_code: "30000",
        }),
        env,
      );
      expect(viewerWrite.status).toBe(403);
      expect(mailingRow(sqlite)).toEqual(SEEDED_ROW);

      const loggedOut = await app.request(
        "http://localhost/a/tango-mar/board",
        post("", {
          legal_name: "Changed while logged out",
          address_line1: "9 Nowhere",
          city: "Nowhere",
          state: "GA",
          postal_code: "30000",
        }),
        env,
      );
      expect(loggedOut.status).toBe(303);
      expect(loggedOut.headers.get("Location")).toContain("/login");
      expect(mailingRow(sqlite)).toEqual(SEEDED_ROW);

      const missingOrigin = await app.request(
        "http://localhost/a/tango-mar/board",
        post(
          admin,
          { legal_name: "Changed without origin", address_line1: "", city: "", state: "", postal_code: "" },
          "",
        ),
        env,
      );
      expect(missingOrigin.status).toBe(403);
      expect(mailingRow(sqlite)).toEqual(SEEDED_ROW);

      sqlite.prepare("UPDATE memberships SET is_admin = 1 WHERE user_id = 'user_sam'").run();
      const granted = await app.request("http://localhost/a/tango-mar/board", { headers: { Cookie: `tango_session=${owner}` } }, env);
      expect(granted.status).toBe(200);
      expect(await granted.text()).toContain('<summary class="button secondary">Edit</summary>');

      const saved = await app.request(
        "http://localhost/a/tango-mar/board",
        post(owner, {
          legal_name: "Owner Admin Association",
          address_line1: "42 Board Walk",
          city: "Miramar Beach",
          state: "FL",
          postal_code: "32550",
        }),
        env,
      );
      expect(saved.status).toBe(303);
      expect(saved.headers.get("Location")).toBe("/a/tango-mar/board");
      expect(mailingRow(sqlite)).toMatchObject({
        legal_name: "Owner Admin Association",
        address_line1: "42 Board Walk",
      });
    } finally {
      sqlite.close();
    }
  });

  it("keeps the saved address when the legal name is blank", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const admin = await signIn(sqlite, "user_jordan");
    try {
      const rejected = await app.request(
        "http://localhost/a/tango-mar/board",
        post(admin, {
          legal_name: "   ",
          address_line1: "100 Gulf Lane",
          city: "Destin",
          state: "FL",
          postal_code: "32541",
        }),
        env,
      );
      expect(rejected.status).toBe(400);
      const html = await rejected.text();
      expect(html).toContain("Enter the legal name.");
      expect(html).toContain('<details class="mailing-edit" open>');
      expect(html).toContain('value="100 Gulf Lane"');
      expect(html).toContain(SEEDED_LINE);
      expect(mailingRow(sqlite)).toEqual(SEEDED_ROW);
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'mailing_update'").get()).toEqual({ n: 0 });
    } finally {
      sqlite.close();
    }
  });
});
