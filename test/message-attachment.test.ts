import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { MAX_DOCUMENT_BYTES, safeStoredContentType } from "../src/lib/files";
import { sha256Hex } from "../src/lib/tokens";
import type { Association } from "../src/types";
import type { MessageRow } from "../src/db";
import { adminThreadPage } from "../src/views/admin";
import { messagesPage, threadPage } from "../src/views/resident";

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
}

class MemoryBucket {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<void> {
    this.objects.set(key, { bytes: toBytes(value), contentType: options?.httpMetadata?.contentType ?? "" });
  }

  async get(key: string) {
    const object = this.objects.get(key);
    if (!object) return null;
    const bytes = object.bytes;
    return {
      body: new Blob([bytes]).stream(),
      writeHttpMetadata(headers: Headers) {
        if (object.contentType) headers.set("Content-Type", object.contentType);
      },
    };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

function toBytes(value: ArrayBuffer | ArrayBufferView | string): Uint8Array {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function openPortal(files: string[]): { sqlite: DatabaseSync; db: D1Database; bucket: MemoryBucket; env: Env } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of files) sqlite.exec(readFileSync(file, "utf8"));
  const bucket = new MemoryBucket();
  const db = new SqliteD1(sqlite) as unknown as D1Database;
  const env = {
    DB: db,
    APP_ENV: "production",
    EMAIL_FROM: "Tango Mar <donotreply@mytangomar.com>",
    DOCUMENTS: bucket as unknown as R2Bucket,
  } as Env;
  return { sqlite, db, bucket, env };
}

async function signIn(sqlite: DatabaseSync, userId: string): Promise<string> {
  const token = `session-${userId}`;
  sqlite
    .prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(`sess_${userId}`, userId, await sha256Hex(token), "2099-01-01T00:00:00.000Z", "2026-10-06T00:00:00.000Z");
  return token;
}

function messageCount(sqlite: DatabaseSync): number {
  const row = sqlite.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number };
  return Number(row.n);
}

function flash(response: Response): string {
  return decodeURIComponent(response.headers.get("Set-Cookie") ?? "");
}

function sendMessage(token: string, fields: Record<string, string>, files: File[]): RequestInit {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  for (const file of files) body.append("file", file);
  return {
    method: "POST",
    headers: { Cookie: `tango_session=${token}`, Origin: "http://localhost" },
    body,
  };
}

function post(token: string, fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: {
      Cookie: `tango_session=${token}`,
      Origin: "http://localhost",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields),
  };
}

function addNeighborAndBoard(sqlite: DatabaseSync): void {
  sqlite
    .prepare("INSERT INTO users (id, email, name, phone, created_at) VALUES (?, ?, ?, '', ?)")
    .run("user_riley", "riley.cole@example.com", "Riley Cole", "2026-10-06T00:00:00Z");
  sqlite
    .prepare("INSERT INTO users (id, email, name, phone, created_at) VALUES (?, ?, ?, '', ?)")
    .run("user_pat", "pat.nguyen@example.com", "Pat Nguyen", "2026-10-06T00:00:00Z");
  sqlite
    .prepare(
      "INSERT INTO memberships (id, association_id, user_id, role_id, status, created_at) VALUES (?, ?, ?, 'homeowner', 'active', ?)",
    )
    .run("mem_riley", ASSOCIATION, "user_riley", "2026-10-06T00:00:00Z");
  sqlite
    .prepare(
      "INSERT INTO memberships (id, association_id, user_id, role_id, status, is_admin, created_at) VALUES (?, ?, ?, 'board', 'active', 0, ?)",
    )
    .run("mem_pat", ASSOCIATION, "user_pat", "2026-10-06T00:00:00Z");
  sqlite
    .prepare(
      "INSERT INTO property_owners (id, association_id, property_id, user_id, is_primary, created_at) VALUES (?, ?, 'prop_27', ?, 0, ?)",
    )
    .run("own_riley", ASSOCIATION, "user_riley", "2026-10-06T00:00:00Z");
}

type StoredFile = { id: string; filename: string; content_type: string; r2_key: string; position: number };

function storedFiles(sqlite: DatabaseSync, messageId: string): StoredFile[] {
  return sqlite
    .prepare(
      "SELECT id, filename, content_type, r2_key, position FROM message_attachments WHERE message_id = ? ORDER BY position",
    )
    .all(messageId) as StoredFile[];
}

