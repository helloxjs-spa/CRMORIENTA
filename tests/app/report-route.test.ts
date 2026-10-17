import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ServiceContext } from "@/server/context";
import type { DatabaseHandle } from "@/server/db/connect";
import { createLead } from "@/server/modules/leads/leads.service";
import { createSale } from "@/server/modules/sales/sales.service";
import { createTestDatabase, seedOrganization } from "../support/db";
import { insertCourseWithCost } from "../support/sales";

/**
 * Rota de download /relatorios/exportar chamada diretamente (como uma URL
 * digitada faria). Só a sessão é substituída: rota → serviço → banco são reais.
 */
const session = vi.hoisted(() => ({ current: null as ServiceContext | null }));
vi.mock("@/server/next/session", () => ({
  requireServiceContext: async () => {
    if (!session.current) throw new Error("sem sessão no teste");
    return session.current;
  },
}));

const { GET } = await import("@/app/(app)/relatorios/exportar/route");

let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;

const get = (query: string) => GET(new Request(`http://localhost/relatorios/exportar?${query}`));

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
  const course = await insertCourseWithCost(handle, "Pedagogia", 40_000);
  const lead = await createLead(await org.ctx(org.ids.sellerA1), { name: "=Aluno Fórmula", phone: "(79) 99111-0001", interestCourseId: course });
  await createSale(await org.ctx(org.ids.admin), {
    requestId: crypto.randomUUID(),
    leadId: lead.id,
    sellerId: org.ids.sellerA1,
    saleDate: "2026-07-10",
    paymentMethod: "PIX",
    items: [{ courseId: course, priceCents: 150_000 }],
  });
});
afterAll(() => handle.close());

describe("GET /relatorios/exportar", () => {
  it("devolve CSV para download (BOM, ';', anexo, sem cache), com os filtros da URL e o custo só para o ADMIN", async () => {
    session.current = await org.ctx(org.ids.admin);
    const response = await get("tipo=sales&dateFrom=2026-07-01&dateTo=2026-07-31&campoIgnorado=1");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="relatorio-vendas-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM UTF-8 (o Excel lê os acentos)
    const [header, row] = new TextDecoder().decode(bytes).split("\r\n");
    expect(header.split(";")).toEqual(expect.arrayContaining(["Lead", "Total", "Custo das bolsas", "Lucro"]));
    expect(row).toContain(";'=Aluno Fórmula;");
    expect(row).toContain(";1500,00;");

    session.current = await org.ctx(org.ids.supA);
    const supervisor = await (await get("tipo=sales")).text();
    expect(supervisor).not.toMatch(/Custo|Lucro/);
  });

  it("erro de negócio volta para /relatorios com a mensagem (sem permissão, filtro inválido)", async () => {
    session.current = await org.ctx(org.ids.sellerA1);
    const forbidden = await get("tipo=sales");
    expect(forbidden.status).toBe(303);
    expect(new URL(forbidden.headers.get("location")!).pathname).toBe("/relatorios");

    session.current = await org.ctx(org.ids.admin);
    const invalid = await get("tipo=sales&dateFrom=2026-08-01&dateTo=2026-07-01");
    expect(invalid.status).toBe(303);
    expect(new URL(invalid.headers.get("location")!).searchParams.get("erro")).toBe("A data inicial deve ser igual ou anterior à final.");
  });
});
