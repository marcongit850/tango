import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { sha256Hex } from "../src/lib/tokens";
import { MAX_DOCUMENT_BYTES } from "../src/lib/files";
import type { Association } from "../src/types";
import { messagesPage } from "../src/views/resident";

const ASSOCIATION = "assoc_tango_mar";

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

const SCHEMA = [
  "migrations/0001_schema.sql",
  "migrations/0002_seed_tango_mar.sql",
  "migrations/0003_join_requests.sql",
  "migrations/0004_join_request_approved.sql",
  "migrations/0005_admin_improvements.sql",
  "migrations/0006_notice_attachments.sql",
  "migrations/0007_message_reviewed.sql",
];

type StoredFile = { body: Uint8Array; contentType: string };

class MemoryBucket {
  objects = new Map<string, StoredFile>();

  async put(key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<void> {
    const body = value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value);
    this.objects.set(key, { body, contentType: options?.httpMetadata?.contentType ?? "" });
  }

  async get(key: string): Promise<{ body: Uint8Array; writeHttpMetadata: (headers: Headers) => void } | null> {
    const found = this.objects.get(key);
    if (!found) return null;
    const contentType = found.contentType;
    return {
      body: found.body,
      writeHttpMetadata(headers: Headers) {
        if (contentType) headers.set("Content-Type", contentType);
      },
    };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

function openPortal(files: string[]): { sqlite: DatabaseSync; db: D1Database; bucket: MemoryBucket } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of files) sqlite.exec(readFileSync(file, "utf8"));
  const bucket = new MemoryBucket();
  return { sqlite, db: new SqliteD1(sqlite) as unknown as D1Database, bucket };
}

function portalEnv(db: D1Database, bucket: MemoryBucket): Env {
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
    .run(`sess_${userId}_${crypto.randomUUID()}`, userId, await sha256Hex(token), "2099-01-01T00:00:00.000Z", "2026-10-06T00:00:00.000Z");
  return token;
}

function messageCount(sqlite: DatabaseSync): number {
  const row = sqlite.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number };
  return Number(row.n);
}

