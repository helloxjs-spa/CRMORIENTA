import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUSINESS_RULES } from "@/server/config/business-rules";
import type { DatabaseHandle } from "@/server/db/connect";
import { auditEvents, saleAttachments } from "@/server/db/schema";
import { NotFoundError, ValidationError } from "@/server/errors";
import { createLead } from "@/server/modules/leads/leads.service";
import {
  addSaleAttachments,
  detectAttachmentType,
  getSaleAttachmentFile,
  listSaleAttachments,
  removeSaleAttachment,
  TOO_MANY_ATTACHMENTS,
  UNSUPPORTED_FILE,
} from "@/server/modules/sales/attachments.service";
import { createSale } from "@/server/modules/sales/sales.service";
import { memoryFileStorage } from "@/server/storage/file-storage";
import { createTestDatabase, seedOrganization } from "../support/db";
import { insertCourseWithCost } from "../support/sales";

let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let course: string;
let seq = 0;
const ctx = (userId: string) => org.ctx(userId);

const PDF = new TextEncoder().encode("%PDF-1.7\n%conteúdo do comprovante");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const WEBP = new TextEncoder().encode("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ");
const HTML = new TextEncoder().encode("<html><script>alert(1)</script></html>");

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
  course = await insertCourseWithCost(handle, "Pedagogia", 50_000);
});
afterAll(() => handle.close());

async function saleOf(sellerId: string): Promise<string> {
  const lead = await createLead(await ctx(sellerId), { name: `Aluno ${++seq}`, phone: `(79) 95${String(seq).padStart(7, "0")}`, interestCourseId: course });
  const input = { requestId: crypto.randomUUID(), leadId: lead.id, paymentMethod: "PIX", items: [{ courseId: course, priceCents: 100_000 }] };
  return (await createSale(await ctx(sellerId), input)).saleId;
}

describe("detectAttachmentType", () => {
  it("reconhece pelo conteúdo, não pelo nome", () => {
    expect(detectAttachmentType(PDF)).toBe("application/pdf");
    expect(detectAttachmentType(PNG)).toBe("image/png");
    expect(detectAttachmentType(JPEG)).toBe("image/jpeg");
    expect(detectAttachmentType(WEBP)).toBe("image/webp");
    expect(detectAttachmentType(HTML)).toBeNull();
    expect(detectAttachmentType(new Uint8Array())).toBeNull();
  });
});

