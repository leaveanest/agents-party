import { PostgresMigrationRunner } from "./migrations.js";
import { postgresMigrations } from "./schemaMigrations.js";

const databaseBackend = process.env.APP_DATABASE_BACKEND?.trim() || "postgres";
const databaseUrl = process.env.DATABASE_URL;

if (databaseBackend !== "postgres") {
  console.error("APP_DATABASE_BACKEND=postgres is required to run PostgreSQL migrations.");
  process.exit(1);
}

if (databaseUrl === undefined || databaseUrl.trim() === "") {
  console.error("DATABASE_URL is required to run PostgreSQL migrations.");
  process.exit(1);
}

const runner = new PostgresMigrationRunner({
  allowAlembicBaseline: process.env.POSTGRES_ALLOW_ALEMBIC_BASELINE === "true",
  databaseUrl,
});

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
