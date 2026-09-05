import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";

// TEST_MIGRATIONS is a test-only binding provided by vitest.config.ts; it is
// deliberately absent from the production Env type, so cast locally here
// instead of augmenting the global Cloudflare.Env.
const testEnv = env as typeof env & { TEST_MIGRATIONS: D1Migration[] };
await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
