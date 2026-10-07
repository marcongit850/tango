import { isAdmin } from "../lib/access";
import { findAssociationBySlug, findMembership, unreadCount } from "../db";
import { esc, htmlResponse, isHttps } from "../lib/html";
import type { AppBindings, Association, Membership } from "../types";
import type { Context } from "hono";

type AppContext = Context<AppBindings>;

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=Instrument+Serif:ital@0;1&display=swap">`;

const STYLES = `
:root {
  --sand: #f4efe6;
  --paper: #fffdf8;
  --ink: #1b2830;
  --muted: #5d6c74;
  --line: #e4d9c8;
  --gulf: #0e5e5b;
  --gulf-dark: #0c3332;
  --late: #8d3428;
  --ok: #1d6b43;
  --warn: #8a5a12;
  --emergency: #f8e4e1;
  --shadow: 0 1px 0 rgba(28, 40, 48, 0.04);
  --sans: "DM Sans", "Segoe UI", system-ui, sans-serif;
  --serif: "Instrument Serif", Georgia, "Iowan Old Style", Palatino, serif;
  font-family: var(--sans);
  color: var(--ink);
  background: var(--sand);
}
* { box-sizing: border-box; }
body { margin: 0; line-height: 1.5; }
a { color: var(--gulf); }
.skip { position: absolute; left: -999px; }
.skip:focus { left: 1rem; top: 1rem; background: white; padding: 0.4rem 0.7rem; z-index: 2; }
.site-header, .site-footer, .wrap { width: min(1080px, calc(100% - 2rem)); margin: 0 auto; }
.site-header { display: flex; flex-wrap: wrap; gap: 0.75rem 1.5rem; align-items: center; padding: 1rem 0 0.75rem; }
.brand { display: block; line-height: 0; }
.brand img { display: block; height: 108px; width: auto; }
nav { display: flex; flex-wrap: wrap; gap: 0.35rem 0.9rem; }
nav a { text-decoration: none; color: var(--ink); padding-bottom: 0.15rem; }
nav a.active { color: var(--gulf); box-shadow: inset 0 -2px 0 var(--gulf); }
.account { margin-left: auto; color: var(--muted); display: flex; gap: 0.75rem; align-items: center; }
.account a.account-admin { text-decoration: none; color: var(--ink); padding-bottom: 0.15rem; }
.account a.account-admin.active { color: var(--gulf); box-shadow: inset 0 -2px 0 var(--gulf); }
button, .button {
  background: var(--gulf); color: white; border: 0; border-radius: 0;
  padding: 0.5rem 0.95rem; font: inherit; cursor: pointer; text-decoration: none; display: inline-block;
}
button.secondary, .button.secondary { background: transparent; color: var(--gulf-dark); border: 1px solid var(--line); }
button.linkish { background: none; color: var(--gulf); padding: 0; border-radius: 0; }
main { padding-bottom: 2.5rem; }
.panel, .card {
  background: var(--paper); border: 1px solid var(--line); border-radius: 0; box-shadow: var(--shadow); padding: 1rem 1.1rem;
}
.stack { display: grid; gap: 1rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; }
a.card { color: inherit; text-decoration: none; display: block; }
a.card:hover, a.card:focus { border-color: var(--gulf); }
details.faq > summary {
  cursor: pointer;
  font-family: var(--serif);
  font-weight: 400;
  letter-spacing: -0.02em;
  font-size: 1.5rem;
  line-height: 1.25;
}
details.faq > summary:focus-visible { outline: 2px solid var(--gulf); outline-offset: 3px; }
details.faq .faq-answer { margin-top: 0.75rem; }
details.faq .faq-answer > :first-child { margin-top: 0; }
details.faq .faq-answer > :last-child { margin-bottom: 0; }
h1, h2, h3 { font-family: var(--serif); font-weight: 400; letter-spacing: -0.02em; margin: 0 0 0.4rem; }
button, .button, nav, label, input, select, textarea, th { font-family: var(--sans); }
h1 { font-size: 2rem; }
.muted { color: var(--muted); }
.flash { padding: 0.75rem 1rem; border-radius: 0; background: #e7f4ee; color: var(--ok); }
.flash.warn { background: #fff4e5; color: var(--warn); }
.emergency { background: var(--emergency); border: 1px solid #efc6c0; border-radius: 0; padding: 0.8rem 1rem; }
.money { font-variant-numeric: tabular-nums; font-weight: 650; }
.money.owe { color: var(--late); }
.money.credit { color: var(--ok); }
.figure { font-size: 2rem; margin: 0.2rem 0; }
table { width: 100%; border-collapse: collapse; }
a.money-link { color: inherit; text-decoration: underline; text-underline-offset: 0.15em; }
a.money-link:hover { text-decoration-thickness: 2px; }
th, td { text-align: left; padding: 0.55rem 0.4rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 0.82rem; color: var(--muted); font-weight: 600; }
label { display: grid; gap: 0.3rem; font-size: 0.92rem; }
input, select, textarea {
  font: inherit; color: inherit; background: white; border: 1px solid var(--line); border-radius: 0; padding: 0.5rem 0.65rem; width: 100%;
}
input[type="checkbox"] { width: auto; justify-self: start; }
textarea { min-height: 7rem; }
form.fields { display: grid; gap: 0.75rem; }
.actions { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
.actions form { display: flex; align-items: center; margin: 0; }
.join-actions { flex-wrap: nowrap; }
.join-actions form { flex: 0 0 auto; }
.filters { display: flex; flex-wrap: wrap; gap: 0.15rem 0.9rem; margin: 0 0 0.75rem; font-size: 0.88rem; }
.filters a { color: var(--muted); text-decoration: none; padding-bottom: 0.1rem; }
.filters a.active { color: var(--gulf); box-shadow: inset 0 -2px 0 var(--gulf); }
.badge { display: inline-block; border-radius: 0; padding: 0.05rem 0.5rem; background: #e7eeed; color: var(--gulf-dark); font-size: 0.82rem; }
.badge.late { background: var(--emergency); color: var(--late); }
.devbox { border: 1px dashed var(--gulf); border-radius: 0; padding: 0.8rem 1rem; background: #f3faf8; }
body.landing { background: var(--sand); }
body.landing main { padding: 0 0 2.5rem; }
body.landing .shore + .wrap { padding-top: 1.5rem; }
.topbar {
  position: absolute;
  z-index: 3;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  justify-content: flex-end;
  padding: 0.75rem 1.1rem;
}
.topbar .account { margin-left: 0; color: #1a2744; flex-wrap: wrap; justify-content: flex-end; }
.topbar button.linkish { color: #1a2744; }
.topbar .button {
  background: #1c3558;
  color: white;
  border: 2px solid #1c3558;
  border-radius: 0;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 0.72rem;
  font-weight: 700;
  padding: 0.35rem 0.7rem;
}
.topbar .button.secondary { background: rgba(255, 255, 255, 0.92); color: #1c3558; }
.shore {
  position: relative;
  min-height: clamp(32rem, 68vh, 44rem);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  overflow: hidden;
  text-align: center;
  color: #1a2744;
  padding: 3.4rem 1.25rem 1.5rem;
}
.shore-photo {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center top;
}
.shore-scrim {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.22) 0%, rgba(255, 255, 255, 0.08) 28%, rgba(255, 255, 255, 0) 52%);
}
.shore-inner {
  position: relative;
  z-index: 1;
  width: min(68rem, calc(100% - 1.5rem));
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.35rem 1.5rem;
  padding: 1.15rem 1.2rem 1.25rem 1.35rem;
  border-radius: 0;
  background: rgba(255, 252, 246, 0.84);
  box-shadow: 0 10px 28px rgba(26, 39, 68, 0.1);
}
.shore-copy { min-width: 0; }
.shore-video { margin: 0; justify-self: end; }
.shore-video video {
  display: block;
  height: min(25rem, 60vh);
  width: auto;
  max-width: 100%;
  aspect-ratio: 9 / 16;
  object-fit: contain;
  background: #1a2744;
  border-radius: 0;
}
.shore-video video:focus-visible { outline: 2px solid var(--gulf); outline-offset: 3px; }
.mark { width: min(13.75rem, 70%); height: auto; display: block; margin: 0 auto 0; }
.rule { display: block; width: 3.4rem; height: 2px; margin: 0.45rem auto 0.55rem; background: #c6a15a; }
.shore h1 {
  color: #1a2744;
  font-size: clamp(1.85rem, 4vw, 2.55rem);
  font-weight: 400;
  margin: 0 0 0.3rem;
}
.shore .place { margin: 0 0 0.4rem; font-size: 1rem; }
.shore .blurb { max-width: 34rem; margin: 0 auto 0.85rem; font-size: 0.98rem; }
.shore .actions { justify-content: center; }
.shore .button {
  background: #1c3558;
  color: white;
  border: 2px solid #1c3558;
  border-radius: 0;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 0.78rem;
  font-weight: 700;
  padding: 0.7rem 1.15rem;
}
.shore .button.secondary { background: rgba(255, 255, 255, 0.9); color: #1c3558; }
.hp { position: absolute; left: -999px; width: 1px; height: 1px; overflow: hidden; }
.site-footer { color: var(--muted); font-size: 0.92rem; padding: 0 0 2rem; }
.site-footer p { margin: 0.2rem 0; }
.footer-links { display: flex; flex-wrap: wrap; gap: 0.2rem 1.15rem; }
.panel.legal {
  border-radius: 0;
  max-width: 42rem;
  padding: 1.35rem 1.4rem 1.6rem;
  line-height: 1.65;
}
.panel.legal h1 { margin-bottom: 0.15rem; }
.panel.legal .effective {
  margin: 0 0 1.2rem;
  padding-bottom: 0.95rem;
  border-bottom: 1px solid var(--line);
  line-height: 1.5;
}
.panel.legal h2 { font-size: 1.5rem; line-height: 1.25; margin: 1.45rem 0 0.4rem; }
.panel.legal p, .panel.legal ul { margin: 0 0 0.8rem; }
.panel.legal ul { padding-left: 1.2rem; }
.panel.legal li { margin: 0.22rem 0; }
.panel.legal > :last-child { margin-bottom: 0; }
.split { display: grid; grid-template-columns: 1.4fr 0.8fr; gap: 1rem; }
@media (max-width: 800px) {
  .split { grid-template-columns: 1fr; }
  .account { margin-left: 0; }
  .brand img { height: 84px; }
  table { display: block; overflow-x: auto; }
  .mark { width: min(12rem, 74%); }
  .shore { padding-top: 4.4rem; }
  .shore-inner { grid-template-columns: 1fr; width: min(40rem, 100%); justify-items: center; }
  .shore-video { justify-self: center; margin-top: 0.35rem; }
  .shore-video video { height: auto; width: min(15rem, 68vw); }
}
`;

