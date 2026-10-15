import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Sem cache incremental: todas as telas do CRM são dinâmicas, por usuário
// (cacheComponents: false em next.config.ts), então não há o que guardar em R2/KV.
export default defineCloudflareConfig({});