describe("message file form", () => {
  it("puts an optional file input under the message box", () => {
    const html = messagesPage(association, [], [{ id: "prop_27", lot_number: "27" }]);
    const form = html.slice(html.indexOf("<h2>Contact the board</h2>"));
    expect(form.indexOf('name="body"')).toBeLessThan(form.indexOf("Attach a file (optional)"));
    expect(form).toContain('enctype="multipart/form-data"');
    expect(form).toContain('<label>Attach a file (optional)<input type="file" name="file" multiple');
    expect(form).not.toContain("\u2014");
    expect(form).not.toContain("\u2013");
  });

  it("shows the sender and the board a download link, and hides it from another owner", () => {
    const note: MessageRow = {
      id: "msg_casey_1",
      thread_id: "msg_casey_1",
      parent_id: null,
      from_user_id: "user_casey",
      from_name: "Casey Nguyen",
      property_id: "prop_27",
      lot_number: "27",
      subject: "Gate note",
      body: "See the file.",
      created_at: "2026-10-02T18:30:00.000Z",
      reviewed_at: null,
      attachments: [
        { id: "file_note", message_id: "msg_casey_1", filename: "note.pdf", content_type: "application/pdf" },
        { id: "file_photo", message_id: "msg_casey_1", filename: "photo.jpg", content_type: "image/jpeg" },
      ],
    };
    const href = "/a/tango-mar/messages/msg_casey_1/messages/msg_casey_1/files/file_note";
    const own = threadPage(association, note.subject, [note], { viewerUserId: "user_casey", showAttachments: "own" });
    expect(own).toContain("note.pdf");
    expect(own).toContain(`${href}?download=1`);
    expect(own).not.toContain(`${href}" target="_blank"`);
    expect(own).toContain('href="/a/tango-mar/messages/msg_casey_1/messages/msg_casey_1/files/file_photo" target="_blank"');
    expect(own).not.toContain("assoc_tango_mar/messages");

    const neighbor = threadPage(association, note.subject, [note], { viewerUserId: "user_sam", showAttachments: "own" });
    expect(neighbor).not.toContain("/files/file_note");

    const admin = adminThreadPage(association, note.subject, [note], ["user_jordan"]);
    expect(admin).toContain(`${href}?download=1`);
    expect(admin).toContain("photo.jpg");
  });

  it("serves only allowlisted content types", () => {
    expect(safeStoredContentType("application/pdf")).toBe("application/pdf");
    expect(safeStoredContentType("text/plain")).toBe("text/plain; charset=utf-8");
    expect(safeStoredContentType("text/html")).toBe("application/octet-stream");
  });
});