describe("anexar comprovantes", () => {
  it("vendedor anexa na própria venda: arquivo no armazenamento, registro, lista e auditoria", async () => {
    const storage = memoryFileStorage();
    const saleId = await saleOf(org.ids.sellerA1);
    const { attachmentIds } = await addSaleAttachments(await ctx(org.ids.sellerA1), storage, saleId, {
      files: [
        { fileName: "C:\\fotos\\pix.png", bytes: PNG },
        { fileName: "recibo.pdf", bytes: PDF },
      ],
    });
    expect(attachmentIds).toHaveLength(2);
    expect(storage.keys()).toHaveLength(2);

    const list = await listSaleAttachments(await ctx(org.ids.sellerA1), saleId);
    expect(list.map((a) => [a.fileName, a.contentType, a.sizeBytes, a.uploadedByName])).toEqual([
      ["pix.png", "image/png", PNG.length, "Vendedor A1"],
      ["recibo.pdf", "application/pdf", PDF.length, "Vendedor A1"],
    ]);

    const file = await getSaleAttachmentFile(await ctx(org.ids.sellerA1), storage, saleId, attachmentIds[1]);
    expect(file).toMatchObject({ fileName: "recibo.pdf", contentType: "application/pdf" });
    expect(Array.from(file.bytes)).toEqual(Array.from(PDF));

    const audit = await handle.db.select().from(auditEvents).where(eq(auditEvents.entityId, attachmentIds[0]));
    expect(audit).toMatchObject([{ action: "sale_attachment.created", entityType: "sale_attachment", actorId: org.ids.sellerA1 }]);
    expect(audit[0].metadata).toMatchObject({ saleId, fileName: "pix.png", contentType: "image/png" });
  });

  it("o tipo vem do conteúdo: arquivo disfarçado de PDF é recusado e nada é gravado", async () => {
    const storage = memoryFileStorage();
    const saleId = await saleOf(org.ids.sellerA1);
    await expect(
      addSaleAttachments(await ctx(org.ids.sellerA1), storage, saleId, { files: [{ fileName: "comprovante.pdf", bytes: HTML }] }),
    ).rejects.toThrow(UNSUPPORTED_FILE);
    expect(storage.keys()).toEqual([]);
    expect(await listSaleAttachments(await ctx(org.ids.sellerA1), saleId)).toEqual([]);
  });

  it("recusa arquivo vazio, maior que o limite, lista vazia e campos extras", async () => {
    const storage = memoryFileStorage();
    const saleId = await saleOf(org.ids.sellerA1);
    const seller = await ctx(org.ids.sellerA1);
    const big = new Uint8Array(BUSINESS_RULES.saleAttachmentMaxBytes + 1);
    big.set(PDF);
    for (const input of [
      { files: [{ fileName: "vazio.pdf", bytes: new Uint8Array() }] },
      { files: [{ fileName: "grande.pdf", bytes: big }] },
      { files: [] },
      { files: [{ fileName: "a.pdf", bytes: PDF, contentType: "application/pdf" }] },
      { files: [{ fileName: "a.pdf", bytes: PDF }], uploadedBy: org.ids.admin },
    ]) {
      await expect(addSaleAttachments(seller, storage, saleId, input)).rejects.toBeInstanceOf(ValidationError);
    }
    expect(storage.keys()).toEqual([]);
  });

  it("escopo: outro vendedor e supervisor de outra equipe não veem (404); supervisor da equipe e admin anexam", async () => {
    const storage = memoryFileStorage();
    const saleId = await saleOf(org.ids.sellerA1);
    const files = { files: [{ fileName: "pix.jpg", bytes: JPEG }] };
    for (const userId of [org.ids.sellerA2, org.ids.sellerB1, org.ids.supB]) {
      await expect(addSaleAttachments(await ctx(userId), storage, saleId, files)).rejects.toBeInstanceOf(NotFoundError);
      await expect(listSaleAttachments(await ctx(userId), saleId)).resolves.toEqual([]);
    }
    expect(storage.keys()).toEqual([]);

    const [fromSupervisor] = (await addSaleAttachments(await ctx(org.ids.supA), storage, saleId, files)).attachmentIds;
    await addSaleAttachments(await ctx(org.ids.admin), storage, saleId, files);
    expect(await listSaleAttachments(await ctx(org.ids.sellerA1), saleId)).toHaveLength(2);

    await expect(getSaleAttachmentFile(await ctx(org.ids.sellerA2), storage, saleId, fromSupervisor)).rejects.toBeInstanceOf(NotFoundError);
    // Anexo de outra venda pelo id certo, mas venda errada: 404.
    const otherSale = await saleOf(org.ids.sellerA1);
    await expect(getSaleAttachmentFile(await ctx(org.ids.sellerA1), storage, otherSale, fromSupervisor)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("limite por venda: a transação recusa e os arquivos já enviados são apagados do armazenamento", async () => {
    const storage = memoryFileStorage();
    const saleId = await saleOf(org.ids.sellerA1);
    const seller = await ctx(org.ids.sellerA1);
    const max = BUSINESS_RULES.saleAttachmentMaxPerSale;
    for (let sent = 0; sent < max; sent += 10) {
      const batch = Array.from({ length: Math.min(10, max - sent) }, (_, i) => ({ fileName: `p${sent + i}.pdf`, bytes: PDF }));
      await addSaleAttachments(seller, storage, saleId, { files: batch });
    }
    const before = storage.keys().length;
    await expect(addSaleAttachments(seller, storage, saleId, { files: [{ fileName: "extra.pdf", bytes: PDF }] })).rejects.toThrow(
      TOO_MANY_ATTACHMENTS,
    );
    expect(storage.keys()).toHaveLength(before);
    expect(await handle.db.select().from(saleAttachments).where(eq(saleAttachments.saleId, saleId))).toHaveLength(max);
  });

  it("arquivo sumido do armazenamento: 404 ao abrir", async () => {
    const storage = memoryFileStorage();
    const saleId = await saleOf(org.ids.sellerA1);
    const [id] = (await addSaleAttachments(await ctx(org.ids.sellerA1), storage, saleId, { files: [{ fileName: "a.pdf", bytes: PDF }] }))
      .attachmentIds;
    await expect(getSaleAttachmentFile(await ctx(org.ids.sellerA1), memoryFileStorage(), saleId, id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("id inválido é recusado", async () => {
    const storage = memoryFileStorage();
    await expect(addSaleAttachments(await ctx(org.ids.sellerA1), storage, "nao-e-uuid", { files: [{ fileName: "a.pdf", bytes: PDF }] })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe("remover comprovante", () => {
  it("remoção lógica: some da lista, não abre mais, fica no banco e no armazenamento, com auditoria", async () => {
    const storage = memoryFileStorage();
    const saleId = await saleOf(org.ids.sellerA1);
    const seller = await ctx(org.ids.sellerA1);
    const [keep, drop] = (
      await addSaleAttachments(seller, storage, saleId, {
        files: [
          { fileName: "a-fica.pdf", bytes: PDF },
          { fileName: "b-errado.pdf", bytes: PDF },
        ],
      })
    ).attachmentIds;

    await removeSaleAttachment(seller, saleId, drop);

    expect((await listSaleAttachments(seller, saleId)).map((a) => a.id)).toEqual([keep]);
    await expect(getSaleAttachmentFile(seller, storage, saleId, drop)).rejects.toBeInstanceOf(NotFoundError);
    expect(storage.keys()).toHaveLength(2);
    const [row] = await handle.db.select().from(saleAttachments).where(eq(saleAttachments.id, drop));
    expect(row).toMatchObject({ removedBy: org.ids.sellerA1 });
    expect(row.removedAt).toBeInstanceOf(Date);

    const audit = await handle.db.select().from(auditEvents).where(eq(auditEvents.entityId, drop));
    expect(audit.map((e) => e.action)).toEqual(["sale_attachment.created", "sale_attachment.removed"]);
    expect(audit[1]).toMatchObject({ actorId: org.ids.sellerA1, metadata: { saleId, fileName: "b-errado.pdf" } });

    // Já removido: 404 (não remove de novo).
    await expect(removeSaleAttachment(seller, saleId, drop)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("escopo: fora dele é 404 e nada muda; supervisor da equipe e admin removem", async () => {
    const storage = memoryFileStorage();
    const saleId = await saleOf(org.ids.sellerA1);
    const files = { files: [{ fileName: "a.pdf", bytes: PDF }] };
    const [first] = (await addSaleAttachments(await ctx(org.ids.sellerA1), storage, saleId, files)).attachmentIds;
    const [second] = (await addSaleAttachments(await ctx(org.ids.sellerA1), storage, saleId, files)).attachmentIds;

    for (const userId of [org.ids.sellerA2, org.ids.supB]) {
      await expect(removeSaleAttachment(await ctx(userId), saleId, first)).rejects.toBeInstanceOf(NotFoundError);
    }
    // Venda errada para o anexo certo: 404.
    const otherSale = await saleOf(org.ids.sellerA1);
    await expect(removeSaleAttachment(await ctx(org.ids.sellerA1), otherSale, first)).rejects.toBeInstanceOf(NotFoundError);
    expect(await listSaleAttachments(await ctx(org.ids.sellerA1), saleId)).toHaveLength(2);

    await removeSaleAttachment(await ctx(org.ids.supA), saleId, first);
    await removeSaleAttachment(await ctx(org.ids.admin), saleId, second);
    expect(await listSaleAttachments(await ctx(org.ids.sellerA1), saleId)).toEqual([]);
  });

  it("removido não conta no limite por venda", async () => {
    const storage = memoryFileStorage();
    const saleId = await saleOf(org.ids.sellerA1);
    const seller = await ctx(org.ids.sellerA1);
    const max = BUSINESS_RULES.saleAttachmentMaxPerSale;
    const ids: string[] = [];
    for (let sent = 0; sent < max; sent += 10) {
      const batch = Array.from({ length: Math.min(10, max - sent) }, (_, i) => ({ fileName: `p${sent + i}.pdf`, bytes: PDF }));
      ids.push(...(await addSaleAttachments(seller, storage, saleId, { files: batch })).attachmentIds);
    }
    await removeSaleAttachment(seller, saleId, ids[0]);
    await expect(addSaleAttachments(seller, storage, saleId, { files: [{ fileName: "novo.pdf", bytes: PDF }] })).resolves.toMatchObject({
      attachmentIds: [expect.any(String)],
    });
  });
});
