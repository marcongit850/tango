import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { findAssociationBySlug, findAssociationByVanity, findMembership, findSessionUser, findUserById } from "./db";
import { isLegacyHost, isVanityCandidate, legacyRedirectEnabled, legacyRedirectTarget, vanityInternalPath, vanityOf } from "./lib/hosts";
import {
  DEMO_COOKIE,
  DEMO_SLUG,
  DEMO_WRITE_MESSAGE,
  demoReturnPath,
  demoRoleFromCookie,
  demoUserIdForRole,
  isDemoAssociation,
  isDemoUserId,
  isDemoWrite,
} from "./lib/demo";
import { ForbiddenError, isMissingTable, NotFoundError, RedirectError } from "./lib/errors";
import { logError } from "./lib/log";
import { sha256Hex } from "./lib/tokens";
import type { AppBindings, User } from "./types";
import { render, setupResponse } from "./views/layout";
import { registerAdminRoutes } from "./routes/admin";
import { registerAuthRoutes } from "./routes/auth";
import { registerPlatformRoutes } from "./routes/platform";
import { registerPublicRoutes } from "./routes/public";
import { registerPaymentRoutes } from "./routes/payments";
import { registerResidentRoutes } from "./routes/resident";
import { redirectTo } from "./routes/common";

export function createApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.use("*", async (c, next) => {
    if (c.req.header("x-hoa-rewritten") !== "1") {
      const prepared = await prepareIncoming(c.req.raw, c.env);
      if (prepared instanceof Response) return prepared;
      if (prepared.headers.get("x-hoa-rewritten") === "1") return app.fetch(prepared, c.env);
    }

    if (isDemoWrite(c.req.method, c.req.path)) {
      return redirectTo(c, demoReturnPath(c.req.url, c.req.header("referer")), DEMO_WRITE_MESSAGE, "warn");
    }

    c.set("user", null);
    c.set("association", null);
    c.set("membership", null);
    c.set("flash", null);
    c.set("flashTone", "ok");
    c.set("demoRole", null);

    const flash = getCookie(c, "tango_flash");
    if (flash) {
      if (flash.startsWith("warn:")) {
        c.set("flashTone", "warn");
        c.set("flash", flash.slice(5));
      } else if (flash.startsWith("ok:")) {
        c.set("flash", flash.slice(3));
      } else {
        c.set("flash", flash);
      }
    }

    const sessionToken = getCookie(c, "tango_session");
    let sessionUser: User | null = null;
    if (sessionToken) {
      const found = await findSessionUser(c.env.DB, await sha256Hex(sessionToken), new Date().toISOString());
      if (found && !isDemoUserId(found.id)) sessionUser = found;
    }

    const slug = c.req.path.match(/^\/a\/([^/]+)/)?.[1];
    if (slug === DEMO_SLUG) {
      const association = await findAssociationBySlug(c.env.DB, DEMO_SLUG);
      if (association && isDemoAssociation(association)) {
        const role = demoRoleFromCookie(getCookie(c, DEMO_COOKIE));
        const user = await findUserById(c.env.DB, demoUserIdForRole(role));
        c.set("demoRole", role);
        c.set("association", association);
        c.set("user", user);
        if (user) c.set("membership", await findMembership(c.env.DB, association.id, user.id));
      }
    } else if (slug) {
      const association = await findAssociationBySlug(c.env.DB, slug);
      c.set("association", association);
      if (sessionUser) {
        c.set("user", sessionUser);
        if (association) c.set("membership", await findMembership(c.env.DB, association.id, sessionUser.id));
      }
    } else if (sessionUser) {
      c.set("user", sessionUser);
    }

    await next();
  });

  app.get("/health", (c) => c.json({ ok: true, service: "tango" }));

  registerPublicRoutes(app);
  registerAuthRoutes(app);
  registerResidentRoutes(app);
  registerAdminRoutes(app);
  registerPaymentRoutes(app);
  registerPlatformRoutes(app);

  app.notFound(async (c) => render(c, { title: "Not found", status: 404, body: "<section class=\"panel\"><h1>Page not found</h1></section>" }));

  app.onError(async (error, c) => {
    if (isMissingTable(error)) return setupResponse();
    if (error instanceof RedirectError) return c.redirect(error.location, 303);
    if (error instanceof NotFoundError) {
      return render(c, { title: "Not found", status: 404, body: "<section class=\"panel\"><h1>Not found</h1></section>" });
    }
    if (error instanceof ForbiddenError) {
      return render(c, {
        title: "Not available",
        status: 403,
        body: "<section class=\"panel\"><h1>Not available</h1><p>You do not have access to that page in this association.</p></section>",
      });
    }
    logError("unhandled", { message: error instanceof Error ? error.message : "unknown" });
    return render(c, {
      title: "Something went wrong",
      status: 500,
      body: "<section class=\"panel\"><h1>Something went wrong</h1><p>Please try again.</p></section>",
    });
  });

  return app;
}

async function prepareIncoming(request: Request, env: Env): Promise<Request | Response> {
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();
  if (isLegacyHost(host) && legacyRedirectEnabled(env)) {
    return Response.redirect(legacyRedirectTarget(request.url), 301);
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return request;
  const first = decodeURIComponent(parts[0] ?? "").toLowerCase();
  if (!isVanityCandidate(first)) return request;
  let association: { slug: string; vanity_slug?: string | null } | null = null;
  try {
    association = await findAssociationByVanity(env.DB, first);
  } catch {
    return request;
  }
  if (!association) return request;
  const rest = `/${parts.slice(1).join("/")}`;
  const pathname = vanityInternalPath(association, rest);
  if (!pathname || pathname === url.pathname) return request;
  return rewriteRequest(request, pathname, `/${vanityOf(association) || first}`);
}

function rewriteRequest(request: Request, pathname: string, publicBase: string): Request {
  const url = new URL(request.url);
  url.pathname = pathname;
  const headers = new Headers(request.headers);
  headers.set("x-hoa-rewritten", "1");
  headers.set("x-hoa-public-base", publicBase);
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }
  return new Request(url, init);
}
