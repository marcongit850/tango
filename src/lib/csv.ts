import { isIsoDate } from "./dates";
import { parseMoneyToCents } from "./money";
import type { MembershipRole } from "../types";

export type OwnerCsvRow = {
  line: number;
  email: string;
  name: string;
  lotNumber: string;
  streetAddress: string;
  role: MembershipRole;
  /** null means the sheet did not say. Import keeps an existing admin flag in that case. */
  isAdmin: boolean | null;
  startingBalanceCents: number;
  balanceAsOf: string;
  phone: string;
  city: string;
  state: string;
  postalCode: string;
  houseName: string;
  mailingStreet: string;
  mailingCity: string;
  mailingState: string;
  mailingPostalCode: string;
};

export type CsvIssue = { line: number; message: string };

const REQUIRED_HEADERS = ["email", "name", "lot_number", "street_address"] as const;

export function parseCsv(text: string): string[][] {
  const input = text.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (inQuotes) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (char === "\n") {
      row.push(cell);
      cell = "";
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      continue;
    }
    cell += char;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.trim() !== "")) rows.push(row);
  }
  return rows;
}

export function parseOwnersCsv(
  text: string,
  defaults: { city: string; state: string; postalCode: string; today: string },
): { rows: OwnerCsvRow[]; errors: CsvIssue[] } {
  const table = parseCsv(text);
  if (table.length === 0) return { rows: [], errors: [{ line: 1, message: "The CSV is empty." }] };

  const headers = table[0].map((header) => header.trim().toLowerCase());
  const missing = REQUIRED_HEADERS.filter((header) => !headers.includes(header));
  if (missing.length > 0) {
    return {
      rows: [],
      errors: [{ line: 1, message: `Missing required columns: ${missing.join(", ")}.` }],
    };
  }

  const indexOf = (name: string) => headers.indexOf(name);
  const rows: OwnerCsvRow[] = [];
  const errors: CsvIssue[] = [];

  if (table.length - 1 > 500) {
    errors.push({ line: 1, message: "CSV has more than 500 data rows. Split the file." });
    return { rows, errors };
  }

  for (let record = 1; record < table.length; record += 1) {
    const line = record + 1;
    const cells = table[record];
    const cell = (name: string) => (cells[indexOf(name)] ?? "").trim();
    const email = cell("email").toLowerCase();
    const name = cell("name");
    const lotNumber = cell("lot_number");
    const streetAddress = cell("street_address");
    const roleText = (cell("role") || "homeowner").toLowerCase();
    const adminFlag = parseAdminFlag(indexOf("admin") === -1 ? "" : cell("admin"));
    const balanceText = cell("starting_balance");
    const balanceAsOf = cell("balance_as_of") || defaults.today;
    const phone = cell("phone");
    // Blank city, state, postal_code, or zip stays blank so import can keep the stored value.
    const city = cell("city");
    const state = cell("state");
    const postalCode = cell("postal_code") || cell("zip");
    const houseName = cell("house_name");
    const mailingStreet = cell("mailing_street");
    const mailingCity = cell("mailing_city");
    const mailingState = cell("mailing_state");
    const mailingPostalCode = cell("mailing_postal_code");

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push({ line, message: "Email is not valid." });
      continue;
    }
    if (!name || !lotNumber || !streetAddress) {
      errors.push({ line, message: "Name, lot number, and street address are required." });
      continue;
    }
    if (roleText !== "homeowner" && roleText !== "board" && roleText !== "officer") {
      errors.push({ line, message: "Role must be homeowner or board." });
      continue;
    }
    if (adminFlag === "invalid") {
      errors.push({ line, message: "Admin must be yes or no." });
      continue;
    }
    const startingBalanceCents = parseMoneyToCents(balanceText);
    if (startingBalanceCents === null) {
      errors.push({ line, message: "Starting balance must be a dollar amount like 375.50." });
      continue;
    }
    if (!isIsoDate(balanceAsOf)) {
      errors.push({ line, message: "balance_as_of must be YYYY-MM-DD." });
      continue;
    }

    rows.push({
      line,
      email,
      name,
      lotNumber,
      streetAddress,
      role: roleText === "homeowner" ? "homeowner" : "board",
      isAdmin: roleText === "officer" && adminFlag === null ? true : adminFlag,
      startingBalanceCents,
      balanceAsOf,
      phone,
      city,
      state,
      postalCode,
      houseName,
      mailingStreet,
      mailingCity,
      mailingState,
      mailingPostalCode,
    });
  }

  return { rows, errors };
}

function parseAdminFlag(value: string): boolean | null | "invalid" {
  const text = value.trim().toLowerCase();
  if (!text) return null;
  if (text === "yes" || text === "y" || text === "1" || text === "true") return true;
  if (text === "no" || text === "n" || text === "0" || text === "false") return false;
  return "invalid";
}
