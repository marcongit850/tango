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

const SVG = `viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"`;

function glyph(paths: string): string {
  return `<svg ${SVG}>${paths}</svg>`;
}

const ICONS = {
  house: glyph(`<path d="M4 11.4 12 4.8l8 6.6"/><path d="M7 10.6V19h10v-8.4"/>`),
  shield: glyph(`<path d="M12 3.5 19 6.2v5.3c0 4.2-2.8 6.8-7 8.5-4.2-1.7-7-4.3-7-8.5V6.2L12 3.5z"/>`),
  mail: glyph(`<rect x="3.5" y="6" width="17" height="12" rx="1.6"/><path d="M4 7.2 12 13l8-5.8"/>`),
  eye: glyph(`<path d="M2.8 12S6.2 6.8 12 6.8 21.2 12 21.2 12 17.8 17.2 12 17.2 2.8 12 2.8 12z"/><circle cx="12" cy="12" r="2.4"/>`),
  person: glyph(`<circle cx="12" cy="8" r="3"/><path d="M6 19.2c.8-3 2.9-4.5 6-4.5s5.2 1.5 6 4.5"/>`),
  document: glyph(`<path d="M7 3.5h6.2L18 8.2V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/><path d="M13 3.5V8.5h5"/><path d="M9 12.5h6M9 16h6"/>`),
  megaphone: glyph(`<path d="M5 9.5v5h2.2L12 18V6L7.2 9.5H5z"/><path d="M15 9.5a3.2 3.2 0 0 1 0 5"/><path d="M17.2 7.2a6 6 0 0 1 0 9.6"/>`),
  clipboard: glyph(`<rect x="6.2" y="4.2" width="11.6" height="15.6" rx="1.4"/><path d="M9 4.2h6V6.6H9zM9 11h6M9 14.4h4"/>`),
  ledger: glyph(`<path d="M6 4.2h12a1 1 0 0 1 1 1V19l-2.4-1.4L14 19l-2-1.4L10 19l-2.4-1.4L5 19V5.2a1 1 0 0 1 1-1z"/><path d="M8.2 8.5h7.6M8.2 12h7.6M8.2 15.5h4.2"/>`),
  check: glyph(`<circle cx="12" cy="12" r="8"/><path d="M8.4 12.2 10.9 14.6 15.6 9.6"/>`),
  calendar: glyph(`<rect x="4" y="5.5" width="16" height="14" rx="1.6"/><path d="M4 10h16M8 3.8v3.4M16 3.8v3.4"/>`),
  chat: glyph(`<path d="M5 6.5h14a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 19 16.5H9.2L5 19.2v-2.7A1.5 1.5 0 0 1 3.5 15V8A1.5 1.5 0 0 1 5 6.5z"/>`),
  keypad: glyph(`<rect x="4" y="3.5" width="16" height="17" rx="2"/><path d="M9 3.5v17M15 3.5v17M4 9h16M4 14.5h16"/>`),
};

const TONES = ["blue", "green", "peach", "lilac"] as const;

function iconBadge(name: keyof typeof ICONS, tone: (typeof TONES)[number]): string {
  return `<div class="product-icon product-icon-${tone}">${ICONS[name]}</div>`;
}

function feature(title: string, text: string, name: keyof typeof ICONS, tone: (typeof TONES)[number]): string {
  return `<article class="product-card">
      ${iconBadge(name, tone)}
      <h3>${title}</h3>
      <p>${text}</p>
      <a href="/demo">See the demo <span aria-hidden="true">→</span></a>
    </article>`;
}

function whyItem(title: string, text: string, name: keyof typeof ICONS, tone: (typeof TONES)[number]): string {
  return `<li>
      ${iconBadge(name, tone)}
      <h3>${title}</h3>
      <p>${text}</p>
    </li>`;
}

function step(n: string, title: string, text: string, tone: (typeof TONES)[number]): string {
  return `<li>
      <span class="product-step product-icon-${tone}">${n}</span>
      <h3>${title}</h3>
      <p>${text}</p>
    </li>`;
}

