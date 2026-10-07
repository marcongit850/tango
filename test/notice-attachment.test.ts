import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { noticeFileForUser, notificationsForUser, notify } from "../src/db";
import type { OwnerListRow } from "../src/db";
import { ownerNoticeEmail } from "../src/lib/email";
import { isMissingColumn } from "../src/lib/errors";
import { MAX_DOCUMENT_BYTES, noticeFileProblem } from "../src/lib/files";
import type { Association } from "../src/types";
import { ownerDetailPage } from "../src/views/admin";
import { dashboardPage, noticesPage } from "../src/views/resident";

const association: Association = {
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

  async run(): Promise<{ meta: { changes: number } }> {
    const info = this.sqlite.prepare(this.sql).run(...(this.params as (string | number | null | bigint)[]));
    return { meta: { changes: Number(info.changes) } };
  }
}

class SqliteD1 {
  constructor(private readonly sqlite: DatabaseSync) {}

  prepare(query: string): SqliteStatement {
    return new SqliteStatement(this.sqlite, query);
  }
}

function openDb(files: string[]): SqliteD1 {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of files) sqlite.exec(readFileSync(file, "utf8"));
  return new SqliteD1(sqlite) as unknown as SqliteD1;
}

describe("portal notice files", () => {
  it("offers an optional file and an unchecked Email owner box", () => {
    const owner: OwnerListRow = {
      user_id: "user_sam",
      email: "sam.rivera@example.com",
      name: "Sam Rivera",
      phone: "",
      role_id: "homeowner",
      is_admin: 0,
      status: "active",
      property_id: "prop_14",
      lot_number: "14",
      street_address: "Lot 14",
    };
    const html = ownerDetailPage({ association, owner, balance: 0, lots: [], properties: [] });
    const form = html.slice(html.indexOf('action="/a/tango-mar/admin/owners/user_sam/notice"') - 80);
    expect(form.startsWith("<form") || html.includes('action="/a/tango-mar/admin/owners/user_sam/notice"')).toBe(true);
    expect(html).toContain('action="/a/tango-mar/admin/owners/user_sam/notice"');
    expect(html).toContain('enctype="multipart/form-data"');
    expect(html).toContain('name="file"');
    expect(html).toContain("File (optional)");
    expect(html).toContain('<input type="checkbox" name="email_owner" value="1"> Email owner');
    expect(html).not.toMatch(/name="email_owner"[^>]*checked/);
    expect(html).not.toContain("\u2014");
  });

  it("rejects the same kinds of files documents reject", () => {
    expect(noticeFileProblem(new File(["hi"], "notes.exe", { type: "application/octet-stream" }))).toMatch(/PDF, text file, image, or Word/);
    expect(noticeFileProblem(new File(["hello"], "notes.txt", { type: "text/plain" }))).toBeNull();
    const tooBig = new File([new Uint8Array(MAX_DOCUMENT_BYTES + 1)], "big.pdf", { type: "application/pdf" });
    expect(noticeFileProblem(tooBig)).toMatch(/8 MB/);
  });

  it("shows view and download on notices and the dashboard", () => {
    const withFile = {
      id: "note_gate",
      kind: "account",
      title: "Gate code",
      body: "See the attached sheet.",
      href: "/a/tango-mar/notices",
      read_at: null,
      created_at: "2026-10-06T15:00:00.000Z",
      attachment_filename: "gate.pdf",
      attachment_content_type: "application/pdf",
      attachment_r2_key: "assoc/notices/note_gate/gate.pdf",
      attachment_byte_size: 12,
    };
    const word = {
      ...withFile,
      id: "note_word",
      attachment_filename: "minutes.docx",
      attachment_content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
    const plain = { ...withFile, id: "note_plain", attachment_filename: "", attachment_r2_key: "" };
    const notices = noticesPage(association, [withFile, word, plain]);
    expect(notices).toContain('href="/a/tango-mar/notices/note_gate/file"');
    expect(notices).toContain('href="/a/tango-mar/notices/note_gate/file?download=1"');
    expect(notices).toContain(">View<");
    expect(notices).toContain('href="/a/tango-mar/notices/note_word/file?download=1"');
    expect(notices).not.toContain('href="/a/tango-mar/notices/note_word/file" target="_blank"');
    expect(notices).not.toContain("/note_plain/file");

    const dashboard = dashboardPage({
      association,
      name: "Sam Rivera",
      ledger: [],
      upcoming: [],
      invoices: [],
      payments: [],
      notices: [withFile],
      emergencies: [],
    });
    expect(dashboard).toContain('href="/a/tango-mar/notices/note_gate/file?download=1"');
    expect(dashboard).toContain(">View<");
    expect(dashboard).not.toContain("\u2014");
  });

  it("links the portal and says the file is attached to the email", () => {
    const letter = ownerNoticeEmail({
      associationName: "Tango Mar",
      slug: "tango-mar",
      kind: "account",
      title: "Gate\ncode",
      summary: "The new code is inside.",
      attachmentName: "gate.pdf",
    });
    expect(letter.subject).toBe("Tango Mar: Gate code");
    expect(letter.href).toBe("https://mytangomar.com/a/tango-mar/notices");
    expect(letter.text).toContain(letter.href);
    expect(letter.text).toContain("Attached file: gate.pdf");
    expect(letter.text).toContain("open it from the notice in the portal");
    expect(letter.text).not.toContain("\u2014");

    const bare = ownerNoticeEmail({
      associationName: "Tango Mar",
      slug: "tango-mar",
      kind: "account",
      title: "Hello",
      summary: "Hello",
    });
    expect(bare.text).toContain(bare.href);
    expect(bare.text).not.toMatch(/attached/i);
  });

  it("stores the file on the notice and still lists notices before the migration", async () => {
    const ready = openDb([
      "migrations/0001_schema.sql",
      "migrations/0002_seed_tango_mar.sql",
      "migrations/0006_notice_attachments.sql",
    ]);
    const id = await notify(ready as unknown as D1Database, {
      associationId: "assoc_tango_mar",
      userId: "user_sam",
      kind: "account",
      title: "Gate code",
      body: "See the file.",
      href: "/a/tango-mar/notices",
      attachment: {
        filename: "gate.pdf",
        contentType: "application/pdf",
        r2Key: "assoc_tango_mar/notices/note/gate.pdf",
        byteSize: 5,
      },
    });
    const rows = await notificationsForUser(ready as unknown as D1Database, "assoc_tango_mar", "user_sam");
    expect(rows[0]).toMatchObject({
      id,
      title: "Gate code",
      attachment_filename: "gate.pdf",
      attachment_content_type: "application/pdf",
      attachment_r2_key: "assoc_tango_mar/notices/note/gate.pdf",
      attachment_byte_size: 5,
    });
    const file = await noticeFileForUser(ready as unknown as D1Database, "assoc_tango_mar", "user_sam", id);
    expect(file).toEqual({
      filename: "gate.pdf",
      content_type: "application/pdf",
      r2_key: "assoc_tango_mar/notices/note/gate.pdf",
    });
    expect(await noticeFileForUser(ready as unknown as D1Database, "assoc_tango_mar", "user_casey", id)).toBeNull();

    const early = openDb(["migrations/0001_schema.sql", "migrations/0002_seed_tango_mar.sql"]);
    const listed = await notificationsForUser(early as unknown as D1Database, "assoc_tango_mar", "user_casey");
    expect(listed.map((row) => row.title)).toContain("Past-due balance");
    expect(listed[0]?.attachment_filename).toBe("");
    let missing = false;
    try {
      await notify(early as unknown as D1Database, {
        associationId: "assoc_tango_mar",
        userId: "user_sam",
        kind: "account",
        title: "With file",
        body: "Needs the migration.",
        attachment: { filename: "a.pdf", contentType: "application/pdf", r2Key: "k", byteSize: 1 },
      });
    } catch (error) {
      missing = isMissingColumn(error);
    }
    expect(missing).toBe(true);
  });
});
