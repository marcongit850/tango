import { findUserByEmail } from "../db";

/** Lowercase and trim. Logins are matched case-insensitively. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Insert or reuse a login by email.
 * `keep` fills a blank name or phone and leaves a saved value in place.
 * `replace` overwrites the name, and overwrites the phone when the new phone is not blank.
 */
export function userUpsertSql(policy: "keep" | "replace"): string {
  const conflict =
    policy === "keep"
      ? `name = CASE WHEN trim(users.name) != '' THEN users.name ELSE excluded.name END,
         phone = CASE WHEN trim(users.phone) != '' THEN users.phone ELSE excluded.phone END`
      : `name = excluded.name,
         phone = CASE WHEN excluded.phone != '' THEN excluded.phone ELSE users.phone END`;
  return `INSERT INTO users (id, email, name, phone, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(email) DO UPDATE SET
            ${conflict}`;
}

export type HomeownerAccount = {
  userId: string;
  created: boolean;
  name: string;
  email: string;
};

/**
 * Create a user when the email is new, otherwise reuse that login.
 * Ensures an active membership in this association.
 * An existing board or officer role stays. is_admin and is_master are not changed.
 */
export async function ensureHomeownerAccount(
  db: D1Database,
  input: { associationId: string; email: string; name: string; phone: string; now: string },
): Promise<HomeownerAccount> {
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) throw new Error("Email is not valid.");
  const name = input.name.trim();
  const phone = input.phone.trim();
  const existing = await findUserByEmail(db, email);
  await db
    .prepare(userUpsertSql("keep"))
    .bind(existing?.id ?? crypto.randomUUID(), email, name, phone, input.now)
    .run();
  const user = await findUserByEmail(db, email);
  if (!user) throw new Error("User upsert did not return an id.");
  await db
    .prepare(
      `INSERT INTO memberships (id, association_id, user_id, role_id, status, created_at)
       VALUES (?, ?, ?, 'homeowner', 'active', ?)
       ON CONFLICT(association_id, user_id) DO UPDATE SET
         status = 'active',
         role_id = CASE
           WHEN memberships.role_id IN ('board', 'officer') THEN memberships.role_id
           ELSE 'homeowner'
         END`,
    )
    .bind(crypto.randomUUID(), input.associationId, user.id, input.now)
    .run();
  return { userId: user.id, created: !existing, name: user.name, email: user.email };
}

export async function upsertUserByEmail(
  db: D1Database,
  input: { email: string; name: string; phone: string; now: string; policy: "keep" | "replace" },
): Promise<{ id: string }> {
  const email = input.policy === "keep" ? normalizeEmail(input.email) : input.email;
  const row = await db
    .prepare(`${userUpsertSql(input.policy)} RETURNING id`)
    .bind(crypto.randomUUID(), email, input.name, input.phone, input.now)
    .first<{ id: string }>();
  if (!row) throw new Error("User upsert did not return an id.");
  return row;
}

/**
 * Link a person to a lot.
 * An existing link is left alone, including its primary flag.
 * `if-none` makes a new link primary only when the lot has no primary yet.
 * `never` always inserts a non-primary co-owner.
 */
export async function linkLotOwner(
  db: D1Database,
  input: {
    associationId: string;
    propertyId: string;
    userId: string;
    now: string;
    primary: "if-none" | "never";
  },
): Promise<{ inserted: boolean }> {
  const primarySql =
    input.primary === "never"
      ? "0"
      : `CASE WHEN EXISTS (
           SELECT 1 FROM property_owners existing
           WHERE existing.association_id = ? AND existing.property_id = ? AND existing.is_primary = 1
         ) THEN 0 ELSE 1 END`;
  const sql = `INSERT INTO property_owners (id, association_id, property_id, user_id, is_primary, created_at)
               VALUES (?, ?, ?, ?, ${primarySql}, ?)
               ON CONFLICT(property_id, user_id) DO NOTHING`;
  const statement = db.prepare(sql);
  const bound =
    input.primary === "never"
      ? statement.bind(crypto.randomUUID(), input.associationId, input.propertyId, input.userId, input.now)
      : statement.bind(
          crypto.randomUUID(),
          input.associationId,
          input.propertyId,
          input.userId,
          input.associationId,
          input.propertyId,
          input.now,
        );
  const result = await bound.run();
  return { inserted: (result.meta.changes ?? 0) > 0 };
}

/**
 * Unlink a person from one lot. The user row stays.
 * Removing the primary owner promotes the oldest remaining link.
 * Removing the last owner is allowed.
 */
export async function unlinkLotOwner(
  db: D1Database,
  input: { associationId: string; propertyId: string; userId: string },
): Promise<{ removed: boolean; promotedUserId: string | null }> {
  const link = await db
    .prepare(
      `SELECT id, is_primary
       FROM property_owners
       WHERE association_id = ? AND property_id = ? AND user_id = ?`,
    )
    .bind(input.associationId, input.propertyId, input.userId)
    .first<{ id: string; is_primary: number }>();
  if (!link) return { removed: false, promotedUserId: null };

  const next =
    Number(link.is_primary) === 1
      ? await db
          .prepare(
            `SELECT id, user_id
             FROM property_owners
             WHERE association_id = ? AND property_id = ? AND id != ?
             ORDER BY created_at ASC, id ASC
             LIMIT 1`,
          )
          .bind(input.associationId, input.propertyId, link.id)
          .first<{ id: string; user_id: string }>()
      : null;

  const statements = [
    db.prepare("DELETE FROM property_owners WHERE id = ? AND association_id = ?").bind(link.id, input.associationId),
  ];
  if (next) {
    statements.push(
      db
        .prepare("UPDATE property_owners SET is_primary = 1 WHERE id = ? AND association_id = ? AND property_id = ?")
        .bind(next.id, input.associationId, input.propertyId),
    );
  }
  await db.batch(statements);
  return { removed: true, promotedUserId: next?.user_id ?? null };
}
