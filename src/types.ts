export type RoleId = "homeowner" | "board" | "officer" | "public";
export type MembershipRole = Exclude<RoleId, "public">;
export type MembershipStatus = "invited" | "active" | "inactive";
export type DocumentCategory =
  | "covenants"
  | "bylaws"
  | "guidelines"
  | "rules"
  | "minutes"
  | "budgets"
  | "forms"
  | "insurance";
export type DocumentVisibility = "residents" | "board";
export type InvoiceStatus = "open" | "partial" | "paid" | "void";
export type PaymentMethod = "check" | "cash" | "ach_recorded" | "other";
export type AnnouncementKind = "news" | "emergency" | "meeting";
export type EventKind = "meeting" | "event" | "emergency";

export type Association = {
  id: string;
  slug: string;
  name: string;
  legal_name: string;
  address_line1: string;
  city: string;
  state: string;
  postal_code: string;
  county: string;
  timezone: string;
};

export type User = {
  id: string;
  email: string;
  name: string;
  phone: string;
};

export type Membership = {
  id: string;
  association_id: string;
  user_id: string;
  role_id: MembershipRole;
  status: MembershipStatus;
};

export type AppVariables = {
  user: User | null;
  association: Association | null;
  membership: Membership | null;
  flash: string | null;
  flashTone: "ok" | "warn";
};

export type AppBindings = {
  Bindings: Env;
  Variables: AppVariables;
};
