import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { connectDatabase, type DatabaseHandle } from "./connect";
import type { Database } from "./types";

// A conexão é aberta apenas no primeiro uso (não na importação do módulo), para
// que o build do Next — que importa as rotas em vários workers — não abra o
// banco.
//
// Node (next dev / next start): o handle fica em globalThis para sobreviver a
// recargas em dev (o PGlite não suporta duas instâncias no mesmo diretório).
//
// Cloudflare Workers: sockets de uma requisição não podem ser usados em outra,
// então cada requisição tem o próprio handle (chaveado pelo contexto da
// requisição que o OpenNext guarda em AsyncLocalStorage). A conexão vem do
// binding HYPERDRIVE; DATABASE_URL (secret) só como alternativa sem Hyperdrive.
const globalForDb = globalThis as unknown as { __crmDb?: DatabaseHandle };
const perRequest = new WeakMap<object, DatabaseHandle>();

type WorkerEnv = { HYPERDRIVE?: { connectionString: string }; DATABASE_URL?: string };

function cloudflareRequest(): { env: WorkerEnv } | null {
  try {
    return getCloudflareContext() as unknown as { env: WorkerEnv };
  } catch {
    return null; // fora do Workers (next dev, next start, scripts)
  }
}

function getHandle(): DatabaseHandle {
  const request = cloudflareRequest();
  if (request) {
    let handle = perRequest.get(request);
    if (!handle) {
      const url = request.env.HYPERDRIVE?.connectionString ?? request.env.DATABASE_URL;
      if (!url) throw new Error("Banco não configurado: defina o binding HYPERDRIVE (ou o secret DATABASE_URL).");
      handle = connectDatabase(url, { perRequest: true });
      perRequest.set(request, handle);
    }
    return handle;
  }
  return (globalForDb.__crmDb ??= connectDatabase());
}

export const db: Database = new Proxy({} as Database, {
  get(_target, property) {
    const target = getHandle().db;
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
