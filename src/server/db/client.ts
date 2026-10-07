import "server-only";
import { connectDatabase, type DatabaseHandle } from "./connect";
import type { Database } from "./types";

// A conexão é aberta apenas no primeiro uso (não na importação do módulo), para
// que o build do Next — que importa as rotas em vários workers — não abra o
// banco. O handle fica em globalThis para sobreviver a recargas em dev: o
// PGlite não suporta duas instâncias abertas no mesmo diretório.
const globalForDb = globalThis as unknown as { __crmDb?: DatabaseHandle };

function getHandle(): DatabaseHandle {
  return (globalForDb.__crmDb ??= connectDatabase());
}

export const db: Database = new Proxy({} as Database, {
  get(_target, property) {
    const target = getHandle().db;
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
