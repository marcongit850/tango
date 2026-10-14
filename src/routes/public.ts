import type { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import {
  findAssociationByCode,
  findAssociationBySlug,
  findAssociationByVanity,
  findMembership,
  insertJoinRequest,
  joinRequestNoticeHref,
  joinRequestNoticeTitle,
  listStaffContacts,
  neighborhoodColumnsReady,
  notify,
  retireLegacyJoinNotices,
  writeAudit,
} from "../db";
import { canViewAdmin } from "../lib/access";
import {
  allowContactRequest,
  contactEmailText,
  contactFieldError,
  contactSubject,
  CONTACT_INBOX,
  type ContactValues,
} from "../lib/contact";
import {
  associationPublicPath,
  isProductHost,
  isVanityCandidate,
  neighborhoodDestination,
  portalUrl,
  vanityOf,
} from "../lib/hosts";
import { allowNeighborhoodLookup, normalizeNeighborhoodCode } from "../lib/neighborhood";
import { DEMO_ASSOCIATION_ID, DEMO_COOKIE, DEMO_SLUG, isDemoAssociation, type DemoRole } from "../lib/demo";
import { esc, isHttps } from "../lib/html";
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
import { performLogin, showAssociationLogin } from "./auth";
import { render } from "../views/layout";
import { privacyPage, termsPage } from "../views/legal";
import { hoaPitchPage } from "../views/pitch";
import { productPage, productPitchChrome, type ProductPageState } from "../views/product";
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

async function portalForUser(c: AppContext, associationSlug = HOME_SLUG): Promise<HomePortal | null> {
  const user = c.get("user");
  if (!user) return null;
  const association = await findAssociationBySlug(c.env.DB, associationSlug);
  if (!association) return null;
  const membership = await findMembership(c.env.DB, association.id, user.id);
  if (!membership || membership.status === "inactive") return null;
  const base = associationPublicPath(association);
  return {
    dashboardHref: `${base}/dashboard`,
    adminHref: canViewAdmin(membership) ? `${base}/admin` : null,
  };
}

function setDemoCookie(c: AppContext, role: DemoRole): void {
  setCookie(c, DEMO_COOKIE, role, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: isHttps(c.req.url),
    maxAge: 60 * 60 * 24 * 14,
  });
}

async function enterDemo(c: AppContext, role: DemoRole): Promise<Response> {
  const association = await findAssociationBySlug(c.env.DB, DEMO_SLUG);
  if (!association || association.id !== DEMO_ASSOCIATION_ID) {
    return render(c, {
      title: "Demo",
      body: `<section class="panel"><h1>Demo is not ready</h1><p>Apply the D1 migrations, then reload.</p></section>`,
    });
  }
  setDemoCookie(c, role);
  const tail = role === "admin" ? "/admin" : "/dashboard";
  const destination = vanityOf(association) ? associationPublicPath(association, tail) : `/a/${DEMO_SLUG}${tail}`;
  return c.redirect(destination, 303);
}

