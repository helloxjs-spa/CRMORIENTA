import { eq, is, SQL, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "@/server/db/connect";
import { getTableConfig, isPgEnum, PgDialect, PgTable, type PgColumn } from "drizzle-orm/pg-core";
import * as schema from "@/server/db/schema";
import { auditEvents, teams, users } from "@/server/db/schema";
import { recordAudit } from "@/server/modules/audit/audit.service";
import { createTestDatabase, insertUser, seedOrganization } from "../support/db";

let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
});
afterAll(() => handle.close());

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return ((await handle.db.execute(query)) as unknown as { rows: T[] }).rows;
}

// ---------------------------------------------------------------------------
// Paridade schema Drizzle × banco real (os SQLs de database/migrations)
// ---------------------------------------------------------------------------

/** Tabelas criadas pelas migrations 001–006 (conferidas no banco E no Drizzle). */
const EXPECTED_TABLES = [
  "audit_events",
  "certificates",
  "course_costs",
  "courses",
  "installments",
  "lead_cycles",
  "lead_events",
  "lead_notes",
  "leads",
  "sale_events",
  "sale_items",
  "sales",
  "sessions",
  "teams",
  "users",
];

/**
 * FKs mantidas SÓ no SQL: as compostas, que garantem que ciclo, nota e venda
 * sejam do MESMO lead. Qualquer outra FK do banco precisa estar no Drizzle.
 */
const SQL_ONLY_FOREIGN_KEYS = ["lead_events_cycle_fk", "lead_events_note_fk", "lead_events_sale_fk", "lead_notes_cycle_fk"];

/** Índices mantidos SÓ no SQL. Vazio: todo índice do banco está declarado no Drizzle. */
const SQL_ONLY_INDEXES: string[] = [];

/** CHECKs do 003 em lead_events que, pela convenção de leads.ts, ficam SÓ no SQL. */
const SQL_ONLY_SALE_CHECKS = { lead_events: ["lead_events_sale_reference", "lead_events_sale_has_owner"] };

/** Colunas que o banco preenche/carimba (triggers do 003): o ORM não pode gerar valor próprio para elas. */
const DB_CONTROLLED_COLUMNS: Record<string, string[]> = {
  sales: ["created_at", "updated_at", "last_change_txid", "tx_base"],
  sale_items: ["added_at", "removed_at", "added_txid", "removed_txid", "price_changed_txid", "price_tx_base"],
  sale_events: ["occurred_at", "txid", "metadata"],
  installments: ["paid_at", "replaced_at", "created_at"],
};

const drizzleTables = Object.values(schema)
  .flatMap((value) => (is(value, PgTable) ? [getTableConfig(value)] : []))
  .sort((a, b) => a.name.localeCompare(b.name));
const drizzleEnums = Object.values(schema).flatMap((value) => (isPgEnum(value) ? [value] : []));
const dialect = new PgDialect();

const SERIAL_TYPES: Record<string, string> = { smallserial: "smallint", serial: "integer", bigserial: "bigint" };

/** Default esperado no banco, no formato de pg_get_expr. */
function expectedDefault(column: PgColumn, dbType: string): string | null {
  if (column.getSQLType() in SERIAL_TYPES) return "nextval(...)";
  if (!column.hasDefault) return null;
  const value = column.default;
  if (is(value, SQL)) return dialect.sqlToQuery(value).sql;
  if (typeof value === "string") return `'${value}'::${dbType}`;
  return String(value);
}

type DbColumn = { table_name: string; column_name: string; data_type: string; not_null: boolean; column_default: string | null };
type DbForeignKey = {
  conname: string;
  table_name: string;
  foreign_table: string;
  on_delete: string;
  columns: string[];
  foreign_columns: string[];
};
type DbIndex = { indexname: string; table_name: string; is_unique: boolean; is_partial: boolean; columns: (string | null)[] };

const ON_DELETE: Record<string, string> = { a: "no action", r: "restrict", c: "cascade", n: "set null", d: "set default" };

