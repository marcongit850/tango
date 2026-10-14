import { safeNextPath } from "./access";

/** Apex product host. Email links and neighborhood redirects use this origin. */
export const PRODUCT_ORIGIN = "https://myhoadashboard.com";

const PRODUCT_HOSTS = new Set(["myhoadashboard.com", "www.myhoadashboard.com"]);
const LEGACY_HOSTS = new Set(["mytangomar.com", "www.mytangomar.com"]);

/** First path segments that are not an association public address. */
export const RESERVED_SLUGS = new Set([
  "a",
  "admin",
  "assets",
  "auth",
  "brand",
  "bring-this-to-your-hoa",
  "contact",
  "demo",
  "favicon.ico",
  "health",
  "join",
  "legal",
  "login",
  "logout",
  "neighborhood",
  "platform",
  "privacy",
  "public",
  "robots.txt",
  "terms",
  "www",
]);

const TANGO_SLUG = "tango-mar";
const TANGO_VANITY = "tangomar";
const LEGACY_ORIGIN = "https://mytangomar.com";

export function isProductHost(hostname: string): boolean {
  return PRODUCT_HOSTS.has(hostname.toLowerCase());
}

export function isLegacyHost(hostname: string): boolean {
  return LEGACY_HOSTS.has(hostname.toLowerCase());
}

export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1";
}

/** On when wrangler sets LEGACY_HOST_REDIRECT to 1, true, on, or yes. */
export function legacyRedirectEnabled(env: Env): boolean {
  const value = `${(env as Env & { LEGACY_HOST_REDIRECT?: string }).LEGACY_HOST_REDIRECT ?? ""}`.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "yes";
}

