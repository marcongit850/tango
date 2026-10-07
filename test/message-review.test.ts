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
}

const schema = [
  "migrations/0001_schema.sql",
  "migrations/0002_seed_tango_mar.sql",
  "migrations/0003_join_requests.sql",
  "migrations/0004_join_request_approved.sql",
  "migrations/0005_admin_improvements.sql",
  "migrations/0006_notice_attachments.sql",
];

function openPortal(files = [...schema, "migrations/0007_message_reviewed.sql"]): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of files) sqlite.exec(readFileSync(file, "utf8"));
  return { sqlite, db: new SqliteD1(sqlite) as unknown as D1Database };
}

function portalEnv(db: D1Database): Env {
  return {
    DB: db,
    APP_ENV: "production",
    EMAIL_FROM: "Tango Mar <donotreply@mytangomar.com>",
    DOCUMENTS: {} as R2Bucket,
    RESEND_API_KEY: "",
  } as Env;
}

async function signIn(sqlite: DatabaseSync, userId: string): Promise<string> {
  const token = `session-${userId}`;
  sqlite
    .prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(`sess_${userId}`, userId, await sha256Hex(token), "2099-01-01T00:00:00.000Z", "2026-10-06T00:00:00.000Z");
  return token;
}

function waitingCount(html: string): number {
  const match = html.match(/<a class="card" href="\/a\/tango-mar\/admin\/messages"><h2>(\d+)<\/h2><p>Messages waiting on the board<\/p><\/a>/);
  if (!match) throw new Error("waiting card missing");
  return Number(match[1]);
}

function cookieHeader(token: string): string {
  return `tango_session=${token}`;
}

