import { formatAddress } from "../lib/dates";
import type { EstoppelFormValues } from "../lib/estoppel";
import { esc, paragraphs } from "../lib/html";
import type { Association } from "../types";

export type HomePortal = {
  dashboardHref: string;
  adminHref: string | null;
};

const PORTAL = "/a/tango-mar";

function homeIcon(kind: "megaphone" | "document" | "person" | "envelope"): string {
  const common = `viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"`;
  if (kind === "megaphone") {
    return `<svg ${common}><path d="M5 9.5v5h2.2L12 18V6L7.2 9.5H5z"/><path d="M15 9.5a3.2 3.2 0 0 1 0 5"/><path d="M17.2 7.2a6 6 0 0 1 0 9.6"/></svg>`;
  }
  if (kind === "document") {
    return `<svg ${common}><path d="M7 3.5h6.2L18 8.2V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/><path d="M13 3.5V8.5h5"/><path d="M9 12.5h6M9 16h6"/></svg>`;
  }
  if (kind === "person") {
    return `<svg ${common}><circle cx="12" cy="8" r="3"/><path d="M6 19.2c.8-3 2.9-4.5 6-4.5s5.2 1.5 6 4.5"/></svg>`;
  }
  return `<svg ${common}><rect x="3.5" y="6" width="17" height="12" rx="1.6"/><path d="M4 7.2 12 13l8-5.8"/></svg>`;
}

function homeCard(kind: "megaphone" | "document" | "person" | "envelope", title: string, text: string, href: string, label: string): string {
  return `<article class="home-card home-card-${kind}">
      <div class="home-icon">${homeIcon(kind)}</div>
      <h3>${title}</h3>
      <p>${text}</p>
      <a href="${href}">${label} <span aria-hidden="true">→</span></a>
    </article>`;
}

function homeBelow(): string {
  const cards = [
    homeCard(
      "megaphone",
      "COMMUNITY UPDATES",
      "Stay up to date on neighborhood announcements, meetings, projects, and important notices.",
      `${PORTAL}/news`,
      "View Updates",
    ),
    homeCard(
      "document",
      "DOCUMENTS &amp; FORMS",
      "Access covenants, bylaws, association records, forms, meeting documents, and other homeowner resources.",
      `${PORTAL}/documents`,
      "View Documents",
    ),
    homeCard(
      "person",
      "YOUR ACCOUNT",
      "View your property information, association account details, and available payment options.",
      `${PORTAL}/dashboard`,
      "Manage Account",
    ),
    homeCard(
      "envelope",
      "CONTACT THE ASSOCIATION",
      "Have a question or need assistance? Send a request directly through your homeowner portal.",
      `${PORTAL}/messages`,
      "Contact Us",
    ),
  ].join("");
  return `<section class="home-need" aria-labelledby="home-need-title">
      <div class="wrap">
        <h2 id="home-need-title">Everything You Need, All in One Place</h2>
        <span class="rule" aria-hidden="true"></span>
        <p class="home-lead">Whether you're looking for association documents, the latest neighborhood updates, account information, or a way to contact the association, the Tango Mar homeowner portal makes it easy to find what you need.</p>
        <div class="home-cards">${cards}</div>
      </div>
    </section>
    <section class="home-welcome" aria-labelledby="home-welcome-title">
      <div class="wrap home-welcome-inner">
        <div class="home-welcome-copy">
          <p class="home-kicker">Welcome Home</p>
          <h2 id="home-welcome-title">Tango Mar</h2>
          <p>This website serves as the central online resource for Tango Mar property owners, providing convenient access to association information, community documents, neighborhood updates, and homeowner resources.</p>
        </div>
        <div class="home-beach-frame">
          <img class="home-beach" src="/tango-mar-dunes.webp" alt="Sea oats and a dune fence above the gulf at Tango Mar" width="832" height="428">
        </div>
      </div>
    </section>`;
}

export function homePage(showDemo: boolean, portal: HomePortal | null = null): string {
  const demo = showDemo
    ? `<div class="wrap home-demo"><section class="devbox">
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
    ${homeBelow()}
    ${demo}`;
}

export function joinRequestPage(
  error = "",
  values: { name: string; email: string; address: string; note: string } = { name: "", email: "", address: "", note: "" },
): string {
  return `<section class="panel">
      <h1>Request to join</h1>
      <p>Please provide your information so the Association can verify your eligibility for portal access. Once reviewed, a board member or association representative will follow up by email. Submission of this form does not automatically create or approve an account.</p>
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

export function estoppelPage(
  association: Association,
  options: { error?: string; values?: EstoppelFormValues; sent?: boolean } = {},
): string {
  const values = options.values ?? {
    name: "",
    company: "",
    email: "",
    phone: "",
    property: "",
    owners: "",
    closingDate: "",
    notes: "",
  };
  const address = association.address_line1.trim() ? formatAddress(association) : "";
  const sent = options.sent
    ? `<p class="flash">Your request was sent.</p>`
    : "";
  const error = options.error ? `<p class="flash warn">${esc(options.error)}</p>` : "";
  return `<section class="panel">
      <h1>Estoppel Requests</h1>
      <p>Under Section 720.30851, Florida Statutes, the association designates the following to receive estoppel certificate requests:</p>
      <p>${esc(association.name)}<br>Attn: Board of Directors${address ? `<br>${esc(address)}` : ""}</p>
      <p>Requests may be mailed to the address above or submitted with the form below.</p>
      ${sent}
      ${error}
      <form class="fields" method="post" action="/a/${esc(association.slug)}/estoppel">
        <label class="hp">Website<input type="text" name="website" tabindex="-1" autocomplete="off"></label>
        <label>Your name<input type="text" name="name" autocomplete="name" maxlength="120" required value="${esc(values.name)}"></label>
        <label>Company, title company or law firm, optional<input type="text" name="company" maxlength="160" value="${esc(values.company)}"></label>
        <label>Email<input type="email" name="email" autocomplete="email" maxlength="200" required value="${esc(values.email)}"></label>
        <label>Phone<input type="tel" name="phone" autocomplete="tel" maxlength="40" required value="${esc(values.phone)}"></label>
        <label>Property address or lot number<input type="text" name="property" maxlength="200" required value="${esc(values.property)}"></label>
        <label>Owner name(s)<input type="text" name="owners" maxlength="200" required value="${esc(values.owners)}"></label>
        <label>Anticipated closing date, optional<input type="date" name="closing_date" value="${esc(values.closingDate)}"></label>
        <label>Notes, optional<textarea name="notes" maxlength="2000">${esc(values.notes)}</textarea></label>
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

export function emailChangeBlockedPage(): string {
  return `<section class="panel">
    <h1>Email not changed</h1>
    <p>That email is already used by another login. Your email was not changed.</p>
    <p><a class="button" href="/login">Sign in</a></p>
  </section>`;
}

export function invalidLinkPage(): string {
  return `<section class="panel">
    <h1>That link is not valid</h1>
    <p>It may have expired or already been used. Request a new one.</p>
    <p><a class="button" href="/login">Request a new link</a></p>
  </section>`;
}
