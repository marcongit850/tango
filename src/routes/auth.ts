import type { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { findAssociationBySlug, findMembership, findUserByEmail, findUserById, notifyStaff, recordEmailChangeConsent, writeAudit } from "../db";
import { shouldRevealMagicLink, safeNextPath } from "../lib/access";
import { formatPlace } from "../lib/dates";
import { resendApiKey, sendResendEmail } from "../lib/email";
import { isHttps } from "../lib/html";
import { NotFoundError } from "../lib/errors";
import { logError, logInfo } from "../lib/log";
import {
  changeLoginEmail,
  emailChangedLetter,
  emailChangeLetter,
  emailChangeRedirect,
  parseEmailChangeUserId,
} from "../lib/login-email";
import { randomToken, sha256Hex } from "../lib/tokens";
import type { AppBindings } from "../types";
import { render } from "../views/layout";
import { checkEmailPage, emailChangeBlockedPage, invalidLinkPage, loginPage } from "../views/public";
import { readForm, redirectTo, textValue, type AppContext } from "./common";

const HOME_SLUG = "tango-mar";

const LINK_MINUTES = 20;
const SESSION_SECONDS = 60 * 60 * 24 * 30;

export function registerAuthRoutes(app: Hono<AppBindings>): void {
  app.post("/login", async (c) => {
    const association = await findAssociationBySlug(c.env.DB, HOME_SLUG);
    if (!association) throw new NotFoundError();
    const fields = await readForm(c);
    const email = textValue(fields, "email", 200).toLowerCase();
    const nextPath = safeNextPath(association.slug, textValue(fields, "next", 300));
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return render(c, {
        title: `Sign in · ${association.name}`,
        active: "login",
        status: 400,
        body: loginPage(association, nextPath, "Enter the email address on the roster."),
      });
    }

    const user = await findUserByEmail(c.env.DB, email);
    const membership = user ? await findMembership(c.env.DB, association.id, user.id) : null;
    let devLink: string | null = null;
    if (user && membership && membership.status !== "inactive") {
      devLink = await issueMagicLink(c, {
        email,
        associationId: association.id,
        associationName: association.name,
        place: formatPlace(association),
        redirectPath: nextPath,
      });
    } else {
      await sha256Hex(email);
    }

    return render(c, {
      title: "Check your email",
      active: "login",
      body: checkEmailPage(association.name, devLink),
    });
  });

  app.get("/auth/verify", async (c) => {
    const token = c.req.query("token") ?? "";
    if (!/^[a-f0-9]{64}$/.test(token)) return renderInvalid(c);
    const tokenHash = await sha256Hex(token);
    const now = new Date().toISOString();
    const link = await c.env.DB
      .prepare(
        `SELECT id, email, association_id, redirect_path, expires_at, used_at
         FROM magic_links WHERE token_hash = ?`,
      )
      .bind(tokenHash)
      .first<{
        id: string;
        email: string;
        association_id: string | null;
        redirect_path: string;
        expires_at: string;
        used_at: string | null;
      }>();
    if (!link || link.used_at || link.expires_at <= now) return renderInvalid(c);

    const consumed = await c.env.DB
      .prepare("UPDATE magic_links SET used_at = ? WHERE id = ? AND used_at IS NULL")
      .bind(now, link.id)
      .run();
    if ((consumed.meta.changes ?? 0) === 0) return renderInvalid(c);

    const emailChangeUserId = parseEmailChangeUserId(link.redirect_path);
    if (emailChangeUserId) {
      const applied = await applyEmailChange(c, { userId: emailChangeUserId, newEmail: link.email, associationId: link.association_id });
      if (!applied) return renderInvalid(c);
      if (applied === "taken") {
        return render(c, { title: "Email not changed", active: "login", status: 400, body: emailChangeBlockedPage() });
      }
    }

    const user = await findUserByEmail(c.env.DB, link.email);
    if (!user) return renderInvalid(c);
    await c.env.DB.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(now, user.id).run();

    let destination = "/";
    if (link.association_id) {
      const association = await c.env.DB
        .prepare("SELECT id, slug FROM associations WHERE id = ?")
        .bind(link.association_id)
        .first<{ id: string; slug: string }>();
      if (association) {
        await c.env.DB
          .prepare(
            `UPDATE memberships SET status = 'active'
             WHERE association_id = ? AND user_id = ? AND status = 'invited'`,
          )
          .bind(association.id, user.id)
          .run();
        destination = emailChangeUserId
          ? `/a/${association.slug}/profile`
          : safeNextPath(association.slug, link.redirect_path || `/a/${association.slug}/dashboard`);
        await writeAudit(c.env.DB, {
          associationId: association.id,
          actorUserId: user.id,
          action: "login",
          entityType: "user",
          entityId: user.id,
          detail: "Signed in with a magic link.",
        });
      }
    }

    const sessionToken = randomToken();
    const expires = new Date(Date.now() + SESSION_SECONDS * 1000).toISOString();
    await c.env.DB
      .prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), user.id, await sha256Hex(sessionToken), expires, now)
      .run();
    setCookie(c, "tango_session", sessionToken, {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: isHttps(c.req.url),
      maxAge: SESSION_SECONDS,
    });
    logInfo("login", { associationId: link.association_id });
    if (emailChangeUserId) return redirectTo(c, destination, "Your email is updated.");
    return c.redirect(destination, 303);
  });

  app.post("/logout", async (c) => {
    await readForm(c);
    const token = getCookie(c, "tango_session");
    if (token) {
      await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
    }
    deleteCookie(c, "tango_session", { path: "/" });
    return redirectTo(c, "/", "You are signed out.");
  });
}

