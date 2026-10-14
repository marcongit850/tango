import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { findAssociationBySlug, findMembership, findSessionUser, findUserById } from "./db";
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
import { registerPublicRoutes } from "./routes/public";
import { registerResidentRoutes } from "./routes/resident";
import { redirectTo } from "./routes/common";

export function createApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.use("*", async (c, next) => {
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