const HOME_SLUG = "tango-mar";
const MEMBER_HEADER_PATHS = new Set(["/privacy", "/terms"]);

export function siteFooter(supportHref: string): string {
  const links = [
    supportHref ? `<a href="${esc(supportHref)}">Support</a>` : "",
    `<a href="/privacy">Privacy Policy</a>`,
    `<a href="/terms">Terms of Use</a>`,
  ].filter(Boolean);
  return `<footer class="site-footer wrap"><p class="footer-links">${links.join("")}</p></footer>`;
}

function memberSupportHref(slug: string, membership: { status?: string | null } | null | undefined): string {
  if (!membership || membership.status === "inactive") return "";
  return `/a/${slug}/support`;
}

function requestPath(c: AppContext): string {
  return new URL(c.req.url).pathname;
}

async function lookupHomeMembership(
  c: AppContext,
): Promise<{ association: Association; membership: Membership | null } | null> {
  const user = c.get("user");
  if (!user) return null;
  try {
    const association = await findAssociationBySlug(c.env.DB, HOME_SLUG);
    if (!association) return null;
    const membership = await findMembership(c.env.DB, association.id, user.id);
    return { association, membership };
  } catch {
    return null;
  }
}

function supportHrefFor(
  c: AppContext,
  home: { association: Association; membership: Membership | null } | null,
): string {
  if (!c.get("user")) return "";
  const association = c.get("association");
  if (association) return memberSupportHref(association.slug, c.get("membership"));
  return home ? memberSupportHref(home.association.slug, home.membership) : "";
}