describe("message review", () => {
  it("clears a thread from the waiting count until the owner writes again", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const jordan = cookieHeader(await signIn(sqlite, "user_jordan"));
    const casey = cookieHeader(await signIn(sqlite, "user_casey"));
    const sam = cookieHeader(await signIn(sqlite, "user_sam"));
    const thread = "/a/tango-mar/admin/messages/msg_casey_1";

    const post = (path: string, cookie: string, body: URLSearchParams) =>
      app.request(
        `http://localhost${path}`,
        {
          method: "POST",
          headers: { Cookie: cookie, Origin: "http://localhost", "Content-Type": "application/x-www-form-urlencoded" },
          body,
        },
        env,
      );

    try {
      const home = await app.request("http://localhost/a/tango-mar/admin", { headers: { Cookie: jordan } }, env);
      expect(home.status).toBe(200);
      expect(waitingCount(await home.text())).toBe(1);

      const blocked = await post(`${thread}/reviewed`, casey, new URLSearchParams());
      expect(blocked.status).toBe(403);
      expect(sqlite.prepare("SELECT reviewed_at FROM messages WHERE id = 'msg_casey_1'").get()).toEqual({ reviewed_at: null });

      const opened = await app.request(`http://localhost${thread}`, { headers: { Cookie: jordan } }, env);
      expect(opened.status).toBe(200);
      const openedHtml = await opened.text();
      expect(openedHtml).toContain(`${thread}/reviewed`);
      expect(openedHtml).toContain(">Mark reviewed<");
      expect(openedHtml).not.toContain("Reviewed. A new message from the owner");
      expect(waitingCount(await (await app.request("http://localhost/a/tango-mar/admin", { headers: { Cookie: jordan } }, env)).text())).toBe(1);
      expect(sqlite.prepare("SELECT reviewed_at FROM messages WHERE id = 'msg_casey_1'").get()).toEqual({ reviewed_at: null });

      const reviewed = await post(`${thread}/reviewed`, jordan, new URLSearchParams({ next: thread }));
      expect(reviewed.status).toBe(303);
      expect(reviewed.headers.get("Location")).toBe(thread);
      expect(decodeURIComponent(reviewed.headers.get("Set-Cookie") ?? "")).toContain("ok:Thread marked reviewed.");
      expect(waitingCount(await (await app.request("http://localhost/a/tango-mar/admin", { headers: { Cookie: jordan } }, env)).text())).toBe(0);

      const after = await (await app.request(`http://localhost${thread}`, { headers: { Cookie: jordan } }, env)).text();
      expect(after).toContain("Reviewed. A new message from the owner puts this thread back on the waiting list.");
      expect(after).not.toContain(">Mark reviewed<");
      const inbox = await (await app.request("http://localhost/a/tango-mar/admin/messages", { headers: { Cookie: jordan } }, env)).text();
      expect(inbox).toContain(">Reviewed<");
      expect(inbox).not.toContain(">Mark reviewed<");

      const again = await post(`${thread}/reviewed`, jordan, new URLSearchParams({ next: thread }));
      expect(again.status).toBe(303);
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'message_review'").get()).toEqual({ n: 1 });

      const missing = await post("/a/tango-mar/admin/messages/missing-thread/reviewed", jordan, new URLSearchParams());
      expect(missing.status).toBe(303);
      expect(missing.headers.get("Location")).toBe("/a/tango-mar/admin/messages");
      expect(decodeURIComponent(missing.headers.get("Set-Cookie") ?? "")).toContain("warn:That thread was not found.");

      const created = await post(
        "/a/tango-mar/messages",
        sam,
        new URLSearchParams({ subject: "Fence repair", body: "The side fence needs a look." }),
      );
      expect(created.status).toBe(303);
      const samThread = created.headers.get("Location") ?? "";
      expect(samThread).toMatch(/^\/a\/tango-mar\/messages\//);
      const samId = samThread.slice("/a/tango-mar/messages/".length);
      expect(waitingCount(await (await app.request("http://localhost/a/tango-mar/admin", { headers: { Cookie: jordan } }, env)).text())).toBe(1);

      const answered = await post(
        `/a/tango-mar/messages/${samId}/reply`,
        jordan,
        new URLSearchParams({ body: "We will look this week.", next: `/a/tango-mar/admin/messages/${samId}` }),
      );
      expect(answered.status).toBe(303);
      expect(waitingCount(await (await app.request("http://localhost/a/tango-mar/admin", { headers: { Cookie: jordan } }, env)).text())).toBe(0);

      const followUp = await post(`/a/tango-mar/messages/${samId}/reply`, sam, new URLSearchParams({ body: "Thank you, please check the gate too." }));
      expect(followUp.status).toBe(303);
      expect(waitingCount(await (await app.request("http://localhost/a/tango-mar/admin", { headers: { Cookie: jordan } }, env)).text())).toBe(1);

      const fromInbox = await post(
        `/a/tango-mar/admin/messages/${samId}/reviewed`,
        jordan,
        new URLSearchParams({ next: "/a/tango-mar/admin/messages" }),
      );
      expect(fromInbox.status).toBe(303);
      expect(fromInbox.headers.get("Location")).toBe("/a/tango-mar/admin/messages");
      expect(waitingCount(await (await app.request("http://localhost/a/tango-mar/admin", { headers: { Cookie: jordan } }, env)).text())).toBe(0);

      const ownerAgain = await post("/a/tango-mar/messages/msg_casey_1/reply", casey, new URLSearchParams({ body: "Checking again on the walkway charge." }));
      expect(ownerAgain.status).toBe(303);
      expect(waitingCount(await (await app.request("http://localhost/a/tango-mar/admin", { headers: { Cookie: jordan } }, env)).text())).toBe(1);
      const reopened = await (await app.request(`http://localhost${thread}`, { headers: { Cookie: jordan } }, env)).text();
      expect(reopened).toContain(">Mark reviewed<");
      expect(reopened).not.toContain("Reviewed. A new message from the owner puts this thread back on the waiting list.");

      const stamped = sqlite
        .prepare("SELECT from_user_id, reviewed_at IS NOT NULL AS reviewed FROM messages WHERE thread_id = 'msg_casey_1' ORDER BY created_at")
        .all() as { from_user_id: string; reviewed: number }[];
      expect(stamped).toEqual([
        { from_user_id: "user_casey", reviewed: 1 },
        { from_user_id: "user_casey", reviewed: 0 },
      ]);

      const cleared = await post(`${thread}/reviewed`, jordan, new URLSearchParams({ next: thread }));
      expect(cleared.status).toBe(303);
      expect(waitingCount(await (await app.request("http://localhost/a/tango-mar/admin", { headers: { Cookie: jordan } }, env)).text())).toBe(0);
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'message_review'").get()).toEqual({ n: 3 });
    } finally {
      sqlite.close();
    }
  });

  it("keeps the waiting count working before the review column exists", async () => {
    const { sqlite, db } = openPortal(schema);
    const app = createApp();
    const env = portalEnv(db);
    const jordan = cookieHeader(await signIn(sqlite, "user_jordan"));

    try {
      const home = await app.request("http://localhost/a/tango-mar/admin", { headers: { Cookie: jordan } }, env);
      expect(home.status).toBe(200);
      expect(waitingCount(await home.text())).toBe(1);

      const thread = await app.request("http://localhost/a/tango-mar/admin/messages/msg_casey_1", { headers: { Cookie: jordan } }, env);
      expect(thread.status).toBe(200);
      expect(await thread.text()).toContain(">Mark reviewed<");

      const reviewed = await app.request(
        "http://localhost/a/tango-mar/admin/messages/msg_casey_1/reviewed",
        {
          method: "POST",
          headers: { Cookie: jordan, Origin: "http://localhost", "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ next: "/a/tango-mar/admin/messages/msg_casey_1" }),
        },
        env,
      );
      expect(reviewed.status).toBe(303);
      expect(decodeURIComponent(reviewed.headers.get("Set-Cookie") ?? "")).toContain(
        "warn:Apply the message review migration in D1, then try again. The steps are in the README under Mark a message reviewed.",
      );
      expect(waitingCount(await (await app.request("http://localhost/a/tango-mar/admin", { headers: { Cookie: jordan } }, env)).text())).toBe(1);
    } finally {
      sqlite.close();
    }
  });
});
