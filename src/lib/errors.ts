export class NotFoundError extends Error {
  constructor(message = "Not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export function isMissingTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table/i.test(message);
}

export function isCheckConstraint(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /check constraint failed/i.test(message);
}

export function isMissingColumn(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such column/i.test(message);
}

export function isUniqueConstraint(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique constraint failed/i.test(message);
}

export class RedirectError extends Error {
  readonly location: string;

  constructor(location: string) {
    super("Redirect");
    this.name = "RedirectError";
    this.location = location;
  }
}
