import { BUSINESS_RULES } from "@/server/config/business-rules";
import type { UserRole } from "@/server/db/schema";

export const ROLE_LABELS: Record<UserRole, string> = {
  ADMIN: "Administrador",
  SUPERVISOR: "Supervisor",
  SELLER: "Vendedor",
};

const dateTimeFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: BUSINESS_RULES.timezone,
  dateStyle: "short",
  timeStyle: "short",
});

const dateFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: BUSINESS_RULES.timezone,
  dateStyle: "long",
});

export function formatDateTime(date: Date | string): string {
  return dateTimeFormatter.format(new Date(date));
}

export function formatLongDate(date: Date | string): string {
  return dateFormatter.format(new Date(date));
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}