async function issueMagicLink(
  c: AppContext,
  input: { email: string; associationId: string; associationName: string; place: string; redirectPath: string },
): Promise<string | null> {
  const link = await storeMagicLink(c, {
    email: input.email,
    associationId: input.associationId,
    redirectPath: input.redirectPath,
  });
  const text = [
    `Use this link to sign in to the ${input.associationName} owner portal.`,
    `It expires in ${LINK_MINUTES} minutes and works once.`,
    "",
    link,
    "",
    "If you did not ask for this link, you can ignore this email.",
    "",
    `${input.associationName} is ${input.place.startsWith("Miramar") ? "a beach neighborhood in" : "located in"} ${input.place}.`,
    "This portal is not legal advice.",
  ].join("\n");
  return deliverMagicLink(c, {
    email: input.email,
    associationId: input.associationId,
    subject: `Your ${input.associationName} sign-in link`,
    text,
    link,
  });
}

export async function issueEmailChangeLink(
  c: AppContext,
  input: { userId: string; newEmail: string; associationId: string; associationName: string },
): Promise<string | null> {
  const link = await storeMagicLink(c, {
    email: input.newEmail,
    associationId: input.associationId,
    redirectPath: emailChangeRedirect(input.userId),
    replaceSameRedirect: true,
  });
  const letter = emailChangeLetter({ associationName: input.associationName, link, minutes: LINK_MINUTES });
  return deliverMagicLink(c, {
    email: input.newEmail,
    associationId: input.associationId,
    subject: letter.subject,
    text: letter.text,
    link,
  });
}

async function storeMagicLink(
  c: AppContext,
  input: { email: string; associationId: string; redirectPath: string; replaceSameRedirect?: boolean },
): Promise<string> {
  const now = new Date();
  await c.env.DB.prepare("DELETE FROM magic_links WHERE expires_at < ?").bind(now.toISOString()).run();
  if (input.replaceSameRedirect) {
    await c.env.DB.prepare("DELETE FROM magic_links WHERE redirect_path = ? AND used_at IS NULL").bind(input.redirectPath).run();
  }
  const token = randomToken();
  const expires = new Date(now.getTime() + LINK_MINUTES * 60 * 1000).toISOString();
  await c.env.DB
    .prepare(
      `INSERT INTO magic_links (id, email, association_id, token_hash, redirect_path, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), input.email, input.associationId, await sha256Hex(token), input.redirectPath, expires, now.toISOString())
    .run();
  return `${new URL(c.req.url).origin}/auth/verify?token=${token}`;
}

async function deliverMagicLink(
  c: AppContext,
  input: { email: string; associationId: string; subject: string; text: string; link: string },
): Promise<string | null> {
  const apiKey = resendApiKey(c.env);
  const sent = apiKey
    ? await sendResendEmail({
        apiKey,
        from: c.env.EMAIL_FROM,
        to: input.email,
        subject: input.subject,
        text: input.text,
      })
    : false;
  logInfo("magic_link_issued", { associationId: input.associationId, emailed: sent });
  const url = new URL(c.req.url);
  return shouldRevealMagicLink({ appEnv: `${c.env.APP_ENV}`, hostname: url.hostname, emailSent: sent }) ? input.link : null;
}

async function applyEmailChange(
  c: AppContext,
  input: { userId: string; newEmail: string; associationId: string | null },
): Promise<true | "taken" | false> {
  const current = await findUserById(c.env.DB, input.userId);
  if (!current) return false;
  const previousEmail = current.email;
  const updated = await changeLoginEmail(c.env.DB, current.id, input.newEmail);
  if (!updated.ok) return updated.reason === "taken" ? "taken" : false;
  if (!updated.changed || !input.associationId) return true;

  const association = await c.env.DB
    .prepare("SELECT id, slug, name FROM associations WHERE id = ?")
    .bind(input.associationId)
    .first<{ id: string; slug: string; name: string }>();
  if (!association) return true;

  const label = current.name || previousEmail;
  await writeAudit(c.env.DB, {
    associationId: association.id,
    actorUserId: current.id,
    action: "profile_email",
    entityType: "user",
    entityId: current.id,
    detail: `${label} changed their login email from ${previousEmail} to ${updated.email}.`,
  });
  await notifyStaff(c.env.DB, {
    associationId: association.id,
    kind: "profile",
    title: "Login email changed",
    body: `${label} changed their login email from ${previousEmail} to ${updated.email}.`,
    href: `/a/${association.slug}/admin/owners/${current.id}`,
  });
  const recorded = await recordEmailChangeConsent(c.env.DB, {
    associationId: association.id,
    userId: current.id,
    ownerName: current.name,
    newEmail: updated.email,
    ip: (c.req.header("cf-connecting-ip") ?? "").trim().slice(0, 80),
    userAgent: (c.req.header("user-agent") ?? "").trim().slice(0, 400),
    sessionId: "",
  });
  if (recorded) {
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: current.id,
      action: "consent_revoked",
      entityType: "user",
      entityId: current.id,
      detail: `email_changed ${updated.email}`,
    });
  }

  const apiKey = resendApiKey(c.env);
  if (apiKey && previousEmail.toLowerCase() !== updated.email.toLowerCase()) {
    const letter = emailChangedLetter({ associationName: association.name, newEmail: updated.email });
    try {
      await sendResendEmail({
        apiKey,
        from: c.env.EMAIL_FROM,
        to: previousEmail,
        subject: letter.subject,
        text: letter.text,
      });
    } catch (error) {
      logError("profile_email_notice", { message: error instanceof Error ? error.message : "unknown" });
    }
  }
  logInfo("profile_email", { associationId: association.id });
  return true;
}

function renderInvalid(c: AppContext): Promise<Response> {
  return render(c, {
    title: "Link not valid",
    active: "login",
    status: 400,
    body: invalidLinkPage(),
  });
}
