import type { Hono } from "hono";
import {
  findAssociationBySlug,
  findMembership,
  insertJoinRequest,
  joinRequestNoticeHref,
  joinRequestNoticeTitle,
  listStaffContacts,
  notify,
  retireLegacyJoinNotices,
  writeAudit,
} from "../db";
import { canViewAdmin, safeNextPath } from "../lib/access";
import {
  DEMO_INBOX,
  allowDemoRequest,
  demoEmailText,
  demoFieldError,
  demoSubject,
  parseDemoIntent,
  type DemoFormValues,
} from "../lib/demo-request";
import { formatDateTime } from "../lib/dates";
import { resendApiKey, sendResendEmail } from "../lib/email";
import {
  allowEstoppelRequest,
  estoppelEmailText,
  estoppelFieldError,
  estoppelRecipient,
  estoppelSubject,
  type EstoppelFormValues,
} from "../lib/estoppel";
import { NotFoundError, isMissingTable } from "../lib/errors";
import { logError, logInfo } from "../lib/log";
import type { AppBindings, Association } from "../types";
import { render } from "../views/layout";
import { privacyPage, termsPage } from "../views/legal";
import { hoaPitchPage } from "../views/pitch";
import { estoppelPage, homePage, joinReceivedPage, joinRequestPage, legalPage, loginPage, type HomePortal } from "../views/public";
import { readForm, redirectTo, requireAssociation, textValue, type AppContext, type FormFields } from "./common";

const HOME_SLUG = "tango-mar";

function showDemo(c: AppContext): boolean {
  const host = new URL(c.req.url).hostname;
  return `${c.env.APP_ENV}` === "development" || host === "localhost" || host === "127.0.0.1";
}

function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function portalForUser(c: AppContext): Promise<HomePortal | null> {
  const user = c.get("user");
  if (!user) return null;
  const association = await findAssociationBySlug(c.env.DB, HOME_SLUG);
  if (!association) return null;
  const membership = await findMembership(c.env.DB, association.id, user.id);
  if (!membership || membership.status === "inactive") return null;
  return {
    dashboardHref: `/a/${association.slug}/dashboard`,
    adminHref: canViewAdmin(membership) ? `/a/${association.slug}/admin` : null,
  };
}

