import { categoryLabel } from "../lib/categories";
import { formatDate, formatDateTime } from "../lib/dates";
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

export function roleLabel(role: string): string {
  if (role === "officer") return "Officer / manager";
  if (role === "board") return "Board member";
  if (role === "homeowner") return "Homeowner";
  if (role === "public") return "Public";
  return role;
}

export function methodLabel(method: string): string {
  if (method === "check") return "Check";
  if (method === "cash") return "Cash";
  if (method === "ach_recorded") return "ACH (recorded)";
  if (method === "other") return "Other";
  return method;
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

export function selectField(
  label: string,
  name: string,
  options: { value: string; label: string }[],
  selected = "",
): string {
  const html = options
    .map((option) => `<option value="${esc(option.value)}" ${option.value === selected ? "selected" : ""}>${esc(option.label)}</option>`)
    .join("");
  return `<label>${esc(label)}<select name="${esc(name)}">${html}</select></label>`;
}
