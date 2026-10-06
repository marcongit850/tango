import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { findAssociationBySlug, findMembership, findSessionUser } from "./db";
import { ForbiddenError, isMissingTable, NotFoundError, RedirectError } from "./lib/errors";
import { logError } from "./lib/log";
import { sha256Hex } from "./lib/tokens";
import type { AppBindings } from "./types";
import { render, setupResponse } from "./views/layout";
import { registerAdminRoutes } from "./routes/admin";
import { registerAuthRoutes } from "./routes/auth";
import { registerPublicRoutes } from "./routes/public";
import { registerResidentRoutes } from "./routes/resident";

export function createApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.use("*", async (c, next) => {
    c.set("user", null);
    c.set("association", null);
    c.set("membership", null);
    c.set("flash", null);
    c.set("flashTone", "ok");

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
    if (sessionToken) {
      const user = await findSessionUser(c.env.DB, await sha256Hex(sessionToken), new Date().toISOString());
      c.set("user", user);
    }

    const slug = c.req.path.match(/^\/a\/([^/]+)/)?.[1];
    if (slug) {
      const association = await findAssociationBySlug(c.env.DB, slug);
      c.set("association", association);
      const user = c.get("user");
      if (association && user) {
        c.set("membership", await findMembership(c.env.DB, association.id, user.id));
      }
    }

    await next();
  });

  app.get("/favicon.ico", () => new Response(null, { status: 204 }));
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
