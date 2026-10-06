import { formatAddress, formatPlace } from "../lib/dates";
import { esc, paragraphs } from "../lib/html";
import type { AnnouncementRow } from "../db";
import type { Association } from "../types";
import { dateTimeCell } from "./bits";

export function homePage(associations: Association[], showDemo: boolean): string {
  const cards = associations
    .map(
      (association) => `<article class="card">
        <h2>${esc(association.name)}</h2>
        <p>${esc(formatPlace(association))}</p>
        <p class="muted">${esc(formatAddress(association))}</p>
        <p><a class="button" href="/a/${esc(association.slug)}">Open portal</a></p>
      </article>`,
    )
    .join("");
  const demo = showDemo
    ? `<section class="devbox">
        <h2>Local demo roster</h2>
        <p>These people are fictional. Request a magic link, then use the link shown on the next screen when email is not configured.</p>
        <ul>
          <li><code>jordan.lee@example.com</code> — officer, Lot 3</li>
          <li><code>sam.rivera@example.com</code> — homeowner, Lot 14, paid</li>
          <li><code>casey.nguyen@example.com</code> — homeowner, Lot 27, past due</li>
        </ul>
      </section>`
    : "";
  return `<section class="panel">
      <p class="muted">Neighborhood OS</p>
      <h1>Owner portal for Tango Mar</h1>
      <p>Tango Mar is a beach neighborhood in Miramar Beach, Walton County, Florida. This portal is for a small association that still keeps its roster in Excel. One deployment can host many associations. Residents see their own dues. Other residents do not.</p>
      <p class="actions"><a class="button" href="/a/tango-mar">Enter Tango Mar</a> <a class="button secondary" href="/a/tango-mar/login">Resident log in</a></p>
    </section>
    ${cards ? `<section class="stack"><h2>Associations</h2><div class="grid">${cards}</div></section>` : ""}
    ${demo}`;
}

export function legalPage(): string {
  return `<section class="panel">
    <h1>Not legal advice</h1>
    ${paragraphs(`Tango Mar Neighborhood OS stores and shows records an association chooses to publish: rosters, assessments, recorded payments, documents, news, and private messages to the board.

It does not interpret covenants, decide violations, or replace the board. A later assistant that answers questions from an association's own documents will use this same limit: the answer is not legal advice, and the board still decides.

Demo covenant text shipped with the first association is a placeholder, not the recorded covenants of Tango Mar.`)}
  </section>`;
}

export function associationHome(association: Association, emergencies: AnnouncementRow[], signedIn: boolean): string {
  const alerts = emergencies
    .map(
      (item) => `<article class="emergency">
        <h2>${esc(item.title)}</h2>
        ${paragraphs(item.body)}
        <p class="muted">Posted ${dateTimeCell(item.published_at, association.timezone)}</p>
      </article>`,
    )
    .join("");
  return `<section class="panel">
      <p class="muted">${esc(association.legal_name)}</p>
      <h1>${esc(association.name)}</h1>
      <p>A beach neighborhood in Miramar Beach, Walton County, Florida.</p>
      <p>${esc(formatAddress(association))}</p>
      <p class="actions">
        ${signedIn ? `<a class="button" href="/a/${esc(association.slug)}/dashboard">Your dashboard</a>` : `<a class="button" href="/a/${esc(association.slug)}/login">Resident log in</a>`}
      </p>
      <p class="muted">News, documents, and dues are available after you sign in. Emergency notices stay on this page.</p>
    </section>
    ${alerts}`;
}

export function loginPage(association: Association, nextPath: string, error = ""): string {
  return `<section class="panel">
    <h1>Sign in to ${esc(association.name)}</h1>
    <p>Enter the email on the association roster. We will send a one-time link. There is no password.</p>
    ${error ? `<p class="flash warn">${esc(error)}</p>` : ""}
    <form class="fields" method="post" action="/a/${esc(association.slug)}/login">
      <input type="hidden" name="next" value="${esc(nextPath)}">
      <label>Email<input type="email" name="email" autocomplete="email" required></label>
      <button type="submit">Email me a link</button>
    </form>
  </section>`;
}

export function checkEmailPage(associationName: string, devLink: string | null): string {
  const dev = devLink
    ? `<div class="devbox"><p><strong>Local sign-in link.</strong> Outbound email is not configured, so the link is shown here instead of being sent.</p><p><a href="${esc(devLink)}">Continue sign-in</a></p></div>`
    : "";
  return `<section class="panel stack">
    <h1>Check your email</h1>
    <p>If that email is on the ${esc(associationName)} roster, a sign-in link is on its way. It expires in 20 minutes and works once.</p>
    ${dev}
  </section>`;
}

export function invalidLinkPage(slug: string): string {
  return `<section class="panel">
    <h1>That link is not valid</h1>
    <p>It may have expired or already been used. Request a new one.</p>
    <p><a class="button" href="/a/${esc(slug)}/login">Request a new link</a></p>
  </section>`;
}
