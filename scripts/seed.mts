/**
 * Popula o banco com uma estrutura organizacional FICTÍCIA para testes:
 * 1 administrador, 4 supervisores (cada um com sua equipe) e 10 vendedores por
 * equipe. Todos usam a senha definida em SEED_PASSWORD (padrão: Senha@123).
 */
import { loadEnv } from "./env.mjs";

loadEnv();

if (process.env.NODE_ENV === "production" && !process.argv.includes("--force")) {
  console.error("Seed bloqueado em produção. Use --force se tiver certeza.");
  process.exit(1);
}

const { connectDatabase } = await import("@/server/db/connect");
const { hashPassword } = await import("@/server/auth/password");
const { teams, users } = await import("@/server/db/schema");

const PASSWORD = process.env.SEED_PASSWORD || "Senha@123";
const TEAMS = ["Equipe Alfa", "Equipe Beta", "Equipe Gama", "Equipe Delta"];
const SUPERVISORS = ["Ana Souza", "Bruno Lima", "Carla Mendes", "Diego Rocha"];
const FIRST_NAMES = ["Lucas", "Mariana", "Pedro", "Juliana", "Rafael", "Camila", "Thiago", "Fernanda", "Gabriel", "Larissa"];
const LAST_NAMES = ["Alves", "Barbosa", "Costa", "Dias", "Ferreira", "Gomes", "Martins", "Nunes"];

const slug = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, ".");

const handle = connectDatabase();
const { db } = handle;

const existing = await db.select({ id: users.id }).from(users).limit(1);
if (existing.length > 0) {
  console.log("O banco já possui usuários; seed ignorado. Use `npm run db:reset` para recomeçar do zero.");
  await handle.close();
  process.exit(0);
}

await db.transaction(async (tx) => {
  const newUser = async (name: string, email: string, role: "ADMIN" | "SUPERVISOR" | "SELLER", teamId: string | null = null) => {
    const [row] = await tx
      .insert(users)
      .values({ name, email, role, teamId, passwordHash: await hashPassword(PASSWORD) })
      .returning({ id: users.id });
    return row.id;
  };

  await newUser("Administrador", "admin@polo.local", "ADMIN");

  for (const [i, teamName] of TEAMS.entries()) {
    const supervisorName = SUPERVISORS[i];
    const supervisorId = await newUser(supervisorName, `${slug(supervisorName)}@polo.local`, "SUPERVISOR");
    const [team] = await tx.insert(teams).values({ name: teamName, supervisorId }).returning({ id: teams.id });

    for (let s = 0; s < 10; s++) {
      const name = `${FIRST_NAMES[s]} ${LAST_NAMES[(s + i * 3) % LAST_NAMES.length]}`;
      await newUser(name, `${slug(name)}.${slug(teamName.split(" ")[1])}@polo.local`, "SELLER", team.id);
    }
  }
});

await handle.close();
console.log(`Seed concluído: 1 admin, ${TEAMS.length} supervisores/equipes, ${TEAMS.length * 10} vendedores.`);
console.log(`Login de exemplo: admin@polo.local / ${PASSWORD}`);
console.log(`Supervisor: ana.souza@polo.local · Vendedor: lucas.alves.alfa@polo.local`);
