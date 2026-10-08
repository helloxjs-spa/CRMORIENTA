/**
 * Popula o banco com dados FICTÍCIOS para testes. Cada bloco só roda se a
 * tabela correspondente estiver vazia:
 * - Organização: 1 administrador, 4 supervisores (cada um com sua equipe) e
 *   10 vendedores por equipe, todos com a senha SEED_PASSWORD (padrão: Senha@123).
 * - Cursos: alguns cursos (inclusive o mesmo curso em duas instituições) com
 *   custos de bolsa ilustrativos.
 *
 * Por padrão só roda no PGlite local. Contra o Supabase exige --allow-remote,
 * pois cria usuários fictícios com senha conhecida no banco real.
 */
import { loadEnv } from "./env.mjs";

loadEnv();

const databaseUrl = process.env.DATABASE_URL ?? "";
if (databaseUrl && !databaseUrl.startsWith("pglite://") && !process.argv.includes("--allow-remote")) {
  console.error(
    "Seed bloqueado: a DATABASE_URL aponta para um PostgreSQL remoto (Supabase). " +
      "Ele criaria usuários fictícios com senha conhecida. Se for realmente isso, rode: npm run db:seed -- --allow-remote",
  );
  process.exit(1);
}

if (process.env.NODE_ENV === "production" && !process.argv.includes("--force")) {
  console.error("Seed bloqueado em produção. Use --force se tiver certeza.");
  process.exit(1);
}

const { connectDatabase } = await import("@/server/db/connect");
const { hashPassword } = await import("@/server/auth/password");
const { courseCosts, courses, teams, users } = await import("@/server/db/schema");

const PASSWORD = process.env.SEED_PASSWORD || "Senha@123";
const TEAMS = ["Equipe Alfa", "Equipe Beta", "Equipe Gama", "Equipe Delta"];
const SUPERVISORS = ["Ana Souza", "Bruno Lima", "Carla Mendes", "Diego Rocha"];
const FIRST_NAMES = ["Lucas", "Mariana", "Pedro", "Juliana", "Rafael", "Camila", "Thiago", "Fernanda", "Gabriel", "Larissa"];
const LAST_NAMES = ["Alves", "Barbosa", "Costa", "Dias", "Ferreira", "Gomes", "Martins", "Nunes"];
// [curso, instituição, custo da bolsa em centavos, ativo]
const COURSES: [string, string, number, boolean][] = [
  ["Administração", "Faculdade Alpha", 280_00, true],
  ["Ciências Contábeis", "Faculdade Alpha", 260_00, true],
  ["Direito", "Universidade Gama", 450_00, true],
  ["Enfermagem", "Universidade Gama", 390_00, true],
  ["Pedagogia", "Faculdade Alpha", 300_00, true],
  ["Pedagogia", "Faculdade Beta", 420_00, true],
  ["Psicologia", "Faculdade Beta", 420_00, true],
  ["Gestão de Recursos Humanos", "Faculdade Beta", 220_00, true],
  ["Letras", "Faculdade Alpha", 180_00, false],
];

const slug = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, ".");

const handle = connectDatabase();
const { db } = handle;

const hasUsers = (await db.select({ id: users.id }).from(users).limit(1)).length > 0;
if (hasUsers) {
  console.log("Organização: o banco já possui usuários; bloco ignorado.");
} else {
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
  console.log(`Organização: 1 admin, ${TEAMS.length} supervisores/equipes, ${TEAMS.length * 10} vendedores.`);
}

const hasCourses = (await db.select({ id: courses.id }).from(courses).limit(1)).length > 0;
if (hasCourses) {
  console.log("Cursos: já existem cursos; bloco ignorado.");
} else {
  await db.transaction(async (tx) => {
    for (const [name, institutionName, costCents, active] of COURSES) {
      const [course] = await tx.insert(courses).values({ name, institutionName, active }).returning({ id: courses.id });
      await tx.insert(courseCosts).values({ courseId: course.id, costCents });
    }
  });
  console.log(`Cursos: ${COURSES.length} cursos fictícios.`);
}

await handle.close();
console.log("Seed concluído.");
console.log(`Login de exemplo: admin@polo.local / ${PASSWORD}`);
console.log(`Supervisor: ana.souza@polo.local · Vendedor: lucas.alves.alfa@polo.local`);
