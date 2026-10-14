import type { Hono } from "hono";
import { findAssociationById, listAssociations, neighborhoodColumnsReady, updateAssociationRouting, writeAudit } from "../db";
import { isUniqueConstraint } from "../lib/errors";
import { isPlatformAdmin } from "../lib/hosts";
import { neighborhoodCodeError, normalizeNeighborhoodCode, normalizeVanitySlug, vanitySlugError } from "../lib/neighborhood";
import type { AppBindings } from "../types";
import { platformAssociationsPage } from "../views/product";
import { render } from "../views/layout";
import { readForm, redirectTo, textValue, type AppContext } from "./common";

export function registerPlatformRoutes(app: Hono<AppBindings>): void {
  app.get("/platform/associations", async (c) => renderPlatform(c));

  app.post("/platform/associations/:id", async (c) => {
    const user = c.get("user");
    if (!user) return redirectTo(c, "/login?next=/platform/associations", "Sign in as a platform admin.", "warn");
    if (!isPlatformAdmin(c.env, user)) {
      return render(c, {
        title: "Not available",
        status: 403,
        icon: "product",
        body: `<section class="panel"><h1>Not available</h1><p>A platform admin has to open this page.</p></section>`,
      });
    }
    if (!(await neighborhoodColumnsReady(c.env.DB))) {
      return render(c, {
        title: "Neighborhood codes",
        icon: "product",
        status: 503,
        body: platformAssociationsPage({ rows: [], unavailable: true }),
      });
    }
    const fields = await readForm(c);
    const codeRaw = textValue(fields, "neighborhood_code", 12);
    const slugRaw = textValue(fields, "vanity_slug", 40);
    const codeError = neighborhoodCodeError(codeRaw);
    const slugError = vanitySlugError(slugRaw);
    const association = await findAssociationById(c.env.DB, c.req.param("id"));
    if (!association) {
      return renderPlatform(c, "That association was not found.", 404);
    }
    if (codeError || slugError) {
      return renderPlatform(c, codeError || slugError, 400);
    }
    const code = normalizeNeighborhoodCode(codeRaw);
    const slug = normalizeVanitySlug(slugRaw);
    if (!code || !slug) return renderPlatform(c, "Check the neighborhood code and the public slug.", 400);
    try {
      const changes = await updateAssociationRouting(c.env.DB, association.id, code, slug);
      if (changes === 0) return renderPlatform(c, "That association was not found.", 404);
    } catch (error) {
      if (isUniqueConstraint(error)) {
        return renderPlatform(c, "That neighborhood code or public slug is already used.", 409);
      }
      throw error;
    }
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "routing_update",
      entityType: "association",
      entityId: association.id,
      detail: `code ${code}, slug ${slug}`,
    });
    return redirectTo(c, "/platform/associations", "Neighborhood code saved.");
  });
}

async function renderPlatform(c: AppContext, error = "", status = 200): Promise<Response> {
  const user = c.get("user");
  if (!user) {
    return render(c, {
      title: "Neighborhood codes",
      icon: "product",
      status: user ? status : 401,
      body: `<section class="panel"><h1>Neighborhood codes</h1><p>Sign in as a platform admin, then open this page again.</p><p><a class="button" href="/login?next=/platform/associations">Sign in</a></p></section>`,
    });
  }
  if (!isPlatformAdmin(c.env, user)) {
    return render(c, {
      title: "Not available",
      status: 403,
      icon: "product",
      body: `<section class="panel"><h1>Not available</h1><p>A platform admin has to open this page.</p></section>`,
    });
  }
  if (!(await neighborhoodColumnsReady(c.env.DB))) {
    return render(c, {
      title: "Neighborhood codes",
      icon: "product",
      status: 503,
      body: platformAssociationsPage({ rows: [], unavailable: true }),
    });
  }
  const rows = await listAssociations(c.env.DB);
  return render(c, {
    title: "Neighborhood codes",
    icon: "product",
    status,
    body: platformAssociationsPage({
      rows: rows.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        neighborhood_code: row.neighborhood_code ?? "",
        vanity_slug: row.vanity_slug ?? "",
      })),
      error,
    }),
  });
}
