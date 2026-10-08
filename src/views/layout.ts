import { canViewAdmin } from "../lib/access";
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
body { margin: 0; line-height: 1.5; background: var(--sand); }
a { color: var(--gulf); }
.skip { position: absolute; left: -999px; }
.skip:focus { left: 1rem; top: 1rem; background: white; padding: 0.4rem 0.7rem; z-index: 2; }
.site-header, .wrap { width: min(1080px, calc(100% - 2rem)); margin: 0 auto; }
.site-header { display: flex; flex-wrap: wrap; gap: 0.75rem 1.5rem; align-items: center; padding: 1rem 0 0.75rem; }
.brand { display: block; line-height: 0; }
.brand img { display: block; height: 108px; width: auto; }
nav { display: flex; flex-wrap: wrap; gap: 0.35rem 0.9rem; }
nav a { text-decoration: none; color: var(--ink); padding-bottom: 0.15rem; }
nav a.active { color: var(--gulf); box-shadow: inset 0 -2px 0 var(--gulf); }
.account { margin-left: auto; color: var(--muted); display: flex; gap: 0.75rem; align-items: center; }
.site-header .account { padding-right: 1rem; }
.account a.account-admin { text-decoration: none; color: var(--ink); padding-bottom: 0.15rem; }
.account a.account-admin.active { color: var(--gulf); box-shadow: inset 0 -2px 0 var(--gulf); }
.account a.account-name { color: inherit; text-underline-offset: 0.15em; }
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
.dues-help { margin: 0 0 1rem; padding-left: 1.15rem; }
.dues-help li { margin: 0.4rem 0; }
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
.doc-folders { display: grid; gap: 0.5rem; }
.doc-folder { border: 1px solid var(--line); background: #fff; }
.doc-folder > summary {
  list-style: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.65rem 0.75rem;
  font-weight: 650;
}
.doc-folder > summary::-webkit-details-marker { display: none; }
.doc-folder > summary::marker { content: ""; }
.doc-folder > summary:focus-visible { outline: 2px solid var(--gulf); outline-offset: -2px; }
.doc-chevron {
  width: 0.42rem;
  height: 0.42rem;
  border-right: 2px solid var(--gulf-dark);
  border-bottom: 2px solid var(--gulf-dark);
  transform: rotate(-45deg);
  margin-left: 0.1rem;
  flex: 0 0 auto;
}
.doc-folder[open] > summary > .doc-chevron { transform: rotate(45deg); }
.doc-folder-name { min-width: 0; }
.doc-count {
  margin-left: auto;
  color: var(--muted);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  font-size: 0.82rem;
}
.doc-folder-body { padding: 0 0.75rem 0.35rem 1.85rem; }
.doc-folder-body > table { margin: 0 0 0.35rem; }
.doc-subfolder { margin: 0 0 0.5rem; background: var(--paper); }
.doc-folder-body > .muted { margin-top: 0; }
label { display: grid; gap: 0.3rem; font-size: 0.92rem; }
input, select, textarea {
  font: inherit; color: inherit; background: white; border: 1px solid var(--line); border-radius: 0; padding: 0.5rem 0.65rem; width: 100%;
}
input[type="checkbox"] { width: auto; justify-self: start; }
textarea { min-height: 7rem; }
form.fields { display: grid; gap: 0.75rem; }
.mailing-edit { margin-top: 0.75rem; }
.mailing-edit > summary {
  display: inline-block;
  width: auto;
  list-style: none;
  cursor: pointer;
}
.mailing-edit > summary::-webkit-details-marker { display: none; }
.mailing-edit > summary::marker { content: ""; }
.mailing-edit > summary:focus-visible { outline: 2px solid var(--gulf); outline-offset: 3px; }
.mailing-edit > form { margin-top: 0.85rem; max-width: 32rem; }
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
body.landing { background: #f7f4ef; }
body.landing main { padding: 0; }
body.landing .shore + .wrap { padding-top: 1.5rem; }
.home-need, .home-welcome { background: #f7f4ef; color: #1a2744; }
.home-need { padding: 3.25rem 0 1.25rem; text-align: center; }
.home-need h2 {
  font-size: clamp(2rem, 4.2vw, 2.75rem);
  color: #1a2744;
  margin: 0;
}
.home-need .rule { margin: 0.85rem auto 1rem; }
.home-lead {
  max-width: 44rem;
  margin: 0 auto 2rem;
  color: #4a5963;
  font-size: 1.02rem;
}
.home-cards {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1.15rem;
  text-align: center;
}
.home-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  background: #fff;
  border-radius: 0.85rem;
  padding: 1.85rem 1.35rem 1.6rem;
  box-shadow: 0 8px 22px rgba(28, 40, 48, 0.07);
}
.home-icon {
  width: 4.5rem;
  height: 4.5rem;
  border-radius: 50%;
  display: grid;
  place-items: center;
  margin: 0 auto 1.05rem;
  color: #1c3558;
}
.home-icon svg { width: 2rem; height: 2rem; display: block; }
.home-card-megaphone .home-icon { background: #d7e7f8; }
.home-card-document .home-icon { background: #dff3e4; }
.home-card-person .home-icon { background: #f8ead9; }
.home-card-envelope .home-icon { background: #d9e8f6; }
.home-card h3 {
  font-family: var(--sans);
  font-weight: 700;
  letter-spacing: 0.03em;
  font-size: 1.125rem;
  line-height: 1.25;
  text-transform: uppercase;
  color: #1a2744;
  margin: 0 0 0.7rem;
}
.home-card p { flex: 1; margin: 0 0 1.15rem; color: #4e5c66; font-size: 0.98rem; }
.home-card a {
  color: #1c3558;
  font-weight: 650;
  text-decoration: underline;
  text-underline-offset: 0.18em;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
}
.home-welcome { padding: 2.25rem 0 3.25rem; background: #f7f4ef; }
.home-welcome-inner {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(16rem, 28rem);
  gap: 2.75rem;
  align-items: center;
}
.home-kicker {
  margin: 0 0 0.4rem;
  color: #c6a15a;
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}
.home-welcome h2 {
  font-size: clamp(3.15rem, 6vw, 4.35rem);
  color: #1a2744;
  margin: 0 0 0.75rem;
  line-height: 1.05;
}
.home-welcome-copy > p:last-child {
  margin: 0;
  max-width: 36rem;
  color: #3d4a56;
  font-size: 1.05rem;
  line-height: 1.6;
}
.home-beach-frame {
  align-self: center;
  justify-self: center;
  width: 100%;
  aspect-ratio: 16 / 10;
  border-radius: 1.15rem;
  overflow: hidden;
  position: relative;
}
.home-beach {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center;
  display: block;
}
.home-demo { padding: 0 0 2.5rem; }
.home-footer { color: #5d6c74; font-size: 0.88rem; padding: 0.5rem 0 2rem; background: #f7f4ef; }
.home-footer-inner {
  width: min(1080px, calc(100% - 2rem));
  margin: 0 auto;
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 1.25rem 2rem;
  align-items: center;
}
.home-footer-brand {
  display: grid;
  justify-items: center;
  text-decoration: none;
  color: #5d6c74;
  font-size: 0.78rem;
  line-height: 1.3;
}
.home-footer-brand img { width: 8.5rem; height: auto; display: block; }
.home-footer nav { display: flex; flex-wrap: wrap; justify-content: center; gap: 0.35rem 1.15rem; }
.home-footer nav a { color: #1a2744; text-decoration: none; }
.home-footer nav a:hover, .home-footer nav a:focus { text-decoration: underline; }
.home-footer-end { text-align: right; }
.home-footer-end p { margin: 0.15rem 0; }
.home-footer-end a { color: #5d6c74; text-decoration: none; }
.home-footer-end a:hover, .home-footer-end a:focus { text-decoration: underline; }
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
  width: fit-content;
  max-width: calc(100% - 1.5rem);
  display: grid;
  grid-template-columns: minmax(0, 36rem) auto;
  align-items: center;
  gap: 0.35rem 1.35rem;
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
  .home-cards { grid-template-columns: 1fr; }
  .home-welcome-inner { grid-template-columns: 1fr; gap: 1.5rem; }
  .home-footer-inner { grid-template-columns: 1fr; justify-items: center; }
  .home-footer-end { text-align: center; }
}
.kicker {
  margin: 0 0 0.3rem;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--gulf);
}
.dash { display: grid; gap: 1rem; }
.dash-hello h1 { font-size: clamp(2rem, 4vw, 2.6rem); margin: 0; }
.dash-hello p { margin: 0.15rem 0; }
.dash .dash-rule { margin: 0.4rem 0 0.65rem; }
.dash-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; align-items: stretch; }
.dash .panel { background: rgba(255, 253, 248, 0.94); border: 1px solid #d5e4df; border-top: 3px solid var(--gulf); }
.dash .dash-balance {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  background: linear-gradient(180deg, rgba(226, 242, 239, 0.98), rgba(255, 253, 248, 0.96));
}
.balance-figure {
  font-family: var(--sans);
  font-variant-numeric: tabular-nums lining-nums;
  font-size: clamp(2.5rem, 5vw, 3.3rem);
  line-height: 1;
  margin: 0.35rem 0 0.55rem;
}
.balance-figure .money { font-variant-numeric: tabular-nums lining-nums; }
.dash-balance .money.settled { color: var(--gulf-dark); }
.panel-head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.75rem; }
.panel-head h2 { margin: 0; }
.panel-head a { font-size: 0.88rem; white-space: nowrap; text-decoration: none; }
.lots { display: grid; }
.lot {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.75rem 0;
  border-bottom: 1px solid #e4d9c8;
}
.lot:last-child { border-bottom: 0; padding-bottom: 0.15rem; }
.lot-name { margin: 0; font-weight: 650; }
.lot p { margin: 0.1rem 0; }
.lot-figures { text-align: right; }
.lot-amount { margin: 0; font-size: 1.25rem; }
.dues-list, .dash-feed { list-style: none; margin: 0.35rem 0 0; padding: 0; display: grid; gap: 0.8rem; }
.dues-list li { display: flex; justify-content: space-between; gap: 0.75rem; align-items: flex-start; }
.dues-list p, .dash-feed p { margin: 0; }
.dues-amount { text-align: right; }
.dash-feed a { text-decoration: none; color: inherit; display: grid; gap: 0.1rem; }
.dash-feed a strong { font-weight: 650; }
.dash-feed a:hover strong, .dash-feed a:focus strong { color: var(--gulf); }
body:has(.ask-portal) main { padding-bottom: 5rem; }
.ask-portal { position: fixed; right: 1.1rem; bottom: 1.1rem; z-index: 40; margin: 0; }
.ask-portal > summary {
  list-style: none;
  cursor: pointer;
  background: var(--gulf);
  color: white;
  border-radius: 0;
  padding: 0.72rem 1rem;
  font-weight: 650;
  box-shadow: 0 10px 24px rgba(12, 51, 50, 0.18);
}
.ask-portal > summary::-webkit-details-marker { display: none; }
.ask-portal > summary::marker { content: ""; }
.ask-portal > summary:focus-visible { outline: 2px solid var(--gulf-dark); outline-offset: 3px; }
.ask-portal[open] > summary { background: var(--gulf-dark); }
.ask-panel {
  position: absolute;
  right: 0;
  bottom: calc(100% + 0.55rem);
  width: min(22.5rem, calc(100vw - 2.2rem));
  max-height: min(32rem, calc(100vh - 6rem));
  overflow: auto;
  background: var(--paper);
  border: 1px solid #d5e4df;
  border-radius: 0;
  box-shadow: 0 16px 40px rgba(28, 40, 48, 0.16);
  padding: 1rem 1rem 1.05rem;
}
.ask-panel h2 { font-size: 1.55rem; margin-bottom: 0.15rem; }
.ask-thread {
  background: #e7f4f1;
  border: 1px solid #c5ddd8;
  border-radius: 0;
  padding: 0.85rem 0.9rem;
  margin: 0.8rem 0 0.75rem;
}
.ask-required {
  margin: 0;
  font-size: 1.45rem;
  line-height: 1.15;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--gulf-dark);
}
.ask-thread p { margin: 0.4rem 0 0; }
.ask-panel input:disabled { cursor: not-allowed; background: #f6f3ec; color: var(--muted); }
.ask-note { margin: 0.45rem 0 0; font-size: 0.88rem; }
.access-selection-barrier {
  height: 0;
  margin: 0;
  padding: 0;
  border: 0;
  overflow: hidden;
  line-height: 0;
}
.access-admin-list ul { margin: 0.35rem 0 0; padding-left: 1.2rem; }
.access-admin-list li { margin: 0.35rem 0; }
.access-admin-list li .muted { display: block; }
@media (max-width: 800px) {
  .dash-grid { grid-template-columns: 1fr; }
  .lot { flex-direction: column; }
  .lot-figures { text-align: left; }
}
.pitch { padding-bottom: 0; }
.pitch-jump {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.45rem 1.1rem;
  padding: 0.2rem 0 0.4rem;
}
.pitch-jump a:not(.button) { color: var(--ink); text-decoration: none; padding-bottom: 0.15rem; }
.pitch-jump a:not(.button):hover, .pitch-jump a:not(.button):focus { color: var(--gulf); }
.pitch-jump .button { margin-left: auto; }
.pitch-hero { padding: 0.4rem 0 2.2rem; }
.pitch-hero-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(16rem, 1.05fr);
  gap: 2rem 1.75rem;
  align-items: center;
}
.pitch h1 { font-size: clamp(2.35rem, 5vw, 3.45rem); line-height: 1.05; color: #1a2744; }
.pitch-sub { margin: 0 0 0.75rem; font-size: 1.12rem; color: #1a2744; }
.pitch-hero-copy > p:last-child { margin-bottom: 0; }
.pitch .rule.pitch-rule-left { margin-left: 0; }
.pitch-devices { position: relative; margin: 0; padding: 0 1.4rem 1.6rem 0; }
.pitch-laptop, .pitch-phone { margin: 0; }
.pitch-laptop-bezel {
  background: var(--ink);
  border: 0.55rem solid var(--ink);
  border-bottom-width: 0.65rem;
  border-radius: 0.65rem 0.65rem 0 0;
}
.pitch-laptop-bezel img, .pitch-phone img, .pitch-shot img {
  display: block;
  width: 100%;
  height: auto;
  background: var(--sand);
}
.pitch-laptop-base {
  height: 0.7rem;
  background: #24343c;
  border-radius: 0 0 0.4rem 0.4rem;
  position: relative;
}
.pitch-laptop-base::before {
  content: "";
  position: absolute;
  left: 50%;
  bottom: -0.32rem;
  transform: translateX(-50%);
  width: 22%;
  height: 0.32rem;
  background: #31434c;
  border-radius: 0 0 0.2rem 0.2rem;
}
.pitch-phone {
  position: absolute;
  width: 30%;
  right: 0;
  bottom: 0;
  background: var(--ink);
  border-radius: 0.8rem;
  padding: 0.38rem;
  box-shadow: 0 12px 28px rgba(28, 40, 48, 0.18);
}
.pitch-phone img {
  height: 13rem;
  object-fit: cover;
  object-position: top center;
  border-radius: 0.45rem;
}
.pitch-center { text-align: center; }
.pitch-section { padding: 2.3rem 0; }
.pitch .home-card h3 {
  font-family: var(--serif);
  font-weight: 400;
  letter-spacing: -0.02em;
  text-transform: none;
  font-size: 1.4rem;
  line-height: 1.2;
}
.pitch .home-card .badge { margin-top: 0.35rem; }
.pitch-see-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(15rem, 0.75fr);
  gap: 1.5rem 1.75rem;
  align-items: center;
}
.pitch-shot {
  margin: 0;
  border: 1px solid var(--line);
  background: var(--paper);
  box-shadow: var(--shadow);
}
.pitch-shot a { display: block; }
.pitch-shot a:focus-visible { outline: 2px solid var(--gulf); outline-offset: 3px; }
.pitch-checks { list-style: none; margin: 0 0 1.15rem; padding: 0; display: grid; gap: 0.55rem; }
.pitch-checks li { display: flex; gap: 0.55rem; align-items: flex-start; }
.pitch-checks svg { width: 1.25rem; height: 1.25rem; flex: 0 0 auto; margin-top: 0.15rem; color: var(--ok); }
.pitch-board { background: var(--gulf-dark); color: #fffdf8; }
.pitch-board h2, .pitch-board h3 { color: #fffdf8; }
.pitch-board .pitch-sub { color: #d7e6e3; }
.pitch-board .rule { background: #c6a15a; }
.pitch-board-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1.25rem;
  margin-top: 1.35rem;
}
.pitch-board-icon { width: 2.1rem; height: 2.1rem; color: #c6a15a; margin-bottom: 0.55rem; }
.pitch-board-icon svg { width: 100%; height: 100%; display: block; }
.pitch-board h3 { font-size: 1.45rem; margin: 0 0 0.3rem; }
.pitch-board p { margin: 0; color: #d7e6e3; }
.pitch-prices {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1rem;
  text-align: left;
}
.pitch-price {
  display: flex;
  flex-direction: column;
  background: var(--paper);
  border: 1px solid var(--line);
  box-shadow: var(--shadow);
  padding: 1.2rem 1.15rem 1.25rem;
}
.pitch-price.popular { border-top: 3px solid var(--gulf); }
.pitch-popular {
  margin: 0 0 0.35rem;
  color: var(--gulf);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
.pitch-price h3 { font-size: 1.65rem; }
.pitch-amount {
  font-family: var(--sans);
  font-weight: 700;
  font-size: 2.15rem;
  line-height: 1.1;
  margin: 0.15rem 0 0.7rem;
  color: var(--gulf-dark);
}
.pitch-price ul { margin: 0.4rem 0 1.1rem; padding-left: 1.15rem; flex: 1; }
.pitch-price li { margin: 0.32rem 0; }
.pitch-price .button { text-align: center; }
.pitch-table-wrap { overflow-x: auto; }
.pitch-status {
  display: inline-block;
  font-size: 0.78rem;
  font-weight: 650;
  padding: 0.08rem 0.45rem;
  background: #e7f4ee;
  color: var(--ok);
  white-space: nowrap;
}
.pitch-status.soon { background: #fff4e5; color: var(--warn); }
.pitch-soon {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
  text-align: left;
}
.pitch-soon article {
  background: var(--paper);
  border: 1px solid var(--line);
  box-shadow: var(--shadow);
  padding: 1.15rem 1.15rem 1.2rem;
}
.pitch-soon-icon {
  width: 2.4rem;
  height: 2.4rem;
  border-radius: 50%;
  display: grid;
  place-items: center;
  margin-bottom: 0.7rem;
  background: #d7e7f8;
  color: #1c3558;
}
.pitch-soon-icon svg { width: 1.25rem; height: 1.25rem; display: block; }
.pitch-soon h3 { font-family: var(--sans); font-weight: 700; font-size: 1.05rem; letter-spacing: 0; margin: 0 0 0.35rem; }
.pitch-soon .badge { margin-bottom: 0.55rem; }
.pitch-faq .stack { text-align: left; }
.pitch-form { max-width: 36rem; margin: 0 auto; text-align: left; }
.pitch-form h2 { font-size: 2rem; }
.pitch section[id] { scroll-margin-top: 1rem; }
.pitch-dialog {
  width: min(68rem, calc(100vw - 2rem));
  max-height: calc(100vh - 2rem);
  border: 1px solid var(--line);
  background: var(--paper);
  padding: 0.75rem 0.75rem 0.9rem;
  box-shadow: 0 16px 40px rgba(28, 40, 48, 0.16);
}
.pitch-dialog::backdrop { background: rgba(27, 40, 48, 0.45); }
.pitch-dialog-bar { display: flex; justify-content: space-between; align-items: center; gap: 1rem; margin: 0 0 0.65rem; }
.pitch-dialog-bar p { margin: 0; }
.pitch-dialog img { width: 100%; height: auto; display: block; border: 1px solid var(--line); }
@media (max-width: 900px) {
  .pitch .home-cards { grid-template-columns: 1fr 1fr; }
}
@media (max-width: 800px) {
  .pitch-jump .button { margin-left: 0; }
  .pitch-hero-grid, .pitch-see-grid, .pitch-prices, .pitch-soon { grid-template-columns: 1fr; }
  .pitch-board-grid { grid-template-columns: 1fr 1fr; }
  .pitch-devices { padding: 0; }
  .pitch-phone { position: static; width: min(16rem, 72%); margin: 1rem auto 0; }
  .pitch-phone img { height: auto; object-fit: contain; }
}
@media (max-width: 560px) {
  .pitch .home-cards, .pitch-board-grid { grid-template-columns: 1fr; }
}
`;

const HOME_SLUG = "tango-mar";
const MEMBER_HEADER_PATHS = new Set(["/privacy", "/terms"]);

export function siteFooter(): string {
  const base = `/a/${HOME_SLUG}`;
  return `<footer class="home-footer">
    <div class="home-footer-inner">
      <a class="home-footer-brand" href="/">
        <img src="/tango-mar-mark.png" alt="Tango Mar" width="1143" height="789">
        <span>Miramar Beach, Florida</span>
      </a>
      <nav aria-label="Footer">
        <a href="/">Home</a>
        <a href="${base}/dashboard">Dashboard</a>
        <a href="${base}/documents">Documents</a>
        <a href="${base}/faq">FAQs</a>
        <a href="${base}/messages">Contact</a>
        <a href="/bring-this-to-your-hoa">Bring This to Your HOA</a>
      </nav>
      <div class="home-footer-end">
        <p><a href="/privacy">Privacy Policy</a> | <a href="/terms">Terms of Use</a></p>
        <p>© 2026 Tango Mar Property Owners Association</p>
      </div>
    </div>
  </footer>`;
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

function askPortalWidget(): string {
  return `<details class="ask-portal">
    <summary>Ask the portal</summary>
    <div class="ask-panel">
      <p class="kicker">Tango Mar</p>
      <h2>Ask the portal</h2>
      <p>Questions about covenants, bylaws, and your lot.</p>
      <div class="ask-thread">
        <p class="ask-required">SUBSCRIPTION REQUIRED</p>
        <p>The assistant is part of a paid subscription. It is not available yet.</p>
      </div>
      <label>Message
        <input type="text" disabled placeholder="Subscription required">
      </label>
      <p class="muted ask-note">Coming later. This box does not send a message.</p>
    </div>
  </details>`;
}

function shell(options: {
  title: string;
  brandHref: string;
  nav: string;
  account: string;
  body: string;
  landing?: boolean;
  marketing?: boolean;
  askPortal?: boolean;
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
  ${siteFooter()}
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
  <main id="content" class="${options.marketing ? "pitch" : "wrap stack"}">${options.body}</main>
  ${options.askPortal ? askPortalWidget() : ""}
  ${siteFooter()}
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
  const profileHref = portal ? portal.dashboardHref.replace(/\/dashboard\/?$/, "/profile") : "";
  const nameHtml = profileHref ? `<a class="account-name" href="${esc(profileHref)}">${esc(name)}</a>` : esc(name);
  return `${enter}${nameHtml} <form method="post" action="/logout"><button class="linkish" type="submit">Log out</button></form>`;
}

export async function render(
  c: AppContext,
  options: {
    title: string;
    active?: string;
    body: string;
    status?: number;
    marketing?: boolean;
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
      { id: "notices", href: `${base}/notices`, label: unread > 0 ? `Notices from the Board (${unread})` : "Notices from the Board" },
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
    resident && canViewAdmin(membership)
      ? `<a class="account-admin${options.active === "admin" ? " active" : ""}" href="${esc(`${base}/admin`)}">Admin</a>`
      : "";
  const displayName = user ? esc(user.name || user.email) : "";
  const profileHref = resident ? `${base}/profile` : "";
  const nameHtml = profileHref ? `<a class="account-name" href="${esc(profileHref)}">${displayName}</a>` : displayName;
  const account = user
    ? onPublicHome
      ? landingAccount(user.name || user.email, options.portal ?? null)
      : `${adminLink}${nameHtml} <form method="post" action="/logout"><button class="linkish" type="submit">Log out</button></form>`
    : "";
  const body = shell({
    title: options.title,
    brandHref: "/",
    nav: onPublicHome ? "" : nav,
    account,
    landing: onPublicHome,
    marketing: options.marketing,
    askPortal: resident,
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
