import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { deleteMessage, deleteMessageThread, notificationsForUser, threadMessages, threadsForViewer } from "../src/db";
import { sha256Hex } from "../src/lib/tokens";
import type { Association } from "../src/types";
import type { MessageRow } from "../src/db";
import { adminMessagesPage, adminThreadPage } from "../src/views/admin";
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

function message(row: Partial<MessageRow> & Pick<MessageRow, "id" | "from_user_id" | "body">): MessageRow {
  return {
    thread_id: row.id,
    parent_id: null,
    from_name: "Casey Nguyen",
    property_id: "prop_27",
    lot_number: "27",
    subject: "Walkway assessment",
    created_at: "2026-10-02T18:30:00.000Z",
    reviewed_at: null,
    ...row,
  };
}

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

function post(app: ReturnType<typeof createApp>, env: Env, path: string, token: string, fields: Record<string, string>) {
  return app.request(
    `http://localhost${path}`,
    {
      method: "POST",
      headers: {
        Cookie: `tango_session=${token}`,
        Origin: "http://localhost",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields),
    },
    env,
  );
}

function ids(sqlite: DatabaseSync, table: "messages" | "notifications", where = ""): string[] {
  const rows = sqlite.prepare(`SELECT id FROM ${table} ${where} ORDER BY id`).all() as { id: string }[];
  return rows.map((row) => row.id);
}

describe("message delete controls", () => {
  const root = message({ id: "msg_casey_1", from_user_id: "user_casey", body: "Is the charge included?" });
  const followUp = message({
    id: "msg_casey_2",
    thread_id: "msg_casey_1",
    parent_id: "msg_casey_1",
    from_user_id: "user_casey",
    body: "Following up.",
    created_at: "2026-10-03T18:30:00.000Z",
  });
  const reply = message({
    id: "msg_jordan_1",
    thread_id: "msg_casey_1",
    parent_id: "msg_casey_1",
    from_user_id: "user_jordan",
    from_name: "Jordan Lee",
    body: "It is included.",
    created_at: "2026-10-04T18:30:00.000Z",
  });

  it("confirms an admin thread delete from the inbox and the thread", () => {
    const list = adminMessagesPage(association, [root], ["user_jordan"]);
    expect(list).toContain('action="/a/tango-mar/admin/messages/msg_casey_1/delete"');
    expect(list).toContain('type="checkbox" name="confirm" value="yes" required');
    expect(list).toContain(">Delete</button>");
    expect(list).not.toContain("onsubmit=");

    const single = adminThreadPage(association, root.subject, [root], ["user_jordan"]);
    expect(single).toContain('action="/a/tango-mar/admin/messages/msg_casey_1/delete"');
    expect(single).toContain("Delete this message thread");
    expect(single).toContain(">Delete thread</button>");
    expect(single).not.toContain("Delete reply");

    const html = adminThreadPage(association, root.subject, [root, reply], ["user_jordan"]);
    expect(html).toContain('action="/a/tango-mar/admin/messages/msg_casey_1/messages/msg_casey_1/delete"');
    expect(html).toContain('action="/a/tango-mar/admin/messages/msg_casey_1/messages/msg_jordan_1/delete"');
    expect(html).toContain("Delete this reply");
    expect(html).toContain('type="checkbox" name="confirm" value="yes" required');
    expect(html).not.toContain("onsubmit=");
  });

  it("uses the resident messages intro", () => {
    const resident = messagesPage(association, [], [{ id: "prop_27", lot_number: "27" }]);
    expect(resident).toContain("<h1>Messages</h1>");
    expect(resident).toContain("Send a private message to the Board. Messages are not visible to other residents.");
    expect(resident).not.toContain("Admin → Messages");
    expect(resident).not.toContain("authorized administrators");
    expect(resident).toContain("No messages yet.");
    expect(resident).not.toContain("Private notes to the board");
    expect(resident).not.toContain("\u2014");
  });

  it("lets the resident who started a thread delete it, and only their extra replies", () => {
    const list = messagesPage(association, [root], [{ id: "prop_27", lot_number: "27" }]);
    expect(list).toContain('action="/a/tango-mar/messages/msg_casey_1/delete"');
    expect(list).toContain('type="checkbox" name="confirm" value="yes" required');
    expect(list).toContain(">Delete</button>");
    expect(list).not.toContain("onsubmit=");

    const own = threadPage(association, root.subject, [root, followUp, reply], {
      allowThreadDelete: true,
      replyDelete: "own",
      viewerUserId: "user_casey",
    });
    expect(own).toContain('action="/a/tango-mar/messages/msg_casey_1/delete"');
    expect(own).toContain('action="/a/tango-mar/messages/msg_casey_1/messages/msg_casey_1/delete"');
    expect(own).toContain('action="/a/tango-mar/messages/msg_casey_1/messages/msg_casey_2/delete"');
    expect(own).not.toContain("/messages/msg_jordan_1/delete");

    const single = threadPage(association, root.subject, [root, reply], {
      allowThreadDelete: true,
      replyDelete: "own",
      viewerUserId: "user_casey",
    });
    expect(single).toContain(">Delete thread</button>");
    expect(single).not.toContain("Delete reply");

    const hidden = threadPage(association, root.subject, [root, reply], { viewerUserId: "user_sam" });
    expect(hidden).not.toContain("/delete");
  });
});

