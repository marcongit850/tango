import { applyDocumentResponseHeaders } from "./files";

/** Public read-only association. Ids match migrations/0016_seed_seaside_demo.sql. */
export const DEMO_SLUG = "seaside-demo";
export const DEMO_ASSOCIATION_ID = "assoc_seaside_demo";
export const DEMO_OWNER_USER_ID = "user_demo_owner";
export const DEMO_ADMIN_USER_ID = "user_demo_admin";
export const DEMO_NEIGHBOR_USER_ID = "user_demo_neighbor";
export const DEMO_COOKIE = "tango_demo";
export const DEMO_BANNER = "Demo site, sample data, read only";
export const DEMO_WRITE_MESSAGE = "Demo only, changes are not saved";

const DEMO_USER_IDS = new Set([DEMO_OWNER_USER_ID, DEMO_ADMIN_USER_ID, DEMO_NEIGHBOR_USER_ID]);

export type DemoRole = "owner" | "admin";

export function isDemoSlug(slug: string | null | undefined): boolean {
  return slug === DEMO_SLUG;
}

export function isDemoAssociationId(id: string | null | undefined): boolean {
  return id === DEMO_ASSOCIATION_ID;
}

export function isDemoAssociation(association: { id: string; slug: string } | null | undefined): boolean {
  return !!association && association.id === DEMO_ASSOCIATION_ID && association.slug === DEMO_SLUG;
}

export function isDemoUserId(userId: string | null | undefined): boolean {
  return !!userId && DEMO_USER_IDS.has(userId);
}

export function isDemoPath(path: string): boolean {
  const prefix = `/a/${DEMO_SLUG}`;
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function isDemoWrite(method: string, path: string): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  return isDemoPath(path);
}

export function demoRoleFromCookie(value: string | undefined): DemoRole {
  return value === "admin" ? "admin" : "owner";
}

export function demoUserIdForRole(role: DemoRole): string {
  return role === "admin" ? DEMO_ADMIN_USER_ID : DEMO_OWNER_USER_ID;
}

/** Same-origin demo page to return to after a blocked write. */
export function demoReturnPath(requestUrl: string, referer: string | undefined): string {
  const fallback = `/a/${DEMO_SLUG}/dashboard`;
  if (!referer) return fallback;
  let target: URL;
  let here: URL;
  try {
    target = new URL(referer);
    here = new URL(requestUrl);
  } catch {
    return fallback;
  }
  if (target.origin !== here.origin || !isDemoPath(target.pathname)) return fallback;
  return `${target.pathname}${target.search}`;
}

const DEMO_TEXT = "text/plain; charset=utf-8";

const DEMO_FILES: Record<string, { filename: string; body: string }> = {
  "seed/seaside-demo/covenants.txt": {
    filename: "seaside-demo-covenants-sample.txt",
    body: `SAMPLE PLACEHOLDER. NOT RECORDED COVENANTS

Seaside Demo HOA
18 Dune Lane, Sample Harbor, Florida

This file is sample content for the read-only demo.
It is not a document from any other association.

1. Lots
Lots in this sample association are for residential use.

2. Common dock
Keep the sample dock clear.

Residents always see the version the board marks current.
This text is not legal advice.
`,
  },
  "seed/seaside-demo/budget-2026.txt": {
    filename: "seaside-demo-2026-budget-sample.txt",
    body: `SAMPLE PLACEHOLDER. NOT AN ADOPTED BUDGET

Seaside Demo HOA 2026 budget sketch
Sample Harbor, Florida

Annual assessment (illustrative)    $900 per lot
Dock maintenance (illustrative)     board review

This document is marked board-only in the sample seed.
Owners do not see board-only files.
This text is not legal advice.
`,
  },
  "seed/seaside-demo/minutes-2026-10.txt": {
    filename: "seaside-demo-minutes-2026-10-sample.txt",
    body: `SAMPLE MINUTES. NOT A REAL MEETING RECORD

Seaside Demo HOA
October 2, 2026

The board reviewed the sample budget and the dock light request.
No vote in this file changes a balance. The demo does not save edits.

This text is not legal advice.
`,
  },
};

/** Static sample file. Demo downloads never read the document bucket. */
export function demoFileResponse(r2Key: string, download: boolean): Response | null {
  const file = DEMO_FILES[r2Key];
  if (!file) return null;
  const headers = new Headers();
  headers.set("Content-Type", DEMO_TEXT);
  applyDocumentResponseHeaders(headers, {
    filename: file.filename,
    contentType: DEMO_TEXT,
    download,
  });
  return new Response(file.body, { headers });
}
