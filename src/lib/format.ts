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

const timeFormatter = new Intl.DateTimeFormat("pt-BR", { timeZone: BUSINESS_RULES.timezone, timeStyle: "short" });
const shortDateFormatter = new Intl.DateTimeFormat("pt-BR", { timeZone: BUSINESS_RULES.timezone, day: "2-digit", month: "2-digit", year: "numeric" });
const dayKeyFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_RULES.timezone, year: "numeric", month: "2-digit", day: "2-digit" });

function businessDayIndex(date: Date): number {
  return Math.round(Date.parse(dayKeyFormatter.format(date)) / 86_400_000);
}

export function formatTime(date: Date | string): string {
  return timeFormatter.format(new Date(date));
}

export function formatShortDate(date: Date | string): string {
  return shortDateFormatter.format(new Date(date));
}

/**
 * Data/hora relativa ao dia de hoje no fuso do negócio: "hoje 09:41",
 * "ontem 15:20", "amanhã 08:00" ou "12/10/2026 09:41".
 */
export function formatRelativeDateTime(date: Date | string, now: Date = new Date()): string {
  const value = new Date(date);
  const diff = businessDayIndex(value) - businessDayIndex(now);
  const time = timeFormatter.format(value);
  if (diff === 0) return `hoje ${time}`;
  if (diff === -1) return `ontem ${time}`;
  if (diff === 1) return `amanhã ${time}`;
  return `${shortDateFormatter.format(value)} ${time}`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}
