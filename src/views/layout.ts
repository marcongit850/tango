import { isStaff } from "../lib/access";
import { unreadCount } from "../db";
import { esc, htmlResponse, isHttps } from "../lib/html";
import type { AppBindings } from "../types";
import type { Context } from "hono";

type AppContext = Context<AppBindings>;

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
  font-family: "Segoe UI", system-ui, sans-serif;
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
button, .button {
  background: var(--gulf); color: white; border: 0; border-radius: 999px;
  padding: 0.5rem 0.95rem; font: inherit; cursor: pointer; text-decoration: none; display: inline-block;
}
button.secondary, .button.secondary { background: transparent; color: var(--gulf-dark); border: 1px solid var(--line); }
button.linkish { background: none; color: var(--gulf); padding: 0; border-radius: 0; }
main { padding-bottom: 2.5rem; }
.panel, .card {
  background: var(--paper); border: 1px solid var(--line); border-radius: 16px; box-shadow: var(--shadow); padding: 1rem 1.1rem;
}
.stack { display: grid; gap: 1rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; }
h1, h2, h3 { font-family: Georgia, "Iowan Old Style", Palatino, serif; font-weight: 600; letter-spacing: -0.02em; margin: 0 0 0.4rem; }
h1 { font-size: 2rem; }
.muted { color: var(--muted); }
.flash { padding: 0.75rem 1rem; border-radius: 12px; background: #e7f4ee; color: var(--ok); }
.flash.warn { background: #fff4e5; color: var(--warn); }
.emergency { background: var(--emergency); border: 1px solid #efc6c0; border-radius: 12px; padding: 0.8rem 1rem; }
.money { font-variant-numeric: tabular-nums; font-weight: 650; }
.money.owe { color: var(--late); }
.money.credit { color: var(--ok); }
.figure { font-size: 2rem; margin: 0.2rem 0; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 0.55rem 0.4rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 0.82rem; color: var(--muted); font-weight: 600; }
label { display: grid; gap: 0.3rem; font-size: 0.92rem; }
input, select, textarea {
  font: inherit; color: inherit; background: white; border: 1px solid var(--line); border-radius: 10px; padding: 0.5rem 0.65rem; width: 100%;
}
input[type="checkbox"] { width: auto; justify-self: start; }
textarea { min-height: 7rem; }
form.fields { display: grid; gap: 0.75rem; }
.actions { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
.badge { display: inline-block; border-radius: 999px; padding: 0.05rem 0.5rem; background: #e7eeed; color: var(--gulf-dark); font-size: 0.82rem; }
.badge.late { background: var(--emergency); color: var(--late); }
.devbox { border: 1px dashed var(--gulf); border-radius: 12px; padding: 0.8rem 1rem; background: #f3faf8; }
.site-footer { color: var(--muted); font-size: 0.92rem; padding: 0 0 2rem; }
.site-footer p { margin: 0.2rem 0; }
.split { display: grid; grid-template-columns: 1.4fr 0.8fr; gap: 1rem; }
@media (max-width: 800px) {
  .split { grid-template-columns: 1fr; }
  .account { margin-left: 0; }
  .brand img { height: 84px; }
  table { display: block; overflow-x: auto; }
}
`;

function shell(options: {
  title: string;
  brand: string;
  brandHref: string;
  nav: string;
  account: string;
  body: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${esc(options.title)}</title>
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
  <footer class="site-footer wrap">
    <p><strong>Not legal advice.</strong> ${esc(options.brand)} Neighborhood OS shows association records for residents and the board. It does not interpret covenants, and it is not a substitute for the board or a qualified attorney.</p>
    <p><a href="/legal">Read the disclaimer</a></p>
  </footer>
</body>
</html>`;
}

export function setupResponse(): Response {
  const body = shell({
    title: "Set up Tango Mar",
    brand: "Tango Mar",
    brandHref: "/",
    nav: `<a href="/">Home</a>`,
    account: "",
    body: `<section class="panel"><h1>Database not ready</h1><p>Apply the D1 migrations, then reload.</p><p><code>npm run db:migrate:local</code></p></section>`,
  });
  return htmlResponse(body, 503);
}

export async function render(
  c: AppContext,
  options: { title: string; active?: string; body: string; status?: number },
): Promise<Response> {
  const association = c.get("association");
  const user = c.get("user");
  const membership = c.get("membership");
  let unread = 0;
  if (association && user && membership && membership.status !== "inactive") {
    try {
      unread = await unreadCount(c.env.DB, association.id, user.id);
    } catch {
      unread = 0;
    }
  }

  const base = association ? `/a/${association.slug}` : "";
  const items: { id: string; href: string; label: string }[] = [];
  if (association && user && membership && membership.status !== "inactive") {
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
    if (isStaff(membership.role_id)) items.push({ id: "admin", href: `${base}/admin`, label: "Admin" });
  } else if (association) {
    items.push(
      { id: "home", href: base, label: "Neighborhood" },
      { id: "login", href: `${base}/login`, label: "Log in" },
    );
  } else {
    items.push(
      { id: "home", href: "/", label: "Home" },
      { id: "legal", href: "/legal", label: "Not legal advice" },
    );
  }

  const nav = items
    .map((item) => `<a class="${item.id === options.active ? "active" : ""}" href="${esc(item.href)}">${esc(item.label)}</a>`)
    .join("");
  const account =
    user && association
      ? `${esc(user.name || user.email)} <form method="post" action="/logout"><button class="linkish" type="submit">Log out</button></form>`
      : user
        ? `${esc(user.name || user.email)} <form method="post" action="/logout"><button class="linkish" type="submit">Log out</button></form>`
        : "";
  const flash = c.get("flash");
  const tone = c.get("flashTone");
  const flashHtml = flash ? `<div class="flash ${tone === "warn" ? "warn" : ""}">${esc(flash)}</div>` : "";
  const brand = association?.name || "Tango Mar";
  const body = shell({
    title: options.title,
    brand,
    brandHref: association ? `/a/${association.slug}` : "/",
    nav,
    account,
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
