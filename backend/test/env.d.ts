import type { D1Migration } from "@cloudflare/vitest-pool-workers";

declare global {
  namespace Cloudflare {
    interface Env {
      // Provided by vitest.config.ts via miniflare bindings; tests only.
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
