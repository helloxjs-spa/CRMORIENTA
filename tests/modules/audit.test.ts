import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DatabaseHandle } from "@/server/db/connect";
import { ForbiddenError, ValidationError } from "@/server/errors";
import { listAuditEvents, recordAudit } from "@/server/modules/audit/audit.service";
import { orNotFound } from "@/server/next/page";
import { createTestDatabase, seedOrganization } from "../support/db";

// notFound() do Next lança um erro próprio; aqui ele é identificável.
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
  for (let i = 0; i < 3; i++) await recordAudit(handle.db, { actorId: org.ids.admin, action: "user.updated", entityType: "user" });
});
afterAll(() => handle.close());

describe("listAuditEvents: entrada validada", () => {
  it("sem filtros e com beforeId válido (paginação por id)", async () => {
    const admin = await org.ctx(org.ids.admin);
    const all = await listAuditEvents(admin);
    expect(all.length).toBeGreaterThanOrEqual(3);
    const older = await listAuditEvents(admin, { beforeId: all[0].id });
    expect(older.map((e) => e.id)).toEqual(all.slice(1).map((e) => e.id));
    expect(await listAuditEvents(admin, { beforeId: Number.MAX_SAFE_INTEGER })).toHaveLength(all.length);
    expect(await listAuditEvents(admin, { entityType: "user" })).not.toHaveLength(0);
  });

  it("beforeId inválido, não inteiro, não positivo ou fora do intervalo seguro e campos extras são recusados", async () => {
    const admin = await org.ctx(org.ids.admin);
    for (const filters of [
      { beforeId: 0 },
      { beforeId: -5 },
      { beforeId: 1.5 },
      { beforeId: Number.NaN },
      { beforeId: Number.MAX_SAFE_INTEGER + 1 },
      { beforeId: 1e20 },
      { beforeId: "12" },
      { entityType: "lead" },
      { actorId: org.ids.admin },
    ]) {
      await expect(listAuditEvents(admin, filters)).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it("na página, entrada inválida vira 404 (não 500); sem permissão também", async () => {
    const admin = await org.ctx(org.ids.admin);
    await expect(orNotFound(listAuditEvents(admin, { beforeId: Number("99999999999999999999") }))).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(orNotFound(listAuditEvents(admin, { beforeId: Number("abc") }))).rejects.toThrow("NEXT_NOT_FOUND");
    const supervisor = await org.ctx(org.ids.supA);
    await expect(listAuditEvents(supervisor)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(orNotFound(listAuditEvents(supervisor))).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
