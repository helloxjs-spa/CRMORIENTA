import "server-only";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Armazenamento de arquivos (comprovantes de pagamento). Os dados do anexo
 * ficam no Postgres (sale_attachments); aqui fica só o conteúdo, pela chave.
 *
 * - Cloudflare Workers: bucket R2 privado, pelo binding RECEIPTS (wrangler.jsonc).
 * - Node (next dev / next start): pasta local .data/receipts (fora do git).
 * - Testes: memoryFileStorage().
 */
export type StoredFile = { bytes: Uint8Array; contentType: string };

export type FileStorage = {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<StoredFile | null>;
  /** Só para desfazer um envio cujo registro no banco falhou (o arquivo nunca ficou visível). */
  delete(key: string): Promise<void>;
};

/** Subconjunto da API do R2 usado aqui. */
type R2Bucket = {
  put(key: string, value: Uint8Array, options: { httpMetadata: { contentType: string } }): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: { contentType?: string } } | null>;
  delete(key: string): Promise<void>;
};

function r2Storage(bucket: R2Bucket): FileStorage {
  return {
    async put(key, bytes, contentType) {
      await bucket.put(key, bytes, { httpMetadata: { contentType } });
    },
    async get(key) {
      const object = await bucket.get(key);
      if (!object) return null;
      return { bytes: new Uint8Array(await object.arrayBuffer()), contentType: object.httpMetadata?.contentType ?? "application/octet-stream" };
    },
    async delete(key) {
      await bucket.delete(key);
    },
  };
}

/** Pasta local: o tipo vai num arquivo ao lado (`<chave>.type`). */
function localStorage(root: string): FileStorage {
  const fileOf = (key: string) => {
    const file = path.resolve(root, key);
    if (!file.startsWith(path.resolve(root) + path.sep)) throw new Error("Chave de arquivo inválida.");
    return file;
  };
  return {
    async put(key, bytes, contentType) {
      const file = fileOf(key);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
      await writeFile(`${file}.type`, contentType);
    },
    async get(key) {
      const file = fileOf(key);
      try {
        const [bytes, contentType] = await Promise.all([readFile(file), readFile(`${file}.type`, "utf8")]);
        return { bytes: new Uint8Array(bytes), contentType };
      } catch {
        return null;
      }
    },
    async delete(key) {
      const file = fileOf(key);
      await rm(file, { force: true });
      await rm(`${file}.type`, { force: true });
    },
  };
}

export function memoryFileStorage(): FileStorage & { keys(): string[] } {
  const files = new Map<string, StoredFile>();
  return {
    async put(key, bytes, contentType) {
      files.set(key, { bytes, contentType });
    },
    async get(key) {
      return files.get(key) ?? null;
    },
    async delete(key) {
      files.delete(key);
    },
    keys: () => [...files.keys()],
  };
}

const LOCAL_ROOT = path.join(process.cwd(), ".data", "receipts");

/** Armazenamento da requisição atual (R2 no Workers; pasta local fora dele). */
export function getFileStorage(): FileStorage {
  let env: { RECEIPTS?: R2Bucket } | null = null;
  try {
    env = (getCloudflareContext() as unknown as { env: { RECEIPTS?: R2Bucket } }).env;
  } catch {
    return localStorage(LOCAL_ROOT); // fora do Workers (next dev, next start)
  }
  if (!env.RECEIPTS) throw new Error("Armazenamento de comprovantes não configurado: defina o binding RECEIPTS (R2).");
  return r2Storage(env.RECEIPTS);
}
