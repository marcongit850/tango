import { esc } from "../lib/html";
import type { ContactValues } from "../lib/contact";

export type ProductPageState = {
  code?: string;
  codeError?: string;
  contactError?: string;
  contactValues?: ContactValues;
  contactSent?: boolean;
  contactOpen?: boolean;
};

function feature(
  title: string,
  text: string,
): string {
  return `<article class="home-card">
      <h3>${title}</h3>
      <p>${text}</p>
    </article>`;
}

function contactForm(state: ProductPageState): string {
  const values = state.contactValues ?? { name: "", email: "", neighborhood: "", message: "" };
  const open = state.contactOpen || state.contactError ? " open" : "";
  const error = state.contactError ? `<p class="flash warn">${esc(state.contactError)}</p>` : "";
  const sent = state.contactSent ? `<p class="flash">Your message was sent.</p>` : "";
  return `<details class="contact-panel" id="contact"${open}>
      <summary class="button secondary">Contact</summary>
      <form class="fields" method="post" action="/contact">
        ${sent}
        ${error}
        <label class="hp">Website<input type="text" name="website" tabindex="-1" autocomplete="off"></label>
        <label>Name<input type="text" name="name" autocomplete="name" maxlength="120" required value="${esc(values.name)}"></label>
        <label>Email<input type="email" name="email" autocomplete="email" maxlength="200" required value="${esc(values.email)}"></label>
        <label>Association, optional<input type="text" name="neighborhood" maxlength="160" value="${esc(values.neighborhood)}"></label>
        <label>Message<textarea name="message" maxlength="2000" required>${esc(values.message)}</textarea></label>
        <button type="submit">Send message</button>
      </form>
    </details>`;
}

export function productPage(state: ProductPageState = {}): string {
  const code = state.code ?? "";
  const codeError = state.codeError ? `<p class="flash warn">${esc(state.codeError)}</p>` : "";
  const features = [
    feature(
      "Owner portal",
      "Owners sign in with an email link. The dashboard shows balances, invoices, recorded payments, lot details, and notices for the homes they own.",
    ),
    feature(
      "Documents",
      "Covenants, bylaws, minutes, budgets, insurance, and forms. Files can have versions and folders. Residents see the file the board marks current. A file can be board only.",
    ),
    feature(
      "Board notices",
      "The board posts notices in the portal. A notice can include a file, and the board can email that owner a short link.",
    ),
    feature(
      "Estoppel requests",
      "A public form for estoppel certificate requests. The page links the Florida statute and emails the request to the association.",
    ),
    feature(
      "Dues the board records",
      "The board records checks, cash, and ACH payments against invoices. Card numbers are not stored. Bank account numbers are not stored. The portal does not charge a card.",
    ),
    feature(
      "Electronic notice consent",
      "Owners choose announcement email and can agree to electronic notice. Each choice is saved in a consent log with the time and the login.",
    ),
    feature(
      "News and calendar",
      "Announcements, meetings, and events live in the portal. The board can email owners a short link when they post one.",
    ),
    feature(
      "Messages",
      "Owners write the board in private and can attach files. The board reads and replies from the same thread.",
    ),
  ].join("");
  return `<header class="product-header">
      <a class="product-logo" href="/"><img src="/brand/myhoadashboard-logo.png" alt="MyHOADashboard.com" width="960" height="263"></a>
      <nav aria-label="Product">
        <a href="#why">Why use us</a>
        <a href="#features">Features</a>
        <a href="/demo">See the demo</a>
      </nav>
    </header>
    <section class="product-hero">
      <div class="wrap">
        <p class="home-kicker">Homeowner portal</p>
        <h1>MyHOADashboard</h1>
        <span class="rule" aria-hidden="true"></span>
        <p class="home-lead">One place for association documents, board notices, and the owner ledger. Each neighborhood keeps its own records.</p>
        <form class="code-box" method="post" action="/neighborhood">
          <h2>Enter your neighborhood code</h2>
          ${codeError}
          <label for="neighborhood-code">Neighborhood code
            <input id="neighborhood-code" name="code" inputmode="numeric" autocomplete="off" maxlength="12" required value="${esc(code)}">
          </label>
          <button type="submit">Continue</button>
        </form>
        <p class="actions product-actions">
          <a class="button" href="/demo">See the demo</a>
        </p>
        ${contactForm(state)}
      </div>
    </section>
    <section id="why" class="product-section">
      <div class="wrap">
        <h2>Why use us</h2>
        <span class="rule" aria-hidden="true"></span>
        <ul class="why-list">
          <li>Owners and the board share one portal for documents, notices, and dues.</li>
          <li>Each association's roster, ledger, and files stay with that association.</li>
          <li>Sign in with an email link. There is no password to reset.</li>
          <li>Open the read only demo before you take it to your board.</li>
        </ul>
      </div>
    </section>
    <section id="features" class="product-section">
      <div class="wrap">
        <h2>Features</h2>
        <span class="rule" aria-hidden="true"></span>
        <p class="home-lead">These are the tools in the portal today.</p>
        <div class="home-cards product-features">${features}</div>
      </div>
    </section>
    <footer class="product-footer">
      <div class="wrap product-footer-inner">
        <a href="/">MyHOADashboard</a>
        <nav aria-label="Footer">
          <a href="/demo">See the demo</a>
          <a href="#contact">Contact</a>
          <a href="/privacy">Privacy Policy</a>
          <a href="/terms">Terms of Use</a>
        </nav>
      </div>
    </footer>`;
}

export function platformAssociationsPage(options: {
  rows: { id: string; name: string; slug: string; neighborhood_code: string; vanity_slug: string }[];
  error?: string;
  notice?: string;
  unavailable?: boolean;
}): string {
  const error = options.error ? `<p class="flash warn">${esc(options.error)}</p>` : "";
  const notice = options.notice ? `<p class="flash">${esc(options.notice)}</p>` : "";
  if (options.unavailable) {
    return `<section class="panel"><h1>Neighborhood codes</h1>
      <p>Apply the neighborhood code migration in D1, then reload. The steps are in ARCHITECTURE.md.</p>
    </section>`;
  }
  const rows = options.rows
    .map((row) => {
      return `<form class="fields platform-row" method="post" action="/platform/associations/${esc(row.id)}">
        <h2>${esc(row.name)}</h2>
        <p class="muted">Association slug ${esc(row.slug)}. This stays in the existing /a/${esc(row.slug)} links.</p>
        <label>Neighborhood code
          <input name="neighborhood_code" inputmode="numeric" maxlength="12" required value="${esc(row.neighborhood_code)}">
        </label>
        <label>Public slug
          <input name="vanity_slug" maxlength="40" required value="${esc(row.vanity_slug)}" autocapitalize="none" spellcheck="false">
        </label>
        <button type="submit">Save</button>
      </form>`;
    })
    .join("");
  return `<section class="panel stack">
      <h1>Neighborhood codes</h1>
      <p>Owners type the code on the MyHOADashboard home page. The public slug is the address, such as /tangomar.</p>
      ${notice}
      ${error}
      ${rows || `<p>No associations yet.</p>`}
    </section>`;
}
