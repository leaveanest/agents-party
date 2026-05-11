import { PostgresMigrationRunner } from "./migrations.js";
import { postgresMigrations } from "./schemaMigrations.js";

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined || databaseUrl.trim() === "") {
  console.error("DATABASE_URL is required to run PostgreSQL migrations.");
  process.exit(1);
}

const runner = new PostgresMigrationRunner({ databaseUrl });

try {
  const applied = await runner.migrate(postgresMigrations);
  for (const migration of applied) {
    console.log(`applied ${migration.id} ${migration.name}`);
  }
  if (applied.length === 0) {
    console.log("database schema is already up to date");
  }
} finally {
  await runner.close();
}
