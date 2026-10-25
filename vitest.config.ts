import { configDefaults, defineConfig } from "vitest/config";

// Database tests need a Postgres server, so they run on their own: npm run test:db.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "test/db/**"] },
});
