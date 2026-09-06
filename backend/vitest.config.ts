import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: path.join(import.meta.dirname, "wrangler.jsonc") },
      miniflare: {
        bindings: {
          // Exposed to tests so setup can apply migrations to the fresh D1.
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
          // Point Apple verification at the test JWKS served by the stubbed
          // fetch in test/apple.ts instead of appleid.apple.com.
          APPLE_JWKS_URL: "https://apple-jwks.test/keys",
          APPLE_CLIENT_IDS: "com.effoff.test-ios,com.effoff.test-web",
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
