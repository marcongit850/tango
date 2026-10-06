import type { Hono } from "hono";
import { findAssociationBySlug, insertJoinRequest, listStaffContacts, notify, writeAudit } from "../db";
import { safeNextPath } from "../lib/access";
import { resendApiKey, sendResendEmail } from "../lib/email";
import { NotFoundError, isMissingTable } from "../lib/errors";
import { logError, logInfo } from "../lib/log";
import type { AppBindings } from "../types";
import { render } from "../views/layout";
import { homePage, joinReceivedPage, joinRequestPage, legalPage, loginPage } from "../views/public";
import { readForm, redirectTo, requireAssociation, textValue, type AppContext } from "./common";

const HOME_SLUG = "tango-mar";

function showDemo(c: AppContext): boolean {
  const host = new URL(c.req.url).hostname;
  return `${c.env.APP_ENV}` === "development" || host === "localhost" || host === "127.0.0.1";
}

function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function registerPublicRoutes(app: Hono<AppBindings>): void {
  app.get("/", async (c) => {
    return render(c, { title: "Tango Mar", active: "home", body: homePage(showDemo(c)) });
  });

  app.get("/legal", async (c) => render(c, { title: "Not legal advice", active: "legal", body: legalPage() }));

  app.get("/join", async (c) => {
    return render(c, { title: "Request to join", active: "join", body: joinRequestPage() });
  });

  app.post("/join", async (c) => {
    const fields = await readForm(c);
    if (textValue(fields, "company", 200)) return redirectTo(c, "/join/received");
    const name = textValue(fields, "name", 120);
    const email = textValue(fields, "email", 200).toLowerCase();
    const address = textValue(fields, "address", 200);
    const note = textValue(fields, "note", 2000);
    const values = { name, email, address, note };
    if (!name || !validEmail(email)) {
      return render(c, {
        title: "Request to join",
        active: "join",
        status: 400,
        body: joinRequestPage("Enter your name and a valid email.", values),
      });
    }

    const association = await findAssociationBySlug(c.env.DB, HOME_SLUG);
    if (!association) throw new NotFoundError();

    try {
      const id = await insertJoinRequest(c.env.DB, {
        associationId: association.id,
        name,
        email,
        address,
        note,
      });
      await writeAudit(c.env.DB, {
        associationId: association.id,
        actorUserId: null,
        action: "join_request",
        entityType: "join_request",
        entityId: id,
        detail: name,
      });
      const staff = await listStaffContacts(c.env.DB, association.id);
      for (const person of staff) {
        await notify(c.env.DB, {
          associationId: association.id,
          userId: person.user_id,
          kind: "join_request",
          title: `Join request from ${name}`,
          body: email,
          href: `/a/${association.slug}/admin/join-requests`,
        });
      }
      const apiKey = resendApiKey(c.env);
      if (apiKey && staff.length > 0) {
        const origin = new URL(c.req.url).origin;
        const text = [
          `${name} asked to join ${association.name}.`,
          "",
          `Email: ${email}`,
          `Address or lot: ${address || "not provided"}`,
          "",
          note || "No note.",
          "",
          `Review requests: ${origin}/a/${association.slug}/admin/join-requests`,
        ].join("\n");
        for (const person of staff) {
          try {
            await sendResendEmail({
              apiKey,
              from: c.env.EMAIL_FROM,
              to: person.email,
              subject: `${association.name} join request from ${name}`,
              text,
            });
          } catch (error) {
            logError("join_request_email", { message: error instanceof Error ? error.message : "unknown" });
          }
        }
      }
      logInfo("join_request", { associationId: association.id });
    } catch (error) {
      if (!isMissingTable(error)) throw error;
      logError("join_request_unavailable", { message: error instanceof Error ? error.message : "unknown" });
      return render(c, {
        title: "Request to join",
        active: "join",
        status: 503,
        body: joinRequestPage("The board cannot take requests right now. Please try again later.", values),
      });
    }

    return redirectTo(c, "/join/received");
  });

  app.get("/join/received", async (c) => {
    return render(c, { title: "Request received", active: "join", body: joinReceivedPage() });
  });

  app.get("/a/:slug", (c) => {
    requireAssociation(c);
    return c.redirect("/", 302);
  });

  app.get("/login", async (c) => {
    const association = await findAssociationBySlug(c.env.DB, HOME_SLUG);
    if (!association) throw new NotFoundError();
    const nextPath = safeNextPath(association.slug, c.req.query("next") ?? "");
    return render(c, { title: `Sign in · ${association.name}`, active: "login", body: loginPage(association, nextPath) });
  });
}