export function platformAdminEmails(env: Env): Set<string> {
  const raw = `${(env as Env & { PLATFORM_ADMIN_EMAILS?: string }).PLATFORM_ADMIN_EMAILS ?? "marc@whpinc.com"}`;
  return new Set(
    raw
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isPlatformAdmin(env: Env, user: { email: string } | null | undefined): boolean {
  if (!user) return false;
  return platformAdminEmails(env).has(user.email.trim().toLowerCase());
}

export function vanityOf(association: { vanity_slug?: string | null }): string {
  return (association.vanity_slug ?? "").trim().toLowerCase();
}

/** Public path on this Worker, preferring /tangomar over /a/tango-mar when a vanity slug is set. */
export function associationPublicPath(association: { slug: string; vanity_slug?: string | null }, suffix = ""): string {
  const vanity = vanityOf(association);
  const path = suffix === "/" ? "" : suffix;
  if (vanity) return path ? `/${vanity}${path}` : `/${vanity}`;
  return path ? `/a/${association.slug}${path}` : `/a/${association.slug}`;
}

/**
 * Absolute URL for emails. Uses https://myhoadashboard.com/<vanity> when the association has a public address.
 * Tang-O-Mar keeps mytangomar.com paths until that address is stored.
 */
export function canonicalPortalUrl(association: { slug: string; vanity_slug?: string | null }, suffix: string): string {
  const { path, query } = splitSuffix(suffix);
  const vanity = vanityOf(association);
  if (vanity) {
    const pathname = path === "/" ? `/${vanity}` : `/${vanity}${path}`;
    return `${PRODUCT_ORIGIN}${pathname}${query}`;
  }
  if (association.slug === TANGO_SLUG) return `${LEGACY_ORIGIN}${legacyTangoPath(path)}${query}`;
  const pathname = path === "/" ? `/a/${association.slug}` : `/a/${association.slug}${path}`;
  return `${PRODUCT_ORIGIN}${pathname}${query}`;
}

/** Base used in email links, or null when the association has no vanity slug yet. */
export function associationCanonicalBase(association: { slug: string; vanity_slug?: string | null }): string | null {
  const vanity = vanityOf(association);
  return vanity ? `${PRODUCT_ORIGIN}/${vanity}` : null;
}

/**
 * Link to put in an email or on the dev sign-in page.
 * Localhost keeps the local origin so a printed link still opens. Every other host uses the canonical URL.
 */
export function portalUrl(requestUrl: string, association: { slug: string; vanity_slug?: string | null }, suffix: string): string {
  const request = new URL(requestUrl);
  if (!isLocalHost(request.hostname)) return canonicalPortalUrl(association, suffix);
  const { path, query } = splitSuffix(suffix);
  const vanity = vanityOf(association);
  if (vanity) {
    const pathname = path === "/" ? `/${vanity}` : `/${vanity}${path}`;
    return `${request.origin}${pathname}${query}`;
  }
  if (association.slug === TANGO_SLUG) return `${request.origin}${legacyTangoPath(path)}${query}`;
  const pathname = path === "/" ? `/a/${association.slug}` : `/a/${association.slug}${path}`;
  return `${request.origin}${pathname}${query}`;
}

/** Where a neighborhood code sends the browser. Stays on the current host for local and product hosts. */
export function neighborhoodDestination(requestUrl: string, vanity: string): string {
  const url = new URL(requestUrl);
  const host = url.hostname.toLowerCase();
  if (isLocalHost(host) || isProductHost(host)) {
    url.pathname = `/${vanity}`;
    url.search = "";
    url.hash = "";
    return url.toString();
  }
  return `${PRODUCT_ORIGIN}/${vanity}`;
}

/** 301 target for mytangomar.com. Path and query are kept, under /tangomar when they belong to that association. */
export function legacyRedirectTarget(requestUrl: string): string {
  const url = new URL(requestUrl);
  return `${PRODUCT_ORIGIN}${mapLegacyPath(url.pathname)}${url.search}`;
}

export function mapLegacyPath(pathname: string): string {
  const path = pathname && pathname.startsWith("/") ? pathname : `/${pathname || ""}`;
  if (path === "/demo" || path.startsWith("/demo/")) return path;
  if (path === "/bring-this-to-your-hoa" || path.startsWith("/bring-this-to-your-hoa/")) return path;
  if (path === "/health") return path;
  if (path === "/privacy" || path === "/terms" || path === "/legal") return path;
  if (path === "/") return `/${TANGO_VANITY}`;
  if (path === "/login") return `/${TANGO_VANITY}/login`;
  if (path === "/a/tango-mar") return `/${TANGO_VANITY}`;
  if (path.startsWith("/a/tango-mar/")) return `/${TANGO_VANITY}${path.slice("/a/tango-mar".length)}`;
  if (path.startsWith("/a/")) return path;
  return `/${TANGO_VANITY}${path}`;
}

export function isVanityCandidate(segment: string): boolean {
  const slug = segment.trim().toLowerCase();
  if (!slug || slug.includes(".")) return false;
  if (RESERVED_SLUGS.has(slug)) return false;
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(slug);
}

/** Rewrite /tangomar/dashboard to the existing /a/tango-mar/dashboard route. */
export function vanityInternalPath(association: { slug: string; vanity_slug?: string | null }, rest: string): string | null {
  if (rest === "/login" || rest.startsWith("/join")) return null;
  if (rest.startsWith("/auth/")) return rest;
  return `/a/${association.slug}${rest}`;
}

/** Turn a posted next path into a safe in-app path. Vanity paths become /a/<slug>/... */
export function loginNextPath(association: { slug: string; vanity_slug?: string | null }, raw: string): string {
  const vanity = vanityOf(association);
  let value = raw.trim();
  if (vanity && (value === `/${vanity}` || value.startsWith(`/${vanity}/`))) {
    const rest = value.slice(vanity.length + 1);
    value = !rest || rest === "/" ? `/a/${association.slug}/dashboard` : `/a/${association.slug}${rest}`;
  }
  if (value === "/platform/associations") return value;
  return safeNextPath(association.slug, value);
}

export function publicizePath(internalPath: string, association: { slug: string; vanity_slug?: string | null }, publicBase: string | null): string {
  if (!publicBase) return internalPath;
  const prefix = `/a/${association.slug}`;
  if (internalPath === prefix) return publicBase;
  if (internalPath.startsWith(`${prefix}/`)) return `${publicBase}${internalPath.slice(prefix.length)}`;
  return internalPath;
}

function legacyTangoPath(path: string): string {
  if (path === "/") return "";
  if (path === "/login" || path.startsWith("/auth/") || path.startsWith("/join")) return path;
  return `/a/${TANGO_SLUG}${path}`;
}

function splitSuffix(suffix: string): { path: string; query: string } {
  const value = suffix.startsWith("/") || suffix.startsWith("?") ? suffix : `/${suffix}`;
  const cut = value.indexOf("?");
  if (cut === -1) return { path: value || "/", query: "" };
  const path = value.slice(0, cut) || "/";
  return { path, query: value.slice(cut) };
}