function contactForm(state: ProductPageState): string {
  const values = state.contactValues ?? { name: "", email: "", neighborhood: "", message: "" };
  const open = state.contactOpen || state.contactError ? " open" : "";
  const error = state.contactError ? `<p class="flash warn">${esc(state.contactError)}</p>` : "";
  const sent = state.contactSent ? `<p class="flash">Your message was sent.</p>` : "";
  return `<details class="contact-panel" id="contact"${open}>
      <summary>Contact</summary>
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
      "person",
      "blue",
    ),
    feature(
      "Documents",
      "Covenants, bylaws, minutes, budgets, insurance, and forms. Files can have versions and folders. Residents see the file the board marks current. A file can be board only.",
      "document",
      "green",
    ),
    feature(
      "Board notices",
      "The board posts notices in the portal. A notice can include a file, and the board can email that owner a short link.",
      "megaphone",
      "peach",
    ),
    feature(
      "Estoppel requests",
      "A public form for estoppel certificate requests. The page links the Florida statute and emails the request to the association.",
      "clipboard",
      "lilac",
    ),
    feature(
      "Dues the board records",
      "The board records checks, cash, and ACH payments against invoices. Card numbers are not stored. Bank account numbers are not stored. The portal does not charge a card.",
      "ledger",
      "blue",
    ),
    feature(
      "Electronic notice consent",
      "Owners choose announcement email and can agree to electronic notice. Each choice is saved in a consent log with the time and the login.",
      "check",
      "green",
    ),
    feature(
      "News and calendar",
      "Announcements, meetings, and events live in the portal. The board can email owners a short link when they post one.",
      "calendar",
      "peach",
    ),
    feature(
      "Messages",
      "Owners write the board in private and can attach files. The board reads and replies from the same thread.",
      "chat",
      "lilac",
    ),
  ].join("");
  return `<header class="product-header">
      <div class="product-header-inner">
        <a class="product-wordmark" href="/">MyHOADashboard</a>
        <nav aria-label="Product">
          <a href="#why">Why use us</a>
          <a href="#how">How it works</a>
          <a href="#features">Features</a>
          <a href="/demo">See the demo</a>
        </nav>
      </div>
    </header>
    <section class="product-hero">
      <div class="wrap">
        <a class="product-logo" href="/"><img src="/brand/myhoadashboard-logo.png" alt="MyHOADashboard.com" width="960" height="263"></a>
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
          <div class="code-actions">
            <button type="submit">Continue</button>
            <a class="button secondary" href="/demo">See the demo</a>
          </div>
        </form>
        ${contactForm(state)}
      </div>
    </section>
    <section id="how" class="product-section">
      <div class="wrap">
        <h2>How it works</h2>
        <span class="rule" aria-hidden="true"></span>
        <p class="home-lead">From the code your association gave you to the records for that neighborhood.</p>
        <ol class="product-steps">
          ${step("1", "Enter code", "Type the neighborhood code your association gave you.", "blue")}
          ${step("2", "Sign in", "Open the link in your email. There is no password to reset.", "green")}
          ${step("3", "Manage your HOA", "Documents, notices, and the owner ledger for that neighborhood are in one portal.", "peach")}
        </ol>
      </div>
    </section>
    <section id="why" class="product-section">
      <div class="wrap">
        <h2>Why use us</h2>
        <span class="rule" aria-hidden="true"></span>
        <ul class="why-list">
          ${whyItem("One portal", "Owners and the board share one portal for documents, notices, and dues.", "house", "blue")}
          ${whyItem("Separate records", "Each association's roster, ledger, and files stay with that association.", "shield", "green")}
          ${whyItem("Email link", "Sign in with an email link. There is no password to reset.", "mail", "peach")}
          ${whyItem("Read only demo", "Open the read only demo before you take it to your board.", "eye", "lilac")}
        </ul>
      </div>
    </section>
    <section id="features" class="product-section">
      <div class="wrap">
        <h2>Features</h2>
        <span class="rule" aria-hidden="true"></span>
        <p class="home-lead">These are the tools in the portal today.</p>
        <div class="product-cards">${features}</div>
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