describe("message deletion", () => {
  function seedExtra(sqlite: DatabaseSync): void {
    sqlite
      .prepare(
        `INSERT INTO associations (id, slug, name, legal_name) VALUES ('assoc_other', 'other', 'Other', 'Other POA')`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO messages (id, association_id, thread_id, parent_id, from_user_id, property_id, subject, body, created_at)
         VALUES ('msg_jordan_1', ?, 'msg_casey_1', 'msg_casey_1', 'user_jordan', 'prop_27', 'Walkway assessment', 'It is included.', '2026-10-03T18:30:00Z')`,
      )
      .run(ASSOCIATION);
    sqlite
      .prepare(
        `INSERT INTO messages (id, association_id, thread_id, parent_id, from_user_id, property_id, subject, body, created_at)
         VALUES ('msg_other', 'assoc_other', 'msg_other', NULL, 'user_sam', NULL, 'Other gate', 'Hello', '2026-10-04T18:30:00Z')`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO notifications (id, association_id, user_id, kind, title, body, href, created_at)
         VALUES ('note_admin_message', ?, 'user_jordan', 'message', 'New message from Casey Nguyen', 'Walkway assessment', '/a/tango-mar/admin/messages/msg_casey_1', '2026-10-02T18:31:00Z')`,
      )
      .run(ASSOCIATION);
    sqlite
      .prepare(
        `INSERT INTO notifications (id, association_id, user_id, kind, title, body, href, created_at)
         VALUES ('note_other', 'assoc_other', 'user_sam', 'message', 'Other message', 'Other gate', '/a/other/messages/msg_other', '2026-10-04T18:30:00Z')`,
      )
      .run();
  }

  it("removes one reply and leaves the thread and its notices", async () => {
    const { sqlite, db } = openPortal();
    seedExtra(sqlite);
    expect(await deleteMessage(db, ASSOCIATION, "tango-mar", "msg_casey_1", "msg_other")).toBe(false);
    expect(await deleteMessage(db, ASSOCIATION, "tango-mar", "msg_casey_1", "msg_jordan_1")).toBe(true);
    expect(ids(sqlite, "messages", "WHERE thread_id = 'msg_casey_1'")).toEqual(["msg_casey_1"]);
    expect(ids(sqlite, "notifications")).toEqual([
      "note_admin_message",
      "note_casey_past_due",
      "note_jordan_message",
      "note_other",
    ]);
    expect(await deleteMessageThread(db, ASSOCIATION, "tango-mar", "missing")).toBe(false);
    sqlite.close();
  });

  it("removes a thread, both notice links, and nothing from another association", async () => {
    const { sqlite, db } = openPortal();
    seedExtra(sqlite);
    expect(await deleteMessageThread(db, ASSOCIATION, "tango-mar", "msg_casey_1")).toBe(true);
    expect(await deleteMessageThread(db, ASSOCIATION, "tango-mar", "msg_casey_1")).toBe(false);
    expect(ids(sqlite, "messages")).toEqual(["msg_other"]);
    expect(ids(sqlite, "notifications")).toEqual(["note_casey_past_due", "note_other"]);
    const titles = (await notificationsForUser(db, ASSOCIATION, "user_jordan")).map((row) => row.title);
    expect(titles).not.toContain("New message from Casey Nguyen");
    expect(await threadsForViewer(db, ASSOCIATION, "", true)).toEqual([]);
    expect(await threadMessages(db, "assoc_other", "msg_other")).toHaveLength(1);
    sqlite.close();
  });
});