describe("owner message files", () => {
  it("offers an optional file under the message box", () => {
    const html = messagesPage(association, [], [{ id: "prop_27", lot_number: "27" }]);
    const form = html.slice(html.indexOf("<form"));
    expect(form).toContain('enctype="multipart/form-data"');
    expect(form).toContain("Attach a file (optional)");
    expect(form).toContain('type="file"');
    expect(form).toContain('name="file"');
    expect(form.indexOf('name="body"')).toBeLessThan(form.indexOf('name="file"'));
    expect(form.indexOf('name="file"')).toBeLessThan(form.indexOf(">Send</button>"));
    expect(html).not.toContain("\u2014");
    expect(html).not.toContain("\u2013");
  });

  it("stores up to 3 files and lets the sender and staff open them", async () => {
    const { sqlite, db, bucket } = openPortal([...SCHEMA, "migrations/0012_message_attachments.sql"]);
    const app = createApp();
    const env = portalEnv(db, bucket);
    const casey = await signIn(sqlite, "user_casey");
    const jordan = await signIn(sqlite, "user_jordan");
    const sam = await signIn(sqlite, "user_sam");
    const before = messageCount(sqlite);
    try {
      const body = new FormData();
      body.set("subject", "Sprinkler leak");
      body.set("body", "The valve by lot 27 is dripping.");
      body.set("property_id", "prop_27");
      body.append("file", new File(["OWNER-FILE-PDF"], "gate code.pdf", { type: "application/pdf" }));
      body.append("file", new File(["OWNER-FILE-PNG"], "valve.png", { type: "image/png" }));
      const sent = await app.request(
        "http://localhost/a/tango-mar/messages",
        { method: "POST", headers: { Cookie: `tango_session=${casey}`, Origin: "http://localhost" }, body },
        env,
      );
      expect(sent.status).toBe(303);
      const threadId = new URL(sent.headers.get("Location") ?? "", "http://localhost").pathname.split("/").pop() ?? "";
      expect(threadId).not.toBe("");
      expect(messageCount(sqlite)).toBe(before + 1);

      const stored = sqlite
        .prepare(
          "SELECT filename, content_type, r2_key, byte_size FROM message_attachments WHERE message_id = ? ORDER BY created_at",
        )
        .all(threadId) as { filename: string; content_type: string; r2_key: string; byte_size: number }[];
      expect(stored.map((row) => row.filename)).toEqual(["gate-code.pdf", "valve.png"]);
      expect(stored[0]?.content_type).toBe("application/pdf");
      expect(stored[1]?.content_type).toBe("image/png");
      expect(stored[0]?.r2_key.startsWith(`${ASSOCIATION}/messages/${threadId}/`)).toBe(true);
      expect(stored[0]?.r2_key.endsWith("/gate-code.pdf")).toBe(true);
      expect(bucket.objects.get(stored[0]?.r2_key ?? "")?.contentType).toBe("application/pdf");
      expect(new TextDecoder().decode(bucket.objects.get(stored[0]?.r2_key ?? "")?.body)).toBe("OWNER-FILE-PDF");

      const ownerPage = await app.request(
        `http://localhost/a/tango-mar/messages/${threadId}`,
        { headers: { Cookie: `tango_session=${casey}` } },
        env,
      );
      expect(ownerPage.status).toBe(200);
      const ownerHtml = await ownerPage.text();
      expect(ownerHtml).toContain("gate-code.pdf");
      expect(ownerHtml).toContain("valve.png");
      expect(ownerHtml).toContain(`/a/tango-mar/messages/${threadId}/messages/${threadId}/file/`);
      expect(ownerHtml).not.toContain(`/admin/messages/${threadId}/messages/`);
      expect(ownerHtml).not.toContain("r2.dev");
      expect(ownerHtml).not.toContain("cloudflarestorage");
      const pngView = ownerHtml.match(new RegExp(`href="(/a/tango-mar/messages/${threadId}/messages/${threadId}/file/[^"?]+)"`));
      const pdfDownload = ownerHtml.match(
        new RegExp(`href="(/a/tango-mar/messages/${threadId}/messages/${threadId}/file/[^"?]+\\?download=1)"`),
      );
      expect(pngView?.[1]).toBeTruthy();
      expect(pdfDownload?.[1]).toBeTruthy();

      const image = await app.request(`http://localhost${pngView?.[1]}`, { headers: { Cookie: `tango_session=${casey}` } }, env);
      expect(image.status).toBe(200);
      expect(image.headers.get("Content-Type")).toBe("image/png");
      expect(image.headers.get("Content-Disposition")).toMatch(/^inline;/);
      expect(image.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(image.headers.get("Cache-Control")).toBe("private, no-store");
      expect(new TextDecoder().decode(await image.arrayBuffer())).toBe("OWNER-FILE-PNG");

      const forced = await app.request(
        `http://localhost${pngView?.[1]}?download=1`,
        { headers: { Cookie: `tango_session=${casey}` } },
        env,
      );
      expect(forced.headers.get("Content-Disposition")).toMatch(/^attachment;/);

      const pdf = await app.request(
        `http://localhost${pdfDownload?.[1]}`,
        { headers: { Cookie: `tango_session=${casey}` } },
        env,
      );
      expect(pdf.status).toBe(200);
      expect(pdf.headers.get("Content-Type")).toBe("application/pdf");
      expect(pdf.headers.get("Content-Disposition")).toMatch(/^attachment; filename="gate-code.pdf"/);
      expect(new TextDecoder().decode(await pdf.arrayBuffer())).toBe("OWNER-FILE-PDF");

      const adminPage = await app.request(
        `http://localhost/a/tango-mar/admin/messages/${threadId}`,
        { headers: { Cookie: `tango_session=${jordan}` } },
        env,
      );
      expect(adminPage.status).toBe(200);
      const adminHtml = await adminPage.text();
      expect(adminHtml).toContain("gate-code.pdf");
      const adminFile = adminHtml.match(
        new RegExp(`href="(/a/tango-mar/admin/messages/${threadId}/messages/${threadId}/file/[^"?]+\\?download=1)"`),
      );
      expect(adminFile?.[1]).toBeTruthy();
      const staffDownload = await app.request(
        `http://localhost${adminFile?.[1]}`,
        { headers: { Cookie: `tango_session=${jordan}` } },
        env,
      );
      expect(staffDownload.status).toBe(200);
      expect(new TextDecoder().decode(await staffDownload.arrayBuffer())).toBe("OWNER-FILE-PDF");

      const other = await app.request(
        `http://localhost${pngView?.[1]}`,
        { headers: { Cookie: `tango_session=${sam}` } },
        env,
      );
      expect(other.status).toBe(403);
      expect(await other.text()).not.toContain("OWNER-FILE-PNG");
      const otherAdmin = await app.request(
        `http://localhost${adminFile?.[1]}`,
        { headers: { Cookie: `tango_session=${sam}` } },
        env,
      );
      expect(otherAdmin.status).toBe(403);

      sqlite
        .prepare(
          `INSERT INTO property_owners (id, association_id, property_id, user_id, is_primary, created_at)
           VALUES ('own_sam_27', ?, 'prop_27', 'user_sam', 0, '2026-10-06T00:00:00.000Z')`,
        )
        .run(ASSOCIATION);
      const coOwner = await app.request(
        `http://localhost${pngView?.[1]}`,
        { headers: { Cookie: `tango_session=${sam}` } },
        env,
      );
      expect(coOwner.status).toBe(403);
      expect(await coOwner.text()).not.toContain("OWNER-FILE-PNG");

      const anonymous = await app.request(`http://localhost${pngView?.[1]}`, {}, env);
      expect(anonymous.status).toBe(303);

      const removed = await app.request(
        `http://localhost/a/tango-mar/admin/messages/${threadId}/delete`,
        {
          method: "POST",
          headers: {
            Cookie: `tango_session=${jordan}`,
            Origin: "http://localhost",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ confirm: "yes" }),
        },
        env,
      );
      expect(removed.status).toBe(303);
      expect(bucket.objects.size).toBe(0);
      expect(
        sqlite.prepare("SELECT COUNT(*) AS n FROM message_attachments WHERE message_id = ?").get(threadId),
      ).toEqual({ n: 0 });
    } finally {
      sqlite.close();
    }
  });

  it("rejects a disallowed type, a file over 8 MB, and more than 3 files", async () => {
    const { sqlite, db, bucket } = openPortal([...SCHEMA, "migrations/0012_message_attachments.sql"]);
    const app = createApp();
    const env = portalEnv(db, bucket);
    const casey = await signIn(sqlite, "user_casey");
    const before = messageCount(sqlite);
    try {
      const exe = new FormData();
      exe.set("subject", "Bad type");
      exe.set("body", "This should not send.");
      exe.set("file", new File(["MZ"], "notes.exe", { type: "application/octet-stream" }));
      const rejectedType = await app.request(
        "http://localhost/a/tango-mar/messages",
        { method: "POST", headers: { Cookie: `tango_session=${casey}`, Origin: "http://localhost" }, body: exe },
        env,
      );
      expect(rejectedType.status).toBe(303);
      expect(decodeURIComponent(rejectedType.headers.get("Set-Cookie") ?? "")).toContain("PDF, text file, image, or Word");
      expect(messageCount(sqlite)).toBe(before);
      expect(bucket.objects.size).toBe(0);

      const huge = new FormData();
      huge.set("subject", "Too big");
      huge.set("body", "This should not send.");
      huge.set("file", new File([new Uint8Array(MAX_DOCUMENT_BYTES + 1)], "big.pdf", { type: "application/pdf" }));
      const rejectedSize = await app.request(
        "http://localhost/a/tango-mar/messages",
        { method: "POST", headers: { Cookie: `tango_session=${casey}`, Origin: "http://localhost" }, body: huge },
        env,
      );
      expect(rejectedSize.status).toBe(303);
      expect(decodeURIComponent(rejectedSize.headers.get("Set-Cookie") ?? "")).toContain("8 MB");
      expect(messageCount(sqlite)).toBe(before);
      expect(bucket.objects.size).toBe(0);

      const many = new FormData();
      many.set("subject", "Too many");
      many.set("body", "This should not send.");
      for (let index = 0; index < 4; index += 1) {
        many.append("file", new File([`note ${index}`], `note-${index}.txt`, { type: "text/plain" }));
      }
      const rejectedCount = await app.request(
        "http://localhost/a/tango-mar/messages",
        { method: "POST", headers: { Cookie: `tango_session=${casey}`, Origin: "http://localhost" }, body: many },
        env,
      );
      expect(rejectedCount.status).toBe(303);
      expect(decodeURIComponent(rejectedCount.headers.get("Set-Cookie") ?? "")).toContain("Attach up to 3 files.");
      expect(messageCount(sqlite)).toBe(before);
      expect(bucket.objects.size).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it("still sends a message without a file, and refuses a file until the table exists", async () => {
    const { sqlite, db, bucket } = openPortal(SCHEMA);
    const app = createApp();
    const env = portalEnv(db, bucket);
    const casey = await signIn(sqlite, "user_casey");
    const before = messageCount(sqlite);
    try {
      const page = await app.request(
        "http://localhost/a/tango-mar/messages",
        { headers: { Cookie: `tango_session=${casey}` } },
        env,
      );
      expect(page.status).toBe(200);

      const withFile = new FormData();
      withFile.set("subject", "Needs the table");
      withFile.set("body", "Please apply the migration.");
      withFile.set("file", new File(["hello"], "note.txt", { type: "text/plain" }));
      const blocked = await app.request(
        "http://localhost/a/tango-mar/messages",
        { method: "POST", headers: { Cookie: `tango_session=${casey}`, Origin: "http://localhost" }, body: withFile },
        env,
      );
      expect(blocked.status).toBe(303);
      expect(decodeURIComponent(blocked.headers.get("Set-Cookie") ?? "")).toContain("message file migration");
      expect(messageCount(sqlite)).toBe(before);
      expect(bucket.objects.size).toBe(0);

      const plain = await app.request(
        "http://localhost/a/tango-mar/messages",
        {
          method: "POST",
          headers: {
            Cookie: `tango_session=${casey}`,
            Origin: "http://localhost",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ subject: "No file", body: "Just a note." }),
        },
        env,
      );
      expect(plain.status).toBe(303);
      expect(plain.headers.get("Location") ?? "").toMatch(/\/a\/tango-mar\/messages\//);
      expect(messageCount(sqlite)).toBe(before + 1);
    } finally {
      sqlite.close();
    }
  });

  it("does not serve a stored type outside the document list", async () => {
    const { sqlite, db, bucket } = openPortal([...SCHEMA, "migrations/0012_message_attachments.sql"]);
    const app = createApp();
    const env = portalEnv(db, bucket);
    const casey = await signIn(sqlite, "user_casey");
    try {
      sqlite
        .prepare(
          `INSERT INTO messages (id, association_id, thread_id, parent_id, from_user_id, property_id, subject, body, created_at)
           VALUES ('msg_html', ?, 'msg_html', NULL, 'user_casey', 'prop_27', 'Bad file', 'nope', '2026-10-07T00:00:00.000Z')`,
        )
        .run(ASSOCIATION);
      sqlite
        .prepare(
          `INSERT INTO message_attachments (id, association_id, message_id, filename, content_type, r2_key, byte_size, created_at)
           VALUES ('file_html', ?, 'msg_html', 'page.html', 'text/html', 'assoc_tango_mar/messages/msg_html/file_html/page.html', 5, '2026-10-07T00:00:00.000Z')`,
        )
        .run(ASSOCIATION);
      bucket.objects.set("assoc_tango_mar/messages/msg_html/file_html/page.html", {
        body: new TextEncoder().encode("<script>alert(1)</script>"),
        contentType: "text/html",
      });
      const response = await app.request(
        "http://localhost/a/tango-mar/messages/msg_html/messages/msg_html/file/file_html",
        { headers: { Cookie: `tango_session=${casey}` } },
        env,
      );
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("<script>");
    } finally {
      sqlite.close();
    }
  });
});