describe("message file upload", () => {
  it("stores up to 3 files and lets the sender, an editor, and a board reader download them", async () => {
    const { sqlite, bucket, env } = openPortal(MIGRATIONS);
    const app = createApp();
    addNeighborAndBoard(sqlite);
    const casey = await signIn(sqlite, "user_casey");
    const sam = await signIn(sqlite, "user_sam");
    const riley = await signIn(sqlite, "user_riley");
    const jordan = await signIn(sqlite, "user_jordan");
    const pat = await signIn(sqlite, "user_pat");
    try {
      const created = await app.request(
        "http://localhost/a/tango-mar/messages",
        sendMessage(
          casey,
          { subject: "Gate note", body: "The sheet is attached." },
          [
            new File(["secret-pdf-bytes"], "note.pdf", { type: "application/pdf" }),
            new File(["secret-jpeg-bytes"], "photo.jpg", { type: "image/jpeg" }),
            new File(["plain notes"], "notes.txt", { type: "text/plain" }),
          ],
        ),
        env,
      );
      expect(created.status).toBe(303);
      const message = sqlite.prepare("SELECT id, thread_id, from_user_id FROM messages WHERE subject = 'Gate note'").get() as {
        id: string;
        thread_id: string;
        from_user_id: string;
      };
      expect(created.headers.get("Location")).toBe(`/a/tango-mar/messages/${message.id}`);
      expect(message.from_user_id).toBe("user_casey");
      const files = storedFiles(sqlite, message.id);
      expect(files.map((file) => file.filename)).toEqual(["note.pdf", "photo.jpg", "notes.txt"]);
      expect(files.map((file) => file.position)).toEqual([0, 1, 2]);
      expect(files[0]?.content_type).toBe("application/pdf");
      expect(files[1]?.content_type).toBe("image/jpeg");
      expect(files[2]?.content_type).toBe("text/plain; charset=utf-8");
      for (const file of files) {
        expect(file.r2_key.startsWith(`${ASSOCIATION}/messages/${message.id}/${file.id}/`)).toBe(true);
        expect(bucket.objects.has(file.r2_key)).toBe(true);
      }

      const ownPage = await app.request(
        `http://localhost/a/tango-mar/messages/${message.id}`,
        { headers: { Cookie: `tango_session=${casey}` } },
        env,
      );
      expect(ownPage.status).toBe(200);
      const ownHtml = await ownPage.text();
      const pdfHref = `/a/tango-mar/messages/${message.id}/messages/${message.id}/files/${files[0]?.id}`;
      const photoHref = `/a/tango-mar/messages/${message.id}/messages/${message.id}/files/${files[1]?.id}`;
      expect(ownHtml).toContain("note.pdf");
      expect(ownHtml).toContain(`${pdfHref}?download=1`);
      expect(ownHtml).toContain(`${photoHref}" target="_blank"`);
      expect(ownHtml).not.toContain(files[0]?.r2_key ?? "missing-key");
      expect(ownHtml).not.toContain("r2.dev");

      const adminPage = await app.request(
        `http://localhost/a/tango-mar/admin/messages/${message.id}`,
        { headers: { Cookie: `tango_session=${jordan}` } },
        env,
      );
      expect(adminPage.status).toBe(200);
      expect(await adminPage.text()).toContain(`${pdfHref}?download=1`);

      const pdf = await app.request(`http://localhost${pdfHref}`, { headers: { Cookie: `tango_session=${casey}` } }, env);
      expect(pdf.status).toBe(200);
      expect(pdf.headers.get("Content-Type")).toBe("application/pdf");
      expect(pdf.headers.get("Content-Disposition")).toBe('attachment; filename="note.pdf"');
      expect(pdf.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(pdf.headers.get("Cache-Control")).toContain("private");
      expect(await pdf.text()).toBe("secret-pdf-bytes");

      const photo = await app.request(`http://localhost${photoHref}`, { headers: { Cookie: `tango_session=${casey}` } }, env);
      expect(photo.status).toBe(200);
      expect(photo.headers.get("Content-Type")).toBe("image/jpeg");
      expect(photo.headers.get("Content-Disposition")).toBe('inline; filename="photo.jpg"');
      expect(await photo.text()).toBe("secret-jpeg-bytes");

      const savedPhoto = await app.request(
        `http://localhost${photoHref}?download=1`,
        { headers: { Cookie: `tango_session=${casey}` } },
        env,
      );
      expect(savedPhoto.headers.get("Content-Disposition")).toBe('attachment; filename="photo.jpg"');

      const neighbor = await app.request(`http://localhost${pdfHref}`, { headers: { Cookie: `tango_session=${sam}` } }, env);
      expect(neighbor.status).toBe(403);
      expect(await neighbor.text()).not.toContain("secret-pdf-bytes");

      const coOwner = await app.request(`http://localhost${pdfHref}`, { headers: { Cookie: `tango_session=${riley}` } }, env);
      expect(coOwner.status).toBe(403);
      expect(await coOwner.text()).not.toContain("secret-pdf-bytes");

      const editor = await app.request(`http://localhost${pdfHref}`, { headers: { Cookie: `tango_session=${jordan}` } }, env);
      expect(editor.status).toBe(200);
      expect(await editor.text()).toBe("secret-pdf-bytes");

      const reader = await app.request(`http://localhost${pdfHref}`, { headers: { Cookie: `tango_session=${pat}` } }, env);
      expect(reader.status).toBe(200);
      expect(await reader.text()).toBe("secret-pdf-bytes");

      const missing = await app.request(
        `http://localhost${pdfHref}missing`,
        { headers: { Cookie: `tango_session=${casey}` } },
        env,
      );
      expect(missing.status).toBe(404);

      const removed = await app.request(
        `http://localhost/a/tango-mar/messages/${message.id}/delete`,
        post(casey, { confirm: "yes" }),
        env,
      );
      expect(removed.status).toBe(303);
      expect(storedFiles(sqlite, message.id)).toEqual([]);
      expect(bucket.objects.size).toBe(0);
      const gone = await app.request(`http://localhost${pdfHref}`, { headers: { Cookie: `tango_session=${jordan}` } }, env);
      expect(gone.status).toBe(404);
    } finally {
      sqlite.close();
    }
  });

  it("rejects a disallowed type, a file over 8 MB, and a fourth file", async () => {
    const { sqlite, bucket, env } = openPortal(MIGRATIONS);
    const app = createApp();
    const casey = await signIn(sqlite, "user_casey");
    const before = messageCount(sqlite);
    try {
      const exe = await app.request(
        "http://localhost/a/tango-mar/messages",
        sendMessage(casey, { subject: "Bad type", body: "Nope." }, [new File(["MZ"], "virus.exe", { type: "application/octet-stream" })]),
        env,
      );
      expect(exe.status).toBe(303);
      expect(exe.headers.get("Location")).toBe("/a/tango-mar/messages");
      expect(flash(exe)).toContain("Upload a PDF, text file, image, or Word document.");
      expect(messageCount(sqlite)).toBe(before);
      expect(bucket.objects.size).toBe(0);

      const huge = await app.request(
        "http://localhost/a/tango-mar/messages",
        sendMessage(
          casey,
          { subject: "Too big", body: "Nope." },
          [new File([new Uint8Array(MAX_DOCUMENT_BYTES + 1)], "big.pdf", { type: "application/pdf" })],
        ),
        env,
      );
      expect(huge.status).toBe(303);
      expect(flash(huge)).toContain("Files must be 8 MB or smaller.");
      expect(messageCount(sqlite)).toBe(before);
      expect(bucket.objects.size).toBe(0);

      const extra = await app.request(
        "http://localhost/a/tango-mar/messages",
        sendMessage(
          casey,
          { subject: "Too many", body: "Nope." },
          [
            new File(["a"], "a.txt", { type: "text/plain" }),
            new File(["b"], "b.txt", { type: "text/plain" }),
            new File(["c"], "c.txt", { type: "text/plain" }),
            new File(["d"], "d.txt", { type: "text/plain" }),
          ],
        ),
        env,
      );
      expect(extra.status).toBe(303);
      expect(flash(extra)).toContain("Attach up to 3 files.");
      expect(messageCount(sqlite)).toBe(before);
      expect(bucket.objects.size).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it("still opens Messages when the attachment table is missing, and refuses a file until the migration exists", async () => {
    const { sqlite, bucket, env } = openPortal(MIGRATIONS.slice(0, -1));
    const app = createApp();
    const casey = await signIn(sqlite, "user_casey");
    try {
      const list = await app.request("http://localhost/a/tango-mar/messages", { headers: { Cookie: `tango_session=${casey}` } }, env);
      expect(list.status).toBe(200);
      expect(await list.text()).toContain("Attach a file (optional)");

      const thread = await app.request(
        "http://localhost/a/tango-mar/messages/msg_casey_1",
        { headers: { Cookie: `tango_session=${casey}` } },
        env,
      );
      expect(thread.status).toBe(200);
      expect(await thread.text()).toContain("Walkway assessment");

      const before = messageCount(sqlite);
      const blocked = await app.request(
        "http://localhost/a/tango-mar/messages",
        sendMessage(casey, { subject: "With file", body: "Needs the table." }, [new File(["hi"], "note.pdf", { type: "application/pdf" })]),
        env,
      );
      expect(blocked.status).toBe(303);
      expect(flash(blocked)).toContain("Apply the message file migration in D1");
      expect(messageCount(sqlite)).toBe(before);
      expect(bucket.objects.size).toBe(0);

      const plain = await app.request(
        "http://localhost/a/tango-mar/messages",
        sendMessage(casey, { subject: "No file", body: "Just a note." }, []),
        env,
      );
      expect(plain.status).toBe(303);
      expect(messageCount(sqlite)).toBe(before + 1);
    } finally {
      sqlite.close();
    }
  });
});