describe("message delete routes", () => {
  it("lets an admin delete a thread after confirm, and blocks a resident from the admin route", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const admin = await signIn(sqlite, "user_jordan");
    const resident = await signIn(sqlite, "user_casey");

    const page = await app.request("http://localhost/a/tango-mar/admin/messages", { headers: { Cookie: `tango_session=${admin}` } }, env);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('action="/a/tango-mar/admin/messages/msg_casey_1/delete"');
    expect(html).toContain('type="checkbox" name="confirm" value="yes" required');
    expect(html).not.toContain("onsubmit=");

    const residentAdmin = await post(app, env, "/a/tango-mar/admin/messages/msg_casey_1/delete", resident, { confirm: "yes" });
    expect(residentAdmin.status).toBe(403);
    expect(ids(sqlite, "messages")).toContain("msg_casey_1");

    const unconfirmed = await post(app, env, "/a/tango-mar/admin/messages/msg_casey_1/delete", admin, {});
    expect(unconfirmed.status).toBe(303);
    expect(unconfirmed.headers.get("Location")).toBe("/a/tango-mar/admin/messages/msg_casey_1");
    expect(ids(sqlite, "messages")).toContain("msg_casey_1");

    const removed = await post(app, env, "/a/tango-mar/admin/messages/msg_casey_1/delete", admin, { confirm: "yes" });
    expect(removed.status).toBe(303);
    expect(removed.headers.get("Location")).toBe("/a/tango-mar/admin/messages");
    expect(ids(sqlite, "messages")).not.toContain("msg_casey_1");
    expect(sqlite.prepare("SELECT id FROM notifications WHERE id = 'note_jordan_message'").get()).toBeUndefined();
    expect(sqlite.prepare("SELECT id FROM notifications WHERE id = 'note_casey_past_due'").get()).toBeTruthy();
    const audit = sqlite.prepare("SELECT action, detail FROM audit_log WHERE action = 'message_thread_delete'").get() as {
      action: string;
      detail: string;
    };
    expect(audit.detail).toBe("Walkway assessment");

    const again = await post(app, env, "/a/tango-mar/admin/messages/msg_casey_1/delete", admin, { confirm: "yes" });
    expect(again.status).toBe(303);
    expect(again.headers.get("Location")).toBe("/a/tango-mar/admin/messages");
    sqlite.close();
  });

  it("lets the author delete their thread and refuses someone else", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const author = await signIn(sqlite, "user_casey");
    const neighbor = await signIn(sqlite, "user_sam");

    const before = await app.request("http://localhost/a/tango-mar/messages/msg_casey_1", { headers: { Cookie: `tango_session=${neighbor}` } }, env);
    expect(before.status).toBe(403);
    const denied = await post(app, env, "/a/tango-mar/messages/msg_casey_1/delete", neighbor, { confirm: "yes" });
    expect(denied.status).toBe(403);

    sqlite
      .prepare(
        `INSERT INTO messages (id, association_id, thread_id, parent_id, from_user_id, property_id, subject, body, created_at)
         VALUES ('msg_sam_1', ?, 'msg_casey_1', 'msg_casey_1', 'user_sam', 'prop_14', 'Walkway assessment', 'I can see this.', '2026-10-03T18:30:00Z')`,
      )
      .run(ASSOCIATION);

    const ownPage = await app.request("http://localhost/a/tango-mar/messages/msg_casey_1", { headers: { Cookie: `tango_session=${author}` } }, env);
    expect(ownPage.status).toBe(200);
    expect(await ownPage.text()).toContain('action="/a/tango-mar/messages/msg_casey_1/delete"');

    const participant = await app.request("http://localhost/a/tango-mar/messages/msg_casey_1", { headers: { Cookie: `tango_session=${neighbor}` } }, env);
    expect(participant.status).toBe(200);
    expect(await participant.text()).not.toContain("/delete");

    const blocked = await post(app, env, "/a/tango-mar/messages/msg_casey_1/delete", neighbor, { confirm: "yes" });
    expect(blocked.status).toBe(303);
    expect(blocked.headers.get("Location")).toBe("/a/tango-mar/messages/msg_casey_1");
    expect(ids(sqlite, "messages")).toEqual(["msg_casey_1", "msg_sam_1"]);

    const removed = await post(app, env, "/a/tango-mar/messages/msg_casey_1/delete", author, { confirm: "yes" });
    expect(removed.status).toBe(303);
    expect(removed.headers.get("Location")).toBe("/a/tango-mar/messages");
    expect(ids(sqlite, "messages")).toEqual([]);
    expect(sqlite.prepare("SELECT id FROM notifications WHERE id = 'note_jordan_message'").get()).toBeUndefined();
    const inbox = await app.request("http://localhost/a/tango-mar/messages", { headers: { Cookie: `tango_session=${author}` } }, env);
    expect(await inbox.text()).toContain("No messages yet.");
    sqlite.close();
  });

  it("lets an admin delete one reply and lets the author delete an extra reply of their own", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const admin = await signIn(sqlite, "user_jordan");
    const author = await signIn(sqlite, "user_casey");
    sqlite
      .prepare(
        `INSERT INTO messages (id, association_id, thread_id, parent_id, from_user_id, property_id, subject, body, created_at)
         VALUES
           ('msg_casey_2', ?, 'msg_casey_1', 'msg_casey_1', 'user_casey', 'prop_27', 'Walkway assessment', 'Following up.', '2026-10-03T18:30:00Z'),
           ('msg_jordan_1', ?, 'msg_casey_1', 'msg_casey_2', 'user_jordan', 'prop_27', 'Walkway assessment', 'It is included.', '2026-10-04T18:30:00Z')`,
      )
      .run(ASSOCIATION, ASSOCIATION);

    const boardReply = await post(app, env, "/a/tango-mar/messages/msg_casey_1/messages/msg_jordan_1/delete", author, { confirm: "yes" });
    expect(boardReply.status).toBe(303);
    expect(boardReply.headers.get("Location")).toBe("/a/tango-mar/messages/msg_casey_1");
    expect(ids(sqlite, "messages")).toContain("msg_jordan_1");

    const ownFollowUp = await post(app, env, "/a/tango-mar/messages/msg_casey_1/messages/msg_casey_2/delete", author, { confirm: "yes" });
    expect(ownFollowUp.status).toBe(303);
    expect(ownFollowUp.headers.get("Location")).toBe("/a/tango-mar/messages/msg_casey_1");
    expect(ids(sqlite, "messages")).toEqual(["msg_casey_1", "msg_jordan_1"]);
    expect(sqlite.prepare("SELECT id FROM notifications WHERE id = 'note_jordan_message'").get()).toBeTruthy();

    const ownQuestion = await post(app, env, "/a/tango-mar/messages/msg_casey_1/messages/msg_casey_1/delete", author, { confirm: "yes" });
    expect(ownQuestion.status).toBe(303);
    expect(ownQuestion.headers.get("Location")).toBe("/a/tango-mar/messages/msg_casey_1");
    expect(ids(sqlite, "messages")).toEqual(["msg_casey_1", "msg_jordan_1"]);

    const adminReply = await post(app, env, "/a/tango-mar/admin/messages/msg_casey_1/messages/msg_jordan_1/delete", admin, {
      confirm: "yes",
    });
    expect(adminReply.status).toBe(303);
    expect(adminReply.headers.get("Location")).toBe("/a/tango-mar/admin/messages/msg_casey_1");
    expect(ids(sqlite, "messages")).toEqual(["msg_casey_1"]);
    expect(sqlite.prepare("SELECT action FROM audit_log WHERE entity_id = 'msg_jordan_1'").get()).toEqual({ action: "message_delete" });

    const last = await post(app, env, "/a/tango-mar/admin/messages/msg_casey_1/messages/msg_casey_1/delete", admin, { confirm: "yes" });
    expect(last.status).toBe(303);
    expect(last.headers.get("Location")).toBe("/a/tango-mar/admin/messages");
    expect(ids(sqlite, "messages")).toEqual([]);
    expect(sqlite.prepare("SELECT id FROM notifications WHERE id = 'note_jordan_message'").get()).toBeUndefined();
    sqlite.close();
  });
});
