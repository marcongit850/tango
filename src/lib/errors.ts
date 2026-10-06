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

export class RedirectError extends Error {
  readonly location: string;

  constructor(location: string) {
    super("Redirect");
    this.name = "RedirectError";
    this.location = location;
  }
}