export function registerPublicRoutes(app: Hono<AppBindings>): void {
  app.get("/demo", (c) => enterDemo(c, "owner"));
  app.get("/demo/owner", (c) => enterDemo(c, "owner"));
  app.get("/demo/admin", (c) => enterDemo(c, "admin"));
  app.get("/demo/leave", (c) => {
    deleteCookie(c, DEMO_COOKIE, { path: "/" });
    return c.redirect("/", 303);
  });

  app.get("/", async (c) => {
    if (isProductHost(new URL(c.req.url).hostname)) {
      return render(c, {
        title: "MyHOADashboard",
        product: true,
        icon: "product",
        body: productPage({ contactSent: c.req.query("sent") === "1", contactOpen: c.req.query("sent") === "1" }),
      });
    }
    const portal = await portalForUser(c);
    return render(c, { title: "Tang-O-Mar", active: "home", body: homePage(showDemo(c), portal), portal });
  });

  app.post("/neighborhood", async (c) => {
    const fields = await readForm(c);
    const code = textValue(fields, "code", 12);
    const fail = (codeError: string, status: number) =>
      render(c, {
        title: "MyHOADashboard",
        product: true,
        icon: "product",
        status,
        body: productPage({ code, codeError }),
      });
    if (!isProductHost(new URL(c.req.url).hostname) && !showDemo(c)) {
      return fail("Enter your neighborhood code on MyHOADashboard.", 404);
    }
    if (!allowNeighborhoodLookup(clientIp(c))) return fail("Please wait a few minutes, then try again.", 429);
    const normalized = normalizeNeighborhoodCode(code);
    if (!normalized) return fail("Enter the neighborhood code you were given. It is 3 to 12 digits.", 400);
    if (!(await neighborhoodColumnsReady(c.env.DB))) {
      return fail("Neighborhood codes are not ready yet. Please try again later.", 503);
    }
    const association = await findAssociationByCode(c.env.DB, normalized);
    const vanity = association ? vanityOf(association) : "";
    if (!association || !vanity) return fail("That neighborhood code was not found. Check the code and try again.", 404);
    return c.redirect(neighborhoodDestination(c.req.url, vanity), 303);
  });

  app.post("/contact", async (c) => {
    const fields = await readForm(c);
    const values = contactValues(fields);
    const page = (state: ProductPageState, status = 200) =>
      render(c, { title: "MyHOADashboard", product: true, icon: "product", status, body: productPage(state) });
    if (textValue(fields, "website", 200)) {
      allowContactRequest(clientIp(c));
      return c.redirect("/?sent=1#contact", 303);
    }
    const error = contactFieldError(values);
    if (error) return page({ contactError: error, contactValues: values, contactOpen: true }, 400);
    if (!allowContactRequest(clientIp(c))) {
      return page({ contactError: "Please wait a few minutes, then try again.", contactValues: values, contactOpen: true }, 429);
    }
    const apiKey = resendApiKey(c.env);
    let sent = false;
    if (apiKey) {
      try {
        sent = await sendResendEmail({
          apiKey,
          from: c.env.EMAIL_FROM,
          to: CONTACT_INBOX,
          replyTo: values.email,
          subject: contactSubject(values.neighborhood),
          text: contactEmailText(values),
        });
      } catch (error) {
        logError("contact_request", { message: error instanceof Error ? error.message : "unknown" });
      }
    } else {
      logError("contact_request", { message: "email not configured" });
    }
    if (!sent) return page({ contactError: "Your message could not be sent. Please try again later.", contactValues: values, contactOpen: true }, 503);
    logInfo("contact_request", {});
    return c.redirect("/?sent=1#contact", 303);
  });

  app.get("/bring-this-to-your-hoa", async (c) => {
    const intent = parseDemoIntent(c.req.query("intent") ?? "") ?? "demo";
    return pitchPageResponse(c, { intent, sent: c.req.query("sent") === "1" });
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

  app.get("/privacy", async (c) => render(c, { title: "Privacy Policy · Tang-O-Mar", active: "privacy", body: privacyPage() }));

  app.get("/terms", async (c) => render(c, { title: "Terms of Use · Tang-O-Mar", active: "terms", body: termsPage() }));

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
        const review = portalUrl(c.req.url, association, "/admin/join-requests");
        const text = [
          `${name} asked to join ${association.name}.`,
          "",
          `Email: ${email}`,
          `Address or lot: ${address || "not provided"}`,
          "",
          note || "No note.",
          "",
          `Review requests: ${review}`,
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
    const association = requireAssociation(c);
    if (isDemoAssociation(association)) {
      const dest = vanityOf(association) ? associationPublicPath(association, "/dashboard") : `/a/${association.slug}/dashboard`;
      return c.redirect(dest, 302);
    }
    if (vanityOf(association) && isProductHost(new URL(c.req.url).hostname)) {
      return c.redirect(associationPublicPath(association), 302);
    }
    return c.redirect("/", 302);
  });

  app.get("/login", async (c) => {
    const association = await findAssociationBySlug(c.env.DB, HOME_SLUG);
    if (!association) throw new NotFoundError();
    return showAssociationLogin(c, association, "/login");
  });

  app.get("/:vanity/login", async (c) => {
    const association = await vanityAssociation(c);
    if (!association) return c.notFound();
    return showAssociationLogin(c, association, associationPublicPath(association, "/login"));
  });

  app.post("/:vanity/login", async (c) => {
    const association = await vanityAssociation(c);
    if (!association) return c.notFound();
    if (isDemoAssociation(association)) {
      return redirectTo(c, associationPublicPath(association), "Demo only, changes are not saved", "warn");
    }
    return performLogin(c, association, associationPublicPath(association, "/login"));
  });

  app.get("/:vanity/join", async (c) => {
    const association = await vanityAssociation(c);
    if (!association) return c.notFound();
    return render(c, {
      title: "Request to join",
      active: "join",
      icon: association.slug === HOME_SLUG ? "tango" : "product",
      body: joinRequestPage(),
    });
  });

  app.get("/:vanity", async (c) => {
    const association = await vanityAssociation(c);
    if (!association) return c.notFound();
    if (isDemoAssociation(association)) return c.redirect(associationPublicPath(association, "/dashboard"), 302);
    const portal = await portalForUser(c, association.slug);
    const base = associationPublicPath(association);
    const body =
      association.slug === HOME_SLUG
        ? `${homePage(showDemo(c), portal, { portalBase: base, loginHref: `${base}/login`, joinHref: `${base}/join` })}${loginPanel(association, base)}`
        : genericAssociationLanding(association, base);
    return render(c, {
      title: association.name,
      active: "home",
      landing: true,
      icon: association.slug === HOME_SLUG ? "tango" : "product",
      body,
      portal,
    });
  });
}

async function vanityAssociation(c: AppContext): Promise<Association | null> {
  const vanity = c.req.param("vanity") ?? "";
  if (!isVanityCandidate(vanity)) return null;
  return findAssociationByVanity(c.env.DB, vanity);
}

function loginPanel(association: Association, base: string): string {
  return `<div class="wrap home-signin">${loginPage(association, `${base}/dashboard`, "", `${base}/login`)}</div>`;
}

function genericAssociationLanding(association: Association, base: string): string {
  return `<section class="panel">
      <h1>${esc(association.name)}</h1>
      <p>Sign in with the email on the roster, or request access if you do not have a login yet.</p>
      <p class="actions"><a class="button secondary" href="${base}/join">Request access</a></p>
    </section>
    ${loginPanel(association, base)}`;
}

function contactValues(fields: FormFields): ContactValues {
  return {
    name: textValue(fields, "name", 120),
    email: textValue(fields, "email", 200).toLowerCase(),
    neighborhood: textValue(fields, "neighborhood", 160),
    message: textValue(fields, "message", 2000),
  };
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

function pitchPageResponse(c: AppContext, options: Parameters<typeof hoaPitchPage>[0], status = 200): Promise<Response> {
  const product = isProductHost(new URL(c.req.url).hostname);
  const body = hoaPitchPage({ ...options, product });
  if (product) {
    return render(c, {
      title: "Bring This to Your HOA · MyHOADashboard",
      product: true,
      icon: "product",
      status,
      body: productPitchChrome(body),
    });
  }
  return render(c, {
    title: "Bring This to Your HOA · Tang-O-Mar",
    active: "bring",
    marketing: true,
    status,
    body,
  });
}

function pitchResponse(c: AppContext, values: DemoFormValues, error: string, status: number): Promise<Response> {
  return pitchPageResponse(
    c,
    {
      intent: parseDemoIntent(values.intent) ?? "demo",
      error,
      values,
    },
    status,
  );
}
