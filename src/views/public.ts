import { esc, paragraphs } from "../lib/html";
import type { Association } from "../types";

export type HomePortal = {
  dashboardHref: string;
  adminHref: string | null;
};

export function homePage(showDemo: boolean, portal: HomePortal | null = null): string {
  const demo = showDemo
    ? `<div class="wrap"><section class="devbox">
        <h2>Local demo roster</h2>
        <p>These people are fictional. Request a magic link, then use the link shown on the next screen when email is not configured.</p>
        <ul>
          <li><code>jordan.lee@example.com</code>, board member with admin, Lot 3</li>
          <li><code>sam.rivera@example.com</code>, homeowner, Lot 14, paid</li>
          <li><code>casey.nguyen@example.com</code>, homeowner, Lot 27, past due</li>
        </ul>
      </section></div>`
    : "";
  return `<section class="shore">
      <img class="shore-photo" src="/tango-mar-boardwalk.png" alt="">
      <div class="shore-scrim" aria-hidden="true"></div>
      <div class="shore-inner">
        <div class="shore-copy">
          <img class="mark" src="/tango-mar-mark.png" alt="Tango Mar Property Owners Association" width="1143" height="789">
          <span class="rule" aria-hidden="true"></span>
          <h1>Welcome to Tango Mar</h1>
          <p class="place">A private beach neighborhood in Miramar Beach, Walton County, Florida.</p>
          <p class="blurb">Your neighborhood portal for association information, documents, announcements, account details, and community resources.</p>
          <p class="actions">
            ${
              portal
                ? `<a class="button" href="${esc(portal.dashboardHref)}">Open dashboard</a>${
                    portal.adminHref ? `<a class="button secondary" href="${esc(portal.adminHref)}">Admin</a>` : ""
                  }`
                : `<a class="button" href="/login">Resident login</a>
            <a class="button secondary" href="/join">Request access</a>`
            }
          </p>
        </div>
        <figure class="shore-video">
          <video controls playsinline preload="metadata" poster="/welcome-intro-poster.jpg" width="1080" height="1920" title="Welcome to the Tango Mar owner portal" aria-label="Welcome to the Tango Mar owner portal">
            <source src="/welcome-intro.mp4" type="video/mp4">
          </video>
        </figure>
      </div>
    </section>
    ${demo}`;
}

export function joinRequestPage(
  error = "",
  values: { name: string; email: string; address: string; note: string } = { name: "", email: "", address: "", note: "" },
): string {
  return `<section class="panel">
      <h1>Request to join</h1>
      <p>Tell the board who you are. They will follow up by email. Sending this form does not create a login.</p>
      ${error ? `<p class="flash warn">${esc(error)}</p>` : ""}
      <form class="fields" method="post" action="/join">
        <label class="hp">Company<input type="text" name="company" tabindex="-1" autocomplete="off"></label>
        <label>Name<input type="text" name="name" autocomplete="name" maxlength="120" required value="${esc(values.name)}"></label>
        <label>Email<input type="email" name="email" autocomplete="email" maxlength="200" required value="${esc(values.email)}"></label>
        <label>Address or lot, optional<input type="text" name="address" autocomplete="street-address" maxlength="200" value="${esc(values.address)}"></label>
        <label>Note, optional<textarea name="note" maxlength="2000">${esc(values.note)}</textarea></label>
        <button type="submit">Send request</button>
      </form>
    </section>`;
}

export function joinReceivedPage(): string {
  return `<section class="panel">
      <h1>Request received</h1>
      <p>Your message has been sent to the Board. A Board member will follow up with you by email.</p>
      <p>Submitting this form does not create a homeowner login or account.</p>
      <p><a class="button secondary" href="/">Back to home</a></p>
    </section>`;
}

export function legalPage(): string {
  return `<section class="panel">
    <h1>Not legal advice</h1>
    ${paragraphs(`Tango Mar Neighborhood OS stores and shows records an association chooses to publish: rosters, assessments, recorded payments, documents, news, and private messages to the board.

It does not interpret covenants, decide violations, or replace the board. A later assistant that answers questions from an association's own documents will use this same limit: the answer is not legal advice, and the board still decides.

Demo covenant text shipped with the first association is a placeholder, not the recorded covenants of Tango Mar.`)}
  </section>`;
}

export function loginPage(association: Association, nextPath: string, error = ""): string {
  return `<section class="panel">
    <h1>Sign in to ${esc(association.name)} Dashboard</h1>
    <p>Enter the email address associated with your association account. We'll send you a secure, one-time login link. No password required.</p>
    ${error ? `<p class="flash warn">${esc(error)}</p>` : ""}
    <form class="fields" method="post" action="/login">
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
    <p>If your email is on the ${esc(associationName)} roster, your secure sign-in link is on the way. The link expires in 20 minutes and can only be used once. After you sign in, you’ll stay logged in on this device for up to 30 days.</p>
    ${dev}
  </section>`;
}

export function invalidLinkPage(): string {
  return `<section class="panel">
    <h1>That link is not valid</h1>
    <p>It may have expired or already been used. Request a new one.</p>
    <p><a class="button" href="/login">Request a new link</a></p>
  </section>`;
}
