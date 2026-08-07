import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./index";

await migrate(db, { migrationsFolder: "./migrations" });
console.log("Migrations applied.");
await pool.end();