function shell(options: {
  title: string;
  brandHref: string;
  nav: string;
  account: string;
  body: string;
  landing?: boolean;
  supportHref?: string;
}): string {
  if (options.landing) {
    const topbar = options.account ? `<div class="topbar"><div class="account">${options.account}</div></div>` : "";
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${esc(options.title)}</title>
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" href="/favicon.png" type="image/png">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  ${FONTS}
  <style>${STYLES}</style>
</head>
<body class="landing">
  <a class="skip" href="#content">Skip to content</a>
  ${topbar}
  <main id="content">${options.body}</main>
  ${siteFooter(options.supportHref ?? "")}
</body>
</html>`;
  }
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${esc(options.title)}</title>
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" href="/favicon.png" type="image/png">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  ${FONTS}
  <style>${STYLES}</style>
</head>
<body>
  <a class="skip" href="#content">Skip to content</a>
  <header class="site-header">
    <a class="brand" href="${esc(options.brandHref)}"><img src="/tango-mar-logo.png" alt="Tango Mar Property Owners Association" width="1536" height="1024"></a>
    <nav>${options.nav}</nav>
    <div class="account">${options.account}</div>
  </header>
  <main id="content" class="wrap stack">${options.body}</main>
  ${siteFooter(options.supportHref ?? "")}
</body>
</html>`;
}

export function setupResponse(): Response {
  const body = shell({
    title: "Set up Tango Mar",
    brandHref: "/",
    nav: `<a href="/">Home</a>`,
    account: "",
    body: `<section class="panel"><h1>Database not ready</h1><p>Apply the D1 migrations, then reload.</p><p><code>npm run db:migrate:local</code></p></section>`,
  });
  return htmlResponse(body, 503);
}

export function loggedOutNav(active?: string): { id: string; href: string; label: string }[] {
  const items: { id: string; href: string; label: string }[] = [];
  if (active !== "home" && active !== "join" && active !== "login") {
    items.push({ id: "home", href: "/", label: "Home" });
  }
  items.push(
    { id: "login", href: "/login", label: "Resident login" },
    { id: "join", href: "/join", label: "Request to join" },
  );
  return items;
}

export function landingAccount(name: string, portal: { dashboardHref: string; adminHref: string | null } | null): string {
  const enter = portal
    ? `<a class="button" href="${esc(portal.dashboardHref)}">Open dashboard</a>${
        portal.adminHref ? `<a class="button secondary" href="${esc(portal.adminHref)}">Admin</a>` : ""
      }`
    : "";
  return `${enter}${esc(name)} <form method="post" action="/logout"><button class="linkish" type="submit">Log out</button></form>`;
}

export async function render(
  c: AppContext,
  options: {
    title: string;
    active?: string;
    body: string;
    status?: number;
    portal?: { dashboardHref: string; adminHref: string | null } | null;
  },
): Promise<Response> {
  const user = c.get("user");
  const pathAssociation = c.get("association");
  const onPublicHome = !pathAssociation && options.active === "home";
  const home = !pathAssociation && user && !onPublicHome ? await lookupHomeMembership(c) : null;
  let association = pathAssociation;
  let membership = c.get("membership");
  if (
    !association &&
    home?.membership &&
    home.membership.status !== "inactive" &&
    MEMBER_HEADER_PATHS.has(requestPath(c))
  ) {
    association = home.association;
    membership = home.membership;
  }
  let unread = 0;
  if (association && user && membership && membership.status !== "inactive") {
    try {
      unread = await unreadCount(c.env.DB, association.id, user.id);
    } catch {
      unread = 0;
    }
  }

  const base = association ? `/a/${association.slug}` : "";
  const resident = Boolean(association && user && membership && membership.status !== "inactive");
  const items: { id: string; href: string; label: string }[] = [];
  if (resident) {
    items.push(
      { id: "dashboard", href: `${base}/dashboard`, label: "Dashboard" },
      { id: "documents", href: `${base}/documents`, label: "Documents" },
      { id: "news", href: `${base}/news`, label: "News" },
      { id: "calendar", href: `${base}/calendar`, label: "Calendar" },
      { id: "faq", href: `${base}/faq`, label: "FAQ" },
      { id: "board", href: `${base}/board`, label: "Board" },
      { id: "messages", href: `${base}/messages`, label: "Messages" },
      { id: "notices", href: `${base}/notices`, label: unread > 0 ? `Notices (${unread})` : "Notices" },
    );
  } else {
    items.push(...loggedOutNav(options.active));
  }

  const nav = items
    .map((item) => `<a class="${item.id === options.active ? "active" : ""}" href="${esc(item.href)}">${esc(item.label)}</a>`)
    .join("");
  const flash = c.get("flash");
  const tone = c.get("flashTone");
  const flashHtml = flash ? `<div class="flash ${tone === "warn" ? "warn" : ""}">${esc(flash)}</div>` : "";
  const adminLink =
    resident && isAdmin(membership)
      ? `<a class="account-admin${options.active === "admin" ? " active" : ""}" href="${esc(`${base}/admin`)}">Admin</a>`
      : "";
  const account = user
    ? onPublicHome
      ? landingAccount(user.name || user.email, options.portal ?? null)
      : `${adminLink}${esc(user.name || user.email)} <form method="post" action="/logout"><button class="linkish" type="submit">Log out</button></form>`
    : "";
  const supportHref = onPublicHome ? "" : supportHrefFor(c, home);
  const body = shell({
    title: options.title,
    brandHref: "/",
    nav: onPublicHome ? "" : nav,
    account,
    landing: onPublicHome,
    supportHref,
    body: `${flashHtml}${options.body}`,
  });
  const response = htmlResponse(body, options.status ?? 200);
  for (const cookie of c.res.headers.getSetCookie()) response.headers.append("Set-Cookie", cookie);
  if (flash) {
    const secure = isHttps(c.req.url) ? "; Secure" : "";
    response.headers.append("Set-Cookie", `tango_flash=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure}`);
  }
  return response;
}