export function registerPublicRoutes(app: Hono<AppBindings>): void {
  app.get("/", async (c) => {
    const portal = await portalForUser(c);
    return render(c, { title: "Tango Mar", active: "home", body: homePage(showDemo(c), portal), portal });
  });

  app.get("/bring-this-to-your-hoa", async (c) => {
    const intent = parseDemoIntent(c.req.query("intent") ?? "") ?? "demo";
    return render(c, {
      title: "Bring This to Your HOA · Tango Mar",
      active: "bring",
      marketing: true,
      body: hoaPitchPage({ intent, sent: c.req.query("sent") === "1" }),
    });
  });

  app.post("/bring-this-to-your-hoa", async (c) => {
    const fields = await readForm(c);
    if (textValue(fields, "company", 200)) {
      allowDemoRequest(clientIp(c));
      return redirectTo(c, "/bring-this-to-your-hoa?sent=1#demo-form");
    }
    const values = demoValues(fields);
    const error = demoFieldError(values);
    if (error) return pitchResponse(c, values, error, 400);
    if (!allowDemoRequest(clientIp(c))) {
      return pitchResponse(c, values, "Please wait a few minutes, then try again.", 429);
    }
    const intent = parseDemoIntent(values.intent);
    if (!intent) return pitchResponse(c, values, "Choose a request.", 400);
    const apiKey = resendApiKey(c.env);
    let sent = false;
    if (apiKey) {
      try {
        sent = await sendResendEmail({
          apiKey,
          from: c.env.EMAIL_FROM,
          to: DEMO_INBOX,
          replyTo: values.email,
          subject: demoSubject(intent, values.hoa),
          text: demoEmailText({ ...values, intent }),
        });
      } catch (error) {
        logError("demo_request", { message: error instanceof Error ? error.message : "unknown" });
      }
    } else {
      logError("demo_request", { message: "email not configured" });
    }
    if (!sent) return pitchResponse(c, values, "Your request could not be sent. Please try again later.", 503);
    logInfo("demo_request", { intent });
    return redirectTo(c, "/bring-this-to-your-hoa?sent=1#demo-form", "Your request was sent.");
  });

  app.get("/legal", async (c) => render(c, { title: "Not legal advice", active: "legal", body: legalPage() }));

  app.get("/privacy", async (c) => render(c, { title: "Privacy Policy · Tango Mar", active: "privacy", body: privacyPage() }));

  app.get("/terms", async (c) => render(c, { title: "Terms of Use · Tango Mar", active: "terms", body: termsPage() }));

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
      await retireLegacyJoinNotices(c.env.DB, association.id, { name, email });
      for (const person of staff) {
        await notify(c.env.DB, {
          associationId: association.id,
          userId: person.user_id,
          kind: "join_request",
          title: joinRequestNoticeTitle(name),
          body: email,
          href: joinRequestNoticeHref(association.slug, id),
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

  app.get("/a/:slug/estoppel", async (c) => {
    const association = requireAssociation(c);
    return render(c, {
      title: `Estoppel Requests · ${association.name}`,
      body: estoppelPage(association, { sent: c.req.query("sent") === "1" }),
    });
  });

  app.post("/a/:slug/estoppel", async (c) => {
    const association = requireAssociation(c);
    const fields = await readForm(c);
    const back = `/a/${association.slug}/estoppel`;
    if (textValue(fields, "website", 200)) {
      allowEstoppelRequest(clientIp(c));
      return redirectTo(c, `${back}?sent=1`);
    }
    const values = estoppelValues(fields);
    const error = estoppelFieldError(values);
    if (error) return estoppelResponse(c, association, values, error, 400);
    if (!allowEstoppelRequest(clientIp(c))) {
      return estoppelResponse(c, association, values, "Please wait a few minutes, then try again.", 429);
    }
    const apiKey = resendApiKey(c.env);
    let sent = false;
    if (apiKey) {
      try {
        sent = await sendResendEmail({
          apiKey,
          from: c.env.EMAIL_FROM,
          to: estoppelRecipient(),
          replyTo: values.email,
          subject: estoppelSubject(values.property),
          text: estoppelEmailText({
            ...values,
            submittedAt: formatDateTime(new Date().toISOString(), "America/Chicago"),
          }),
        });
      } catch (error) {
        logError("estoppel_request", { message: error instanceof Error ? error.message : "unknown" });
      }
    } else {
      logError("estoppel_request", { message: "email not configured" });
    }
    if (!sent) {
      return estoppelResponse(c, association, values, "Your request could not be sent. Please try again later.", 503);
    }
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: null,
      action: "estoppel_request",
      entityType: "estoppel",
      entityId: association.id,
      detail: `${values.name}: ${values.property}`,
    });
    logInfo("estoppel_request", { associationId: association.id });
    return redirectTo(c, `${back}?sent=1`);
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

function clientIp(c: AppContext): string {
  const cf = c.req.header("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || "unknown";
}

function estoppelValues(fields: FormFields): EstoppelFormValues {
  return {
    name: textValue(fields, "name", 120),
    company: textValue(fields, "company", 160),
    email: textValue(fields, "email", 200).toLowerCase(),
    phone: textValue(fields, "phone", 40),
    property: textValue(fields, "property", 200),
    owners: textValue(fields, "owners", 200),
    closingDate: textValue(fields, "closing_date", 10),
    notes: textValue(fields, "notes", 2000),
  };
}

function estoppelResponse(
  c: AppContext,
  association: Association,
  values: EstoppelFormValues,
  error: string,
  status: number,
): Promise<Response> {
  return render(c, {
    title: `Estoppel Requests · ${association.name}`,
    status,
    body: estoppelPage(association, { error, values }),
  });
}

function demoValues(fields: FormFields): DemoFormValues {
  return {
    intent: textValue(fields, "intent", 20),
    name: textValue(fields, "name", 120),
    email: textValue(fields, "email", 200).toLowerCase(),
    hoa: textValue(fields, "hoa", 160),
    phone: textValue(fields, "phone", 40),
    homes: textValue(fields, "homes", 10),
    message: textValue(fields, "message", 2000),
  };
}

function pitchResponse(c: AppContext, values: DemoFormValues, error: string, status: number): Promise<Response> {
  return render(c, {
    title: "Bring This to Your HOA · Tango Mar",
    active: "bring",
    marketing: true,
    status,
    body: hoaPitchPage({
      intent: parseDemoIntent(values.intent) ?? "demo",
      error,
      values,
    }),
  });
}
