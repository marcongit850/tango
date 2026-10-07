import { categoryLabel } from "../lib/categories";
import { formatDate, formatDateTime } from "../lib/dates";
import { isBrowserViewable } from "../lib/files";
import { esc } from "../lib/html";
import { formatMoney } from "../lib/money";

export function moneySpan(cents: number): string {
  const tone = cents > 0 ? "owe" : cents < 0 ? "credit" : "settled";
  const label = cents < 0 ? `${formatMoney(cents)} credit` : formatMoney(cents);
  return `<span class="money ${tone}">${esc(label)}</span>`;
}

export function dateCell(iso: string, timeZone: string): string {
  return esc(formatDate(iso, timeZone));
}

export function dateTimeCell(iso: string, timeZone: string): string {
  return esc(formatDateTime(iso, timeZone));
}

export function categoryCell(category: string): string {
  return esc(categoryLabel(category));
}

export function roleLabel(role: string, isAdmin = false): string {
  if (role === "officer") return "Board member, edit access";
  if (role === "board") return isAdmin ? "Board member, edit access" : "Board member";
  if (role === "homeowner") return isAdmin ? "Homeowner, edit access" : "Homeowner";
  if (role === "public") return "Public";
  return role;
}

export function visibilityLabel(visibility: string): string {
  if (visibility === "board") return "Board only";
  return "Owners and residents";
}

export function methodLabel(method: string): string {
  if (method === "check") return "Check";
  if (method === "cash") return "Cash";
  if (method === "ach_recorded") return "ACH (recorded)";
  if (method === "other") return "Other";
  return method;
}

export function documentFileLinks(href: string, contentType: string | null | undefined): string {
  const safe = esc(href);
  const download = `<a href="${safe}?download=1">Download</a>`;
  if (!isBrowserViewable(contentType ?? "")) return download;
  return `<span class="actions"><a href="${safe}" target="_blank" rel="noopener">View</a>${download}</span>`;
}

export function empty(text: string): string {
  return `<p class="muted">${esc(text)}</p>`;
}

export function textField(label: string, name: string, options: { value?: string; type?: string; required?: boolean } = {}): string {
  return `<label>${esc(label)}<input name="${esc(name)}" type="${esc(options.type ?? "text")}" value="${esc(options.value ?? "")}" ${options.required ? "required" : ""}></label>`;
}

export function areaField(label: string, name: string, value = "", required = false): string {
  return `<label>${esc(label)}<textarea name="${esc(name)}" ${required ? "required" : ""}>${esc(value)}</textarea></label>`;
}

/**
 * Required checkbox, same as document and assessment deletes.
 * The portal content security policy blocks inline confirm(), so the checkbox is the confirm step the browser enforces.
 * The server still rejects the post unless confirm=yes.
 */
export function confirmDeleteButton(action: string, label: string, confirmLabel = "Confirm"): string {
  return `<form method="post" action="${esc(action)}"><label><input type="checkbox" name="confirm" value="yes" required> ${esc(confirmLabel)}</label><button class="secondary" type="submit">${esc(label)}</button></form>`;
}

export function selectField(
  label: string,
  name: string,
  options: { value: string; label: string; propertyId?: string; hidden?: boolean }[],
  selected = "",
): string {
  const html = options
    .map((option) => {
      const property = option.propertyId ? ` data-property-id="${esc(option.propertyId)}"` : "";
      const hidden = option.hidden ? " hidden disabled" : "";
      return `<option value="${esc(option.value)}"${property}${hidden} ${option.value === selected ? "selected" : ""}>${esc(option.label)}</option>`;
    })
    .join("");
  return `<label>${esc(label)}<select name="${esc(name)}">${html}</select></label>`;
}

export function addressLine(street: string, city: string, state: string, postal: string): string {
  const cityState = [city.trim(), state.trim()].filter(Boolean).join(", ");
  const locality = [cityState, postal.trim()].filter(Boolean).join(" ");
  return [street.trim(), locality].filter(Boolean).join(", ");
}

export function contactPhones(contacts: { name: string; phone: string; isPrimary?: boolean }[]): string {
  if (contacts.length === 0) return empty("No owner is linked to this lot.");
  const items = contacts
    .map((contact) => {
      const primary = contact.isPrimary ? " (primary)" : "";
      const phone = contact.phone.trim() || "No phone on file";
      return `<li>${esc(contact.name)}${primary}: ${esc(phone)}</li>`;
    })
    .join("");
  return `<ul>${items}</ul>`;
}
