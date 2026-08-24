import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./shared/schema/index.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/niko",
  },
});
