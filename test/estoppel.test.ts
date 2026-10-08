import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { ESTOPPEL_INBOX, estoppelRecipient, resetEstoppelRateLimit } from "../src/lib/estoppel";
import { siteFooter } from "../src/views/layout";

const PATH = "/a/tango-mar/estoppel";

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
  for (const file of ["migrations/0001_schema.sql", "migrations/0002_seed_tango_mar.sql"]) {
    sqlite.exec(readFileSync(file, "utf8"));
  }
  return { sqlite, db: new SqliteD1(sqlite) as unknown as D1Database };
}

function portalEnv(db: D1Database, apiKey = "re_test"): Env {
  return {
    DB: db,
    APP_ENV: "production",
    EMAIL_FROM: "Tango Mar <donotreply@mytangomar.com>",
    DOCUMENTS: {} as R2Bucket,
    RESEND_API_KEY: apiKey,
  } as Env;
}

function validFields(): Record<string, string> {
  return {
    name: "Pat Lee",
    company: "Gulf Title",
    email: "Pat@Example.com",
    phone: "850-555-0199",
    property: "Lot 14",
    owners: "Sam Rivera",
    closing_date: "2026-11-15",
    notes: "Please send the certificate.",
  };
}

function postEstoppel(
  app: ReturnType<typeof createApp>,
  env: Env,
  fields: Record<string, string>,
  ip = "203.0.113.40",
) {
  return app.request(
    `http://localhost${PATH}`,
    {
      method: "POST",
      headers: {
        Origin: "http://localhost",
        "Content-Type": "application/x-www-form-urlencoded",
        "CF-Connecting-IP": ip,
      },
      body: new URLSearchParams(fields),
    },
    env,
  );
}

describe("estoppel requests", () => {
  beforeEach(() => {
    resetEstoppelRateLimit();
  });

  it("links Estoppel Requests from the shared footer", () => {
    const html = siteFooter();
    expect(html).toContain('href="/a/tango-mar/estoppel">Estoppel Requests</a>');
    expect(html).toContain('href="/a/tango-mar/messages">Contact</a>');
    expect(html).toContain('href="/bring-this-to-your-hoa">Bring This to Your HOA</a>');
  });

  it("renders signed out with the association name and address, and hides the inbox", async () => {
    const { db } = openPortal();
    const app = createApp();
    const response = await app.request(`http://localhost${PATH}`, {}, portalEnv(db));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<h1>Estoppel Requests</h1>");
    expect(html).toContain("Section 720.30851, Florida Statutes");
    expect(html).toContain("Tango Mar<br>Attn: Board of Directors<br>31 Tang O Mar Drive, Miramar Beach, FL 32550");
    expect(html).toContain("Requests may be mailed to the address above or submitted with the form below.");
    expect(html).toContain('action="/a/tango-mar/estoppel"');
    expect(html).not.toContain("Resident login</h1>");
    expect(html).not.toContain(ESTOPPEL_INBOX);
    expect(html).not.toContain("whpinc");
    expect(html).not.toContain("\u2014");
    expect(html).not.toContain("\u2013");
    expect(estoppelRecipient()).toBe(ESTOPPEL_INBOX);
    expect(estoppelRecipient("  Board@Example.com ")).toBe("board@example.com");
    expect(estoppelRecipient("")).toBe(ESTOPPEL_INBOX);
  });

  it("omits the street line when the association address is empty", async () => {
    const { sqlite, db } = openPortal();
    sqlite.prepare("UPDATE associations SET address_line1 = '' WHERE slug = 'tango-mar'").run();
    const app = createApp();
    const html = await (await app.request(`http://localhost${PATH}`, {}, portalEnv(db))).text();
    expect(html).toContain("Attn: Board of Directors");
    expect(html).not.toContain("31 Tang O Mar Drive");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("Miramar Beach, FL");
  });

  it("emails the configured inbox with Reply-To and writes an audit entry", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response("{}", { status: 200 });
    };
    try {
      const sent = await postEstoppel(app, env, validFields());
      expect(sent.status).toBe(303);
      expect(sent.headers.get("Location")).toBe(`${PATH}?sent=1`);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("https://api.resend.com/emails");
      expect(calls[0]?.body).toMatchObject({
        from: "Tango Mar <donotreply@mytangomar.com>",
        to: [ESTOPPEL_INBOX],
        reply_to: "pat@example.com",
        subject: "Estoppel request: Lot 14",
      });
      const text = String(calls[0]?.body.text);
      expect(text).toContain("Name: Pat Lee");
      expect(text).toContain("Company: Gulf Title");
      expect(text).toContain("Email: pat@example.com");
      expect(text).toContain("Phone: 850-555-0199");
      expect(text).toContain("Property or lot: Lot 14");
      expect(text).toContain("Owner names: Sam Rivera");
      expect(text).toContain("Anticipated closing date: 2026-11-15");
      expect(text).toContain("Notes: Please send the certificate.");
      expect(text).toContain("Time:");
      expect(text).toMatch(/CDT|CST/);

      const thanks = await app.request(`http://localhost${PATH}?sent=1`, {}, env);
      expect(await thanks.text()).toContain("Your request was sent.");
      const audit = sqlite
        .prepare("SELECT action, entity_type, actor_user_id, detail FROM audit_log WHERE action = 'estoppel_request'")
        .all() as {
        action: string;
        entity_type: string;
        actor_user_id: string | null;
        detail: string;
      }[];
      expect(audit).toEqual([
        {
          action: "estoppel_request",
          entity_type: "estoppel",
          actor_user_id: null,
          detail: "Pat Lee: Lot 14",
        },
      ]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("keeps invalid fields on the page and does not email", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const calls: unknown[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
      calls.push(JSON.parse(String(args[1]?.body)));
      return new Response("{}", { status: 200 });
    };
    try {
      const response = await postEstoppel(app, portalEnv(db), { ...validFields(), email: "not-an-email", closing_date: "soon" });
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Enter a valid email.");
      expect(html).toContain('value="Pat Lee"');
      expect(html).toContain('value="Lot 14"');
      expect(html).not.toContain(ESTOPPEL_INBOX);
      expect(calls).toHaveLength(0);
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'estoppel_request'").get()).toEqual({ n: 0 });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("treats a filled honeypot as sent and does not email", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    let called = false;
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      called = true;
      return new Response("{}", { status: 200 });
    };
    try {
      const response = await postEstoppel(app, portalEnv(db), { ...validFields(), website: "https://spam.example" });
      expect(response.status).toBe(303);
      expect(response.headers.get("Location")).toBe(`${PATH}?sent=1`);
      expect(called).toBe(false);
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'estoppel_request'").get()).toEqual({ n: 0 });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("limits repeated requests from the same address", async () => {
    const { db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response("{}", { status: 200 });
    try {
      for (let i = 0; i < 5; i += 1) {
        const ok = await postEstoppel(app, env, validFields());
        expect(ok.status).toBe(303);
      }
      const blocked = await postEstoppel(app, env, validFields());
      expect(blocked.status).toBe(429);
      expect(await blocked.text()).toContain("Please wait a few minutes, then try again.");
    } finally {
      globalThis.fetch = original;
    }
  });
});