describe("migrations (database/migrations, os mesmos SQLs executados no Supabase)", () => {
  it("são idempotentes (reaplicar não falha)", async () => {
    await expect(handle.migrate()).resolves.toBeUndefined();
  });

  it("criam as tabelas esperadas, e cada uma tem schema Drizzle (nos dois sentidos)", async () => {
    const tables = await rows<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    expect(tables.map((r) => r.table_name)).toEqual(EXPECTED_TABLES);
    expect(drizzleTables.map((t) => t.name)).toEqual(EXPECTED_TABLES);
  });

  it("colunas: mesmos nomes, tipos, nulabilidade e defaults", async () => {
    const dbColumns = await rows<DbColumn>(sql`
      select c.relname as table_name, a.attname as column_name,
             format_type(a.atttypid, a.atttypmod) as data_type, a.attnotnull as not_null,
             pg_get_expr(d.adbin, d.adrelid) as column_default
        from pg_attribute a
        join pg_class c on c.oid = a.attrelid
        left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
       where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped`);

    for (const table of drizzleTables) {
      const actual = Object.fromEntries(
        dbColumns
          .filter((c) => c.table_name === table.name)
          .map((c) => [
            c.column_name,
            {
              type: c.data_type,
              notNull: c.not_null,
              default: c.column_default?.startsWith("nextval(") ? "nextval(...)" : c.column_default,
            },
          ]),
      );
      const expected = Object.fromEntries(
        table.columns.map((column) => {
          const type = SERIAL_TYPES[column.getSQLType()] ?? column.getSQLType();
          return [column.name, { type, notNull: column.notNull, default: expectedDefault(column, type) }];
        }),
      );
      expect(expected, table.name).toEqual(actual);
    }
  });

  it("colunas preenchidas pelo banco (003) não têm valor gerado pelo ORM", () => {
    for (const [tableName, columnNames] of Object.entries(DB_CONTROLLED_COLUMNS)) {
      const table = drizzleTables.find((t) => t.name === tableName)!;
      for (const name of columnNames) {
        const column = table.columns.find((c) => c.name === name);
        expect(column, `${tableName}.${name}`).toBeDefined();
        expect(column!.onUpdateFn, `${tableName}.${name} sem $onUpdate`).toBeUndefined();
        expect(column!.defaultFn, `${tableName}.${name} sem $defaultFn`).toBeUndefined();
      }
    }
  });

  it("enums: os mesmos tipos e os mesmos valores, na mesma ordem", async () => {
    const dbEnums = await rows<{ typname: string; labels: string[] }>(sql`
      select t.typname, json_agg(e.enumlabel order by e.enumsortorder) as labels
        from pg_type t join pg_enum e on e.enumtypid = t.oid
       where t.typnamespace = 'public'::regnamespace
       group by t.typname order by t.typname`);
    const expected = drizzleEnums
      .map((e) => ({ typname: e.enumName, labels: [...e.enumValues] }))
      .sort((a, b) => a.typname.localeCompare(b.typname));
    expect(expected).toEqual(dbEnums);
  });

  it("chaves estrangeiras: as do Drizzle existem iguais no banco; as demais são só do SQL (documentadas)", async () => {
    const dbForeignKeys = await rows<DbForeignKey>(sql`
      select con.conname, rel.relname as table_name, frel.relname as foreign_table, con.confdeltype as on_delete,
             (select json_agg(a.attname order by k.i) from unnest(con.conkey) with ordinality k(n, i)
                join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.n) as columns,
             (select json_agg(a.attname order by k.i) from unnest(con.confkey) with ordinality k(n, i)
                join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.n) as foreign_columns
        from pg_constraint con
        join pg_class rel on rel.oid = con.conrelid
        join pg_class frel on frel.oid = con.confrelid
       where con.contype = 'f' and con.connamespace = 'public'::regnamespace`);
    const byName = new Map(dbForeignKeys.map((fk) => [fk.conname, fk]));

    const declared = new Set<string>();
    for (const table of drizzleTables) {
      for (const fk of table.foreignKeys) {
        const name = fk.getName();
        const ref = fk.reference();
        declared.add(name);
        const db = byName.get(name);
        expect(db, `FK ${name} existe no banco`).toBeDefined();
        expect(
          {
            table: table.name,
            columns: ref.columns.map((c) => c.name),
            foreignTable: getTableConfig(ref.foreignTable).name,
            foreignColumns: ref.foreignColumns.map((c) => c.name),
            onDelete: fk.onDelete ?? "no action",
          },
          name,
        ).toEqual({
          table: db!.table_name,
          columns: db!.columns,
          foreignTable: db!.foreign_table,
          foreignColumns: db!.foreign_columns,
          onDelete: ON_DELETE[db!.on_delete],
        });
      }
    }

    const notDeclared = dbForeignKeys.map((fk) => fk.conname).filter((name) => !declared.has(name)).sort();
    expect(notDeclared).toEqual([...SQL_ONLY_FOREIGN_KEYS].sort());
    expect(byName.get("lead_events_sale_fk")).toMatchObject({
      table_name: "lead_events",
      columns: ["lead_id", "sale_id"],
      foreign_table: "sales",
      foreign_columns: ["lead_id", "id"],
      on_delete: "r",
    });
  });

  it("índices (inclusive PK e UNIQUE): os do Drizzle existem iguais no banco; nenhum índice só no SQL sem registro", async () => {
    const dbIndexes = await rows<DbIndex>(sql`
      select i.relname as indexname, t.relname as table_name, x.indisunique as is_unique,
             x.indpred is not null as is_partial,
             (select json_agg(a.attname order by k.i) from unnest(x.indkey::int2[]) with ordinality k(n, i)
                left join pg_attribute a on a.attrelid = x.indrelid and a.attnum = k.n) as columns
        from pg_index x
        join pg_class i on i.oid = x.indexrelid
        join pg_class t on t.oid = x.indrelid
       where t.relnamespace = 'public'::regnamespace and t.relkind = 'r'`);
    const byName = new Map(dbIndexes.map((ix) => [ix.indexname, ix]));

    const declared: DbIndex[] = [];
    for (const table of drizzleTables) {
      const primary = table.columns.filter((c) => c.primary).map((c) => c.name);
      if (primary.length > 0) {
        declared.push({ indexname: `${table.name}_pkey`, table_name: table.name, is_unique: true, is_partial: false, columns: primary });
      }
      for (const uc of table.uniqueConstraints) {
        declared.push({
          indexname: uc.getName() ?? "(UNIQUE sem nome no Drizzle)",
          table_name: table.name,
          is_unique: true,
          is_partial: false,
          columns: uc.columns.map((c) => c.name),
        });
      }
      for (const ix of table.indexes) {
        declared.push({
          indexname: ix.config.name!,
          table_name: table.name,
          is_unique: ix.config.unique,
          is_partial: ix.config.where !== undefined,
          // Expressão (ex.: lower(name)) aparece como null no banco.
          columns: ix.config.columns.map((c) => (is(c, SQL) ? null : (c as { name: string }).name)),
        });
      }
    }

    for (const ix of declared) expect(byName.get(ix.indexname), ix.indexname).toEqual(ix);
    const declaredNames = new Set(declared.map((ix) => ix.indexname));
    expect(dbIndexes.map((ix) => ix.indexname).filter((name) => !declaredNames.has(name))).toEqual(SQL_ONLY_INDEXES);
  });

  it("CHECKs: as do Drizzle existem no banco; as de Vendas estão todas declaradas; as do 003 só no SQL existem", async () => {
    const dbChecks = await rows<{ table_name: string; conname: string }>(sql`
      select rel.relname as table_name, con.conname
        from pg_constraint con join pg_class rel on rel.oid = con.conrelid
       where con.contype = 'c' and con.connamespace = 'public'::regnamespace`);
    const has = (table: string, name: string) => dbChecks.some((c) => c.table_name === table && c.conname === name);

    for (const table of drizzleTables) {
      for (const check of table.checks) expect(has(table.name, check.name), `${table.name}.${check.name}`).toBe(true);
    }
    for (const tableName of ["sales", "sale_items", "sale_events"]) {
      const declared = drizzleTables.find((t) => t.name === tableName)!.checks.map((c) => c.name).sort();
      const inDb = dbChecks.filter((c) => c.table_name === tableName).map((c) => c.conname).sort();
      expect(declared, tableName).toEqual(inDb);
    }
    for (const [table, names] of Object.entries(SQL_ONLY_SALE_CHECKS)) {
      for (const name of names) expect(has(table, name), `${table}.${name}`).toBe(true);
    }
  });

  it("Data API do Supabase bloqueada: RLS ligado e sem acesso para anon/authenticated", async () => {
    const rls = await rows<{ relname: string; relrowsecurity: boolean }>(
      sql`select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname`,
    );
    expect(rls.map((t) => t.relname)).toEqual(EXPECTED_TABLES);
    for (const table of rls) expect(table.relrowsecurity, table.relname).toBe(true);

    const grants = await rows<{ grantee: string }>(
      sql`select grantee from information_schema.role_table_grants
          where table_schema = 'public' and grantee in ('anon', 'authenticated')`,
    );
    expect(grants).toEqual([]);

    const sequences = await rows<{ relname: string }>(sql`
      select relname from pg_class
       where relnamespace = 'public'::regnamespace and relkind = 'S'
         and (has_sequence_privilege('anon', oid, 'USAGE,SELECT,UPDATE')
              or has_sequence_privilege('authenticated', oid, 'USAGE,SELECT,UPDATE'))`);
    expect(sequences).toEqual([]);

    const functions = await rows<{ proname: string }>(sql`
      select proname from pg_proc
       where pronamespace = 'public'::regnamespace
         and (has_function_privilege('anon', oid, 'EXECUTE') or has_function_privilege('authenticated', oid, 'EXECUTE'))`);
    expect(functions).toEqual([]);
  });
});

