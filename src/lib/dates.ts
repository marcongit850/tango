export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function zonedIsoDate(instant: Date, timeZone: string): string {
  return todayIso(timeZone, instant);
}

export function utcToDatetimeLocal(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = zonedParts(date, timeZone);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function todayIso(timeZone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return parts;
}

export function formatDate(iso: string, timeZone: string): string {
  const date = iso.length === 10 ? new Date(`${iso}T12:00:00Z`) : new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

export function formatDateTime(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

export function timeZoneLabel(timeZone: string): string {
  if (timeZone === "America/Chicago") return "Central Time";
  if (timeZone === "America/New_York") return "Eastern Time";
  return timeZone;
}

function zonedParts(instant: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const map = new Map(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  let year = Number(map.get("year"));
  let month = Number(map.get("month"));
  let day = Number(map.get("day"));
  let hour = Number(map.get("hour"));
  const minute = Number(map.get("minute"));
  const second = Number(map.get("second"));
  if (hour === 24) {
    hour = 0;
    const rolled = new Date(Date.UTC(year, month - 1, day));
    rolled.setUTCDate(rolled.getUTCDate() + 1);
    year = rolled.getUTCFullYear();
    month = rolled.getUTCMonth() + 1;
    day = rolled.getUTCDate();
  }
  return { year, month, day, hour, minute, second };
}

export function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const zonedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return zonedAsUtc - instant.getTime();
}

/** Interpret a `datetime-local` value in the association time zone and return a UTC ISO string. */
export function zonedLocalToUtc(local: string, timeZone: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null;
  const [datePart, timePart] = local.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = timePart.split(":").map(Number);
  if (!isIsoDate(datePart)) return null;
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  let utc = utcGuess - timeZoneOffsetMs(new Date(utcGuess), timeZone);
  utc = utcGuess - timeZoneOffsetMs(new Date(utc), timeZone);
  return new Date(utc).toISOString();
}

export function formatPlace(place: { city: string; county: string; state: string }): string {
  const stateName = place.state === "FL" ? "Florida" : place.state;
  return [place.city, place.county, stateName].filter(Boolean).join(", ");
}

export function formatAddress(place: {
  address_line1: string;
  city: string;
  state: string;
  postal_code: string;
}): string {
  const cityLine = [place.city, place.state].filter(Boolean).join(", ");
  const withPostal = [cityLine, place.postal_code].filter(Boolean).join(" ");
  return [place.address_line1, withPostal].filter(Boolean).join(", ");
}
