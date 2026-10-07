import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { groupDocuments, placeDocumentFolder } from "../src/lib/categories";
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
}

const THROUGH_MESSAGES = [
  "migrations/0001_schema.sql",
  "migrations/0002_seed_tango_mar.sql",
  "migrations/0003_join_requests.sql",
  "migrations/0004_join_request_approved.sql",
  "migrations/0005_admin_improvements.sql",
  "migrations/0006_notice_attachments.sql",
  "migrations/0007_message_reviewed.sql",
];

const THROUGH_DATE = [
  ...THROUGH_MESSAGES,
  "migrations/0008_document_folders.sql",
  "migrations/0009_master_admin.sql",
  "migrations/0010_document_date.sql",
];

function openPortal(files: string[]): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of files) sqlite.exec(readFileSync(file, "utf8"));
  return { sqlite, db: new SqliteD1(sqlite) as unknown as D1Database };
}

function portalEnv(db: D1Database): Env {
  const bucket = {
    async head() {
      return null;
    },
    async put() {},
    async get() {
      return null;
    },
    async delete() {},
  };
  return {
    DB: db,
    APP_ENV: "production",
    EMAIL_FROM: "Tango Mar <donotreply@mytangomar.com>",
    DOCUMENTS: bucket as unknown as R2Bucket,
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

function savedDocument(sqlite: DatabaseSync, id: string): { category: string; folder: string; document_date: string } {
  return sqlite.prepare("SELECT category, folder, document_date FROM documents WHERE id = ?").get(id) as {
    category: string;
    folder: string;
    document_date: string;
  };
}

describe("document date placement", () => {
  it("files a dated document under that year only for year folders", () => {
    expect(placeDocumentFolder("minutes", "", "2024-03-15")).toBe("2024");
    expect(placeDocumentFolder("budgets", "2023", "2026-02-01")).toBe("2026");
    expect(placeDocumentFolder("insurance_docs", "January", "2025-06-01")).toBe("2025/January");
    expect(placeDocumentFolder("minutes", "2024/January", "2024-03-15")).toBe("2024/January");
    expect(placeDocumentFolder("minutes", "2024/January", "2025-01-09")).toBe("2025/January");
    expect(placeDocumentFolder("minutes", "2024", "")).toBe("2024");
    expect(placeDocumentFolder("bylaws", "", "2018-06-01")).toBe("");
    expect(placeDocumentFolder("insurance", "", "2025-06-01")).toBe("");
    expect(placeDocumentFolder("covenants", "Notes", "2020-01-01")).toBe("Notes");
  });

  it("adds the date column for databases that already have folders", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON");
    for (const file of THROUGH_DATE) sqlite.exec(readFileSync(file, "utf8"));
    const columns = sqlite.prepare("PRAGMA table_info(documents)").all() as { name: string }[];
    expect(columns.map((column) => column.name)).toContain("document_date");
    const budget = sqlite.prepare("SELECT document_date, folder FROM documents WHERE id = 'doc_budget'").get() as {
      document_date: string;
      folder: string;
    };
    expect(budget).toEqual({ document_date: "", folder: "" });
    sqlite.close();
  });
});

describe("saving a document date", () => {
  it("saves a date on an existing document and reuses the year folder", async () => {
    const { sqlite, db } = openPortal(THROUGH_MESSAGES);
    const app = createApp();
    const env = portalEnv(db);
    const token = await signIn(sqlite, "user_jordan");
    sqlite
      .prepare(
        "INSERT INTO documents (id, association_id, category, title, visibility, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("doc_minutes_march", "assoc_tango_mar", "minutes", "March minutes", "residents", "2026-10-01T15:00:00Z");
    sqlite
      .prepare(
        "INSERT INTO documents (id, association_id, category, title, visibility, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("doc_minutes_august", "assoc_tango_mar", "minutes", "August minutes", "residents", "2026-10-01T15:00:00Z");
    sqlite
      .prepare(
        "INSERT INTO documents (id, association_id, category, title, visibility, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("doc_bylaws", "assoc_tango_mar", "bylaws", "Recorded bylaws", "residents", "2026-10-01T15:00:00Z");
    sqlite
      .prepare(
        "INSERT INTO documents (id, association_id, category, title, visibility, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("doc_other", "assoc_tango_mar", "insurance", "Warranty deed", "residents", "2026-10-01T15:00:00Z");
    try {
      const before = sqlite.prepare("PRAGMA table_info(documents)").all() as { name: string }[];
      expect(before.map((column) => column.name)).not.toContain("folder");
      expect(before.map((column) => column.name)).not.toContain("document_date");

      const saved = await app.request(
        "http://localhost/a/tango-mar/admin/documents/doc_budget/visibility",
        post(token, { category: "budgets", visibility: "board", document_date: "2026-02-01", folder: "" }),
        env,
      );
      expect(saved.status).toBe(303);
      expect(decodeURIComponent(saved.headers.get("Set-Cookie") ?? "")).toContain("Saved.");
      expect(savedDocument(sqlite, "doc_budget")).toEqual({
        category: "budgets",
        folder: "2026",
        document_date: "2026-02-01",
      });

      const moved = await app.request(
        "http://localhost/a/tango-mar/admin/documents/doc_budget/visibility",
        post(token, { category: "budgets", visibility: "board", document_date: "2025-11-02", folder: "2026" }),
        env,
      );
      expect(moved.status).toBe(303);
      expect(savedDocument(sqlite, "doc_budget")).toEqual({
        category: "budgets",
        folder: "2025",
        document_date: "2025-11-02",
      });

      const march = await app.request(
        "http://localhost/a/tango-mar/admin/documents/doc_minutes_march/visibility",
        post(token, { category: "minutes", visibility: "residents", document_date: "2024-03-15", folder: "January" }),
        env,
      );
      expect(march.status).toBe(303);
      expect(savedDocument(sqlite, "doc_minutes_march")).toEqual({
        category: "minutes",
        folder: "2024/January",
        document_date: "2024-03-15",
      });
      const august = await app.request(
        "http://localhost/a/tango-mar/admin/documents/doc_minutes_august/visibility",
        post(token, { category: "minutes", visibility: "residents", document_date: "2024-08-20", folder: "" }),
        env,
      );
      expect(august.status).toBe(303);
      expect(savedDocument(sqlite, "doc_minutes_august").folder).toBe("2024");

      const minutes = groupDocuments(
        sqlite.prepare("SELECT id, category, title, folder FROM documents WHERE category = 'minutes'").all() as {
          id: string;
          category: string;
          title: string;
          folder: string;
        }[],
      ).find((group) => group.id === "minutes");
      expect(minutes?.children.map((folder) => folder.name)).toEqual(["2024"]);
      expect(minutes?.children[0]?.count).toBe(2);
      expect(minutes?.children[0]?.files.map((file) => file.title)).toEqual(["August minutes"]);
      expect(minutes?.children[0]?.children[0]?.name).toBe("January");

      const bylaws = await app.request(
        "http://localhost/a/tango-mar/admin/documents/doc_bylaws/visibility",
        post(token, { category: "bylaws", visibility: "residents", document_date: "2018-06-01", folder: "" }),
        env,
      );
      expect(bylaws.status).toBe(303);
      expect(savedDocument(sqlite, "doc_bylaws")).toEqual({
        category: "bylaws",
        folder: "",
        document_date: "2018-06-01",
      });

      const other = await app.request(
        "http://localhost/a/tango-mar/admin/documents/doc_other/visibility",
        post(token, { category: "insurance", visibility: "residents", document_date: "2021-04-04", folder: "" }),
        env,
      );
      expect(other.status).toBe(303);
      expect(savedDocument(sqlite, "doc_other")).toEqual({
        category: "insurance",
        folder: "",
        document_date: "2021-04-04",
      });

      const rejected = await app.request(
        "http://localhost/a/tango-mar/admin/documents/doc_bylaws/visibility",
        post(token, { category: "bylaws", visibility: "residents", document_date: "March 15, 2024", folder: "" }),
        env,
      );
      expect(rejected.status).toBe(303);
      expect(decodeURIComponent(rejected.headers.get("Set-Cookie") ?? "")).toContain("Enter a valid date");
      expect(savedDocument(sqlite, "doc_bylaws").document_date).toBe("2018-06-01");

      const list = await app.request(
        "http://localhost/a/tango-mar/admin/documents",
        { headers: { Cookie: `tango_session=${token}` } },
        env,
      );
      expect(list.status).toBe(200);
      const listHtml = await list.text();
      expect(listHtml).toContain("March minutes");
      expect(listHtml).toContain("2024/January");
      expect(listHtml).toContain('name="document_date"');

      const page = await app.request(
        "http://localhost/a/tango-mar/admin/documents/doc_minutes_march",
        { headers: { Cookie: `tango_session=${token}` } },
        env,
      );
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('name="document_date"');
      expect(html).toContain('type="date"');
      expect(html).toContain('value="2024-03-15"');
      expect(html).toContain('value="2024/January"');

      const versions = sqlite.prepare("SELECT COUNT(*) AS n FROM document_versions").get() as { n: number };
      expect(Number(versions.n)).toBe(2);
    } finally {
      sqlite.close();
    }
  });

  it("saves a date when publishing, and files Insurance under that year", async () => {
    const { sqlite, db } = openPortal(THROUGH_DATE);
    const app = createApp();
    const env = portalEnv(db);
    const token = await signIn(sqlite, "user_jordan");
    try {
      const body = new FormData();
      body.set("title", "March agenda");
      body.set("category", "minutes");
      body.set("visibility", "residents");
      body.set("document_date", "2024-03-15");
      body.set("folder", "");
      body.set("notes", "Board agenda");
      body.set("file", new File(["Agenda"], "agenda.txt", { type: "text/plain" }));
      const created = await app.request(
        "http://localhost/a/tango-mar/admin/documents",
        {
          method: "POST",
          headers: { Cookie: `tango_session=${token}`, Origin: "http://localhost" },
          body,
        },
        env,
      );
      expect(created.status).toBe(303);
      const published = sqlite.prepare("SELECT id, category, folder, document_date FROM documents WHERE title = 'March agenda'").get() as {
        id: string;
        category: string;
        folder: string;
        document_date: string;
      };
      expect(published.category).toBe("minutes");
      expect(published.folder).toBe("2024");
      expect(published.document_date).toBe("2024-03-15");

      sqlite
        .prepare(
          "INSERT INTO documents (id, association_id, category, title, visibility, folder, document_date) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("doc_policy", "assoc_tango_mar", "insurance_docs", "HOA policy", "residents", "", "");
      const policy = await app.request(
        "http://localhost/a/tango-mar/admin/documents/doc_policy/visibility",
        post(token, { category: "insurance_docs", visibility: "residents", document_date: "2025-06-01", folder: "" }),
        env,
      );
      expect(policy.status).toBe(303);
      expect(savedDocument(sqlite, "doc_policy")).toEqual({
        category: "insurance_docs",
        folder: "2025",
        document_date: "2025-06-01",
      });

      const again = await app.request(
        "http://localhost/a/tango-mar/admin/documents/doc_budget/visibility",
        post(token, { category: "budgets", visibility: "board", document_date: "2025-06-01", folder: "" }),
        env,
      );
      expect(again.status).toBe(303);
      expect(savedDocument(sqlite, "doc_budget").folder).toBe("2025");
      const budgets = groupDocuments([
        { category: "budgets", title: "2026 budget (sample)", folder: savedDocument(sqlite, "doc_budget").folder },
        { category: "insurance_docs", title: "HOA policy", folder: "2025" },
      ]);
      expect(budgets.find((group) => group.id === "budgets")?.children.map((folder) => folder.name)).toEqual(["2025"]);
      expect(budgets.find((group) => group.id === "insurance_docs")?.children.map((folder) => folder.name)).toEqual(["2025"]);
    } finally {
      sqlite.close();
    }
  });
});

describe("signed-in documents page", () => {
  it("shows board-only files below resident folders and hides them from homeowners", async () => {
    const { sqlite, db } = openPortal(THROUGH_DATE);
    const app = createApp();
    const env = portalEnv(db);
    const jordan = await signIn(sqlite, "user_jordan");
    const sam = await signIn(sqlite, "user_sam");
    sqlite.prepare("UPDATE documents SET folder = ?, document_date = ? WHERE id = ?").run("2026", "2026-02-01", "doc_budget");
    sqlite
      .prepare(
        "INSERT INTO documents (id, association_id, category, title, visibility, folder, document_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "doc_closed",
        "assoc_tango_mar",
        "minutes",
        "Closed session",
        "board",
        "2024/January",
        "2024-01-12",
        "2026-10-01T15:00:00Z",
      );
    try {
      const boardPage = await app.request("http://localhost/a/tango-mar/documents", { headers: { Cookie: `tango_session=${jordan}` } }, env);
      expect(boardPage.status).toBe(200);
      const boardHtml = await boardPage.text();
      const split = boardHtml.indexOf("<h2>Board only</h2>");
      expect(split).toBeGreaterThan(boardHtml.indexOf("<h1>Documents</h1>"));
      const resident = boardHtml.slice(0, split);
      const board = boardHtml.slice(split);
      expect(resident).toContain("Tango Mar covenants (sample)");
      expect(resident).toContain("Budgets");
      expect(resident).not.toContain("2026 budget (sample)");
      expect(resident).not.toContain("Closed session");
      expect(resident).not.toContain("Private to board members.");
      expect(board).toContain("<p class=\"muted\">Private to board members.</p>");
      expect(board).toContain("2026 budget (sample)");
      expect(board).toContain('data-path="2026"');
      expect(board).toContain("Closed session");
      expect(board).toContain('data-path="2024/January"');
      expect(board).not.toContain('type="file"');
      expect(board).not.toContain("Publish");
      expect(board).not.toContain("\u2014");
      expect(board).not.toContain("\u2013");

      const ownerPage = await app.request("http://localhost/a/tango-mar/documents", { headers: { Cookie: `tango_session=${sam}` } }, env);
      expect(ownerPage.status).toBe(200);
      const ownerHtml = await ownerPage.text();
      expect(ownerHtml).toContain("Tango Mar covenants (sample)");
      expect(ownerHtml).not.toContain("Board only");
      expect(ownerHtml).not.toContain("Private to board members.");
      expect(ownerHtml).not.toContain("2026 budget (sample)");
      expect(ownerHtml).not.toContain("Closed session");

      const denied = await app.request(
        "http://localhost/a/tango-mar/documents/doc_budget/file",
        { headers: { Cookie: `tango_session=${sam}` } },
        env,
      );
      expect(denied.status).toBe(403);
      expect(await denied.text()).not.toContain("2026 budget");
    } finally {
      sqlite.close();
    }
  });
});