describe("integridade garantida pelo banco (defesa em profundidade)", () => {
  it("audit_events é append-only", async () => {
    await recordAudit(handle.db, { actorId: org.ids.admin, action: "user.updated", entityType: "user" });
    await expect(handle.db.update(auditEvents).set({ action: "adulterado" })).rejects.toThrow();
    await expect(handle.db.delete(auditEvents)).rejects.toThrow();
  });

  it("papel do usuário é imutável", async () => {
    await expect(handle.db.update(users).set({ role: "ADMIN" }).where(eq(users.id, org.ids.sellerA1))).rejects.toThrow();
  });

  it("apenas vendedores podem ter equipe", async () => {
    await expect(handle.db.update(users).set({ teamId: org.ids.teamA }).where(eq(users.id, org.ids.supB))).rejects.toThrow();
  });

  it("supervisor de equipe precisa ter papel SUPERVISOR", async () => {
    await expect(handle.db.update(teams).set({ supervisorId: org.ids.sellerA1 }).where(eq(teams.id, org.ids.teamA))).rejects.toThrow();
  });

  it("e-mail precisa estar normalizado em minúsculas", async () => {
    await expect(insertUser(handle, { name: "X", role: "ADMIN", email: "Maiusculo@Teste.Local" })).rejects.toThrow();
  });
});
