import { describe, expect, it } from "vitest";
import type { Actor } from "@/server/authz/actor";
import { hasPermission } from "@/server/authz/permissions";
import { canAccessOwned, canManageTeam } from "@/server/authz/scope";

const admin: Actor = { userId: "admin", name: "", email: "", role: "ADMIN", teamId: null, supervisedTeamId: null };
const supA: Actor = { userId: "supA", name: "", email: "", role: "SUPERVISOR", teamId: null, supervisedTeamId: "teamA" };
const supWithoutTeam: Actor = { ...supA, userId: "supX", supervisedTeamId: null };
const sellerA1: Actor = { userId: "a1", name: "", email: "", role: "SELLER", teamId: "teamA", supervisedTeamId: null };

const recordOfA1 = { ownerId: "a1", teamId: "teamA" };
const recordOfA2 = { ownerId: "a2", teamId: "teamA" };
const recordOfB1 = { ownerId: "b1", teamId: "teamB" };

describe("RBAC — matriz de permissões", () => {
  it("custo de bolsa e lucro são exclusivos do administrador", () => {
    expect(hasPermission(admin, "courses:viewCost")).toBe(true);
    expect(hasPermission(supA, "courses:viewCost")).toBe(false);
    expect(hasPermission(sellerA1, "courses:viewCost")).toBe(false);
    expect(hasPermission(supA, "finance:viewCostAndProfit")).toBe(false);
    expect(hasPermission(sellerA1, "finance:viewCostAndProfit")).toBe(false);
  });

  it("gestão de usuários e equipes é exclusiva do administrador", () => {
    for (const permission of ["users:manage", "teams:manage", "audit:view"] as const) {
      expect(hasPermission(admin, permission)).toBe(true);
      expect(hasPermission(supA, permission)).toBe(false);
      expect(hasPermission(sellerA1, permission)).toBe(false);
    }
  });

  it("vendedor não transfere, redistribui, recupera nem estorna", () => {
    for (const permission of ["leads:transfer", "leads:redistribute", "leads:restore", "sales:reverse"] as const) {
      expect(hasPermission(sellerA1, permission)).toBe(false);
    }
  });

  it("somente o vendedor possui carteira comercial (leads e vendas próprios)", () => {
    for (const permission of ["leads:create", "sales:create"] as const) {
      expect(hasPermission(sellerA1, permission)).toBe(true);
      expect(hasPermission(supA, permission)).toBe(false);
      expect(hasPermission(admin, permission)).toBe(false);
    }
  });

  it("leads: todos veem (com escopo); só o vendedor registra observação; supervisor e admin operam a carteira", () => {
    for (const actor of [admin, supA, sellerA1]) {
      expect(hasPermission(actor, "leads:view")).toBe(true);
      expect(hasPermission(actor, "leads:edit")).toBe(true);
    }
    expect(hasPermission(sellerA1, "leads:addNote")).toBe(true);
    expect(hasPermission(supA, "leads:addNote")).toBe(false);
    expect(hasPermission(admin, "leads:addNote")).toBe(false);
    for (const permission of ["leads:transfer", "leads:redistribute", "leads:trash", "leads:restore"] as const) {
      expect(hasPermission(admin, permission)).toBe(true);
      expect(hasPermission(supA, permission)).toBe(true);
      expect(hasPermission(sellerA1, permission)).toBe(false);
    }
  });

  it("somente o supervisor estorna vendas (admin não)", () => {
    expect(hasPermission(supA, "sales:reverse")).toBe(true);
    expect(hasPermission(admin, "sales:reverse")).toBe(false);
    expect(hasPermission(sellerA1, "sales:reverse")).toBe(false);
  });

  it("todos os perfis veem o ranking e marcam parcelas como pagas", () => {
    for (const actor of [admin, supA, sellerA1]) {
      expect(hasPermission(actor, "ranking:view")).toBe(true);
      expect(hasPermission(actor, "installments:markPaid")).toBe(true);
    }
  });
});

describe("Escopo — ownership e equipe", () => {
  it("vendedor acessa apenas registros dos quais é responsável", () => {
    expect(canAccessOwned(sellerA1, recordOfA1)).toBe(true);
    expect(canAccessOwned(sellerA1, recordOfA2)).toBe(false);
    expect(canAccessOwned(sellerA1, recordOfB1)).toBe(false);
  });

  it("supervisor acessa registros da própria equipe e nunca de outra", () => {
    expect(canAccessOwned(supA, recordOfA1)).toBe(true);
    expect(canAccessOwned(supA, recordOfA2)).toBe(true);
    expect(canAccessOwned(supA, recordOfB1)).toBe(false);
  });

  it("supervisor sem equipe não acessa nada", () => {
    expect(canAccessOwned(supWithoutTeam, recordOfA1)).toBe(false);
    expect(canAccessOwned(supWithoutTeam, { ownerId: null, teamId: null })).toBe(false);
    expect(canManageTeam(supWithoutTeam, null)).toBe(false);
  });

  it("administrador acessa tudo", () => {
    expect(canAccessOwned(admin, recordOfB1)).toBe(true);
    expect(canManageTeam(admin, "teamB")).toBe(true);
  });

  it("gestão de equipe: supervisor só a própria; vendedor nenhuma", () => {
    expect(canManageTeam(supA, "teamA")).toBe(true);
    expect(canManageTeam(supA, "teamB")).toBe(false);
    expect(canManageTeam(sellerA1, "teamA")).toBe(false);
  });
});
