/**
 * npm run admin:create — cria o PRIMEIRO administrador do CRM no banco da
 * DATABASE_URL (normalmente o Supabase). Somente inserção de dados; não altera
 * schema e não usa Supabase Auth.
 *
 * Segurança: a senha é lida sem eco, nunca é aceita por argumento, arquivo ou
 * pipe, nunca é impressa nem registrada. Mensagens de erro do banco não são
 * repassadas (podem conter host/usuário); mostra-se apenas o código do erro.
 */
import { createInterface } from "node:readline/promises";
import { loadEnv } from "./env.mjs";

loadEnv();

class Cancelled extends Error {}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("admin:create precisa ser executado num terminal interativo (a senha não pode vir de pipe ou arquivo).");
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL não está definida no .env.");
  process.exit(1);
}

const { connectDatabase } = await import("@/server/db/connect");
const { describeDatabaseTarget } = await import("@/server/db/target");
const { BOOTSTRAP_DONE_MESSAGE, adminExists, bootstrapFirstAdmin, parseBootstrapInput } = await import("@/server/auth/bootstrap");
const { AppError, ValidationError } = await import("@/server/errors");

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } catch {
    throw new Cancelled();
  } finally {
    rl.close();
  }
}

function askHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (ch === "\u0003" || ch === "\u0004") {
          cleanup();
          reject(new Cancelled());
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
        } else if (ch === "\u001b") {
          return; // teclas especiais (setas etc.): ignora o restante da sequência
        } else if (ch >= " ") {
          value += ch;
        }
      }
    };
    process.stdout.write(question);
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

function errorCode(error: unknown): string {
  for (let e: unknown = error; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "desconhecido";
}

const target = describeDatabaseTarget(databaseUrl);
const handle = connectDatabase(databaseUrl);
let exitCode = 0;

try {
  console.log("\nCRM Polo Educacional — criação do primeiro administrador\n");
  console.log("Banco de destino:");
  for (const line of target.lines) console.log(`  ${line}`);
  console.log("");

  if (await adminExists(handle.db)) {
    console.log(BOOTSTRAP_DONE_MESSAGE);
    exitCode = 1;
  } else {
    const name = await ask("Nome completo: ");
    const email = await ask("E-mail: ");
    const password = await askHidden("Senha (não aparece ao digitar): ");
    const confirmation = await askHidden("Confirme a senha: ");

    if (password !== confirmation) {
      console.error("\nAs senhas não conferem. Nada foi criado.");
      exitCode = 1;
    } else {
      const data = parseBootstrapInput({ name, email, password });
      console.log("\nResumo:");
      console.log(`  Nome:   ${data.name}`);
      console.log(`  E-mail: ${data.email}`);
      console.log("  Perfil: ADMIN (sem equipe, ativo)\n");

      const where = target.remote ? "no banco remoto configurado" : "no banco local configurado";
      const answer = (await ask(`Será criado o primeiro administrador ${where}. Continuar? [s/N] `)).trim().toLowerCase();
      if (answer !== "s" && answer !== "sim") {
        console.log("Cancelado. Nada foi criado.");
        exitCode = 1;
      } else {
        const created = await bootstrapFirstAdmin(handle.db, { name, email, password });
        console.log(`\nAdministrador criado. Faça login no CRM com o e-mail ${created.email}.`);
      }
    }
  }
} catch (error) {
  exitCode = 1;
  if (error instanceof Cancelled) {
    console.error("\nCancelado. Nada foi criado.");
  } else if (error instanceof ValidationError) {
    console.error("\nDados inválidos. Nada foi criado:");
    for (const [field, messages] of Object.entries(error.fieldErrors)) {
      const label = { name: "Nome", email: "E-mail", password: "Senha" }[field] ?? field;
      for (const message of messages) console.error(`  ${label}: ${message}`);
    }
  } else if (error instanceof AppError) {
    console.error(`\n${error.message} Nada foi criado.`);
  } else {
    console.error(`\nFalha ao acessar o banco (código: ${errorCode(error)}). Nada foi criado.`);
    console.error("Verifique a DATABASE_URL no .env (connection string do Supabase com ?sslmode=require).");
  }
} finally {
  await handle.close().catch(() => {});
}

process.exit(exitCode);
