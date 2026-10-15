import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

// Build para a Cloudflare: o OpenNext (`npm run cf:build`) roda o `next build`
// em modo standalone. Nesse build o PGlite (banco local em WASM) é trocado por
// um stub: o Worker só usa o PostgreSQL via Hyperdrive.
const cloudflareBuild = process.env.NEXT_PRIVATE_STANDALONE === "true";

const nextConfig: NextConfig = {
  // Todas as telas do CRM dependem do usuário logado e precisam de dados
  // atuais; por isso o app usa renderização dinâmica sem Cache Components.
  cacheComponents: false,
  // O PGlite carrega arquivos WASM em tempo de execução e não deve ser empacotado.
  serverExternalPackages: cloudflareBuild ? [] : ["@electric-sql/pglite"],
  // O `pg` carrega `pg-cloudflare` (sockets do Workers) só em tempo de execução,
  // pela condição "workerd"; o rastreamento do Next copiaria apenas o stub vazio.
  outputFileTracingIncludes: cloudflareBuild ? { "/**": ["./node_modules/pg-cloudflare/**/*"] } : {},
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  turbopack: {
    resolveAlias: cloudflareBuild ? { "@electric-sql/pglite": "./src/server/db/pglite-unavailable.ts" } : {},
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
