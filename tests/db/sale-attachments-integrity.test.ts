import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "@/server/db/connect";
import { saleAttachments } from "@/server/db/schema";
import { createLead } from "@/server/modules/leads/leads.service";
import { createSale } from "@/server/modules/sales/sales.service";
import { createTestDatabase, seedOrganization } from "../support/db";
import { insertCourseWithCost } from "../support/sales";

/** Regras do 007 garantidas pelo BANCO (independentes do serviço). */
let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let saleId: string;
let seq = 0;

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
  const course = await insertCourseWithCost(handle, "Pedagogia", 50_000);
  const lead = await createLead(await org.ctx(org.ids.sellerA1), { name: "Aluno", phone: "(79) 93000-0001", interestCourseId: course });
  const input = { requestId: crypto.randomUUID(), leadId: lead.id, paymentMethod: "PIX", items: [{ courseId: course, priceCents: 100_000 }] };
  saleId = (await createSale(await org.ctx(org.ids.sellerA1), input)).saleId;
});
afterAll(() => handle.close());

async function insertAttachment(overrides: Partial<typeof saleAttachments.$inferInsert> = {}) {
  const [row] = await handle.db
    .insert(saleAttachments)
    .values({
      saleId,
      storageKey: `sales/${saleId}/${++seq}`,
      fileName: "comprovante.pdf",
      contentType: "application/pdf",
      sizeBytes: 1000,
      uploadedBy: org.ids.sellerA1,
      ...overrides,
    })
    .returning();
  return row;
}

describe("sale_attachments (007)", () => {
  it("aceita só os tipos e tamanhos permitidos e chave única", async () => {
    await expect(insertAttachment()).resolves.toMatchObject({ saleId });
    await expect(insertAttachment({ contentType: "text/html" as never })).rejects.toThrow();
    await expect(insertAttachment({ sizeBytes: 0 })).rejects.toThrow();
    await expect(insertAttachment({ sizeBytes: 5 * 1024 * 1024 + 1 })).rejects.toThrow();
    await expect(insertAttachment({ fileName: "   " })).rejects.toThrow();
    await expect(insertAttachment({ storageKey: `sales/${saleId}/1` })).rejects.toThrow();
  });

  it("sem exclusão física; dados do envio imutáveis", async () => {
    const row = await insertAttachment();
    await expect(handle.db.delete(saleAttachments).where(eq(saleAttachments.id, row.id))).rejects.toThrow();
    await expect(handle.db.execute(sql`TRUNCATE public.sale_attachments`)).rejects.toThrow();
    await expect(handle.db.update(saleAttachments).set({ fileName: "outro.pdf" }).where(eq(saleAttachments.id, row.id))).rejects.toThrow();
  });

  it("remoção lógica com autor, uma única vez", async () => {
    const row = await insertAttachment();
    await expect(handle.db.update(saleAttachments).set({ removedAt: new Date() }).where(eq(saleAttachments.id, row.id))).rejects.toThrow();
    await handle.db.update(saleAttachments).set({ removedAt: new Date(), removedBy: org.ids.admin }).where(eq(saleAttachments.id, row.id));
    await expect(
      handle.db.update(saleAttachments).set({ removedAt: null, removedBy: null }).where(eq(saleAttachments.id, row.id)),
    ).rejects.toThrow();
  });
});
