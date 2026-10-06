import type { Hono } from "hono";
import { listAssociations, visibleAnnouncements } from "../db";
import { safeNextPath } from "../lib/access";
import type { AppBindings } from "../types";
import { render } from "../views/layout";
import { associationHome, homePage, legalPage, loginPage } from "../views/public";
import { requireAssociation, type AppContext } from "./common";

function showDemo(c: AppContext): boolean {
  const host = new URL(c.req.url).hostname;
  return `${c.env.APP_ENV}` === "development" || host === "localhost" || host === "127.0.0.1";
}

export function registerPublicRoutes(app: Hono<AppBindings>): void {
  app.get("/", async (c) => {
    const associations = await listAssociations(c.env.DB);
    return render(c, { title: "Tango Mar", active: "home", body: homePage(associations, showDemo(c)) });
  });

  app.get("/legal", async (c) => render(c, { title: "Not legal advice", active: "legal", body: legalPage() }));

  app.get("/a/:slug", async (c) => {
    const association = requireAssociation(c);
    const emergencies = await visibleAnnouncements(c.env.DB, association.id, new Date().toISOString(), "emergency");
    const signedIn = Boolean(c.get("user") && c.get("membership") && c.get("membership")?.status !== "inactive");
    return render(c, {
      title: association.name,
      active: "home",
      body: associationHome(association, emergencies, signedIn),
    });
  });

  app.get("/a/:slug/login", async (c) => {
    const association = requireAssociation(c);
    const nextPath = safeNextPath(association.slug, c.req.query("next") ?? "");
    return render(c, { title: `Sign in · ${association.name}`, active: "login", body: loginPage(association, nextPath) });
  });
}
