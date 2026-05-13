import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  PostgresJsonDocumentRepository,
  postgresDocumentTables,
} from "../../../src/infrastructure/postgres/jsonDocumentRepository.js";
import { PostgresMigrationRunner } from "../../../src/infrastructure/postgres/migrations.js";
import { postgresMigrations } from "../../../src/infrastructure/postgres/schemaMigrations.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeIfPostgres = databaseUrl === undefined ? describe.skip : describe;

describeIfPostgres("PostgreSQL TypeScript persistence integration", () => {
  const schemaName = `agents_party_test_${randomUUID().replace(/-/gu, "_")}`;
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrl });
    await adminPool.query(`create schema "${schemaName}"`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName}`,
    });
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.query(`drop schema if exists "${schemaName}" cascade`);
    await adminPool?.end();
  });

  it("runs TypeScript migrations and round-trips JSON document repositories", async () => {
    const runner = new PostgresMigrationRunner({ pool });
    await runner.migrate(postgresMigrations);

    const repository = new PostgresJsonDocumentRepository<
      { agent_id: string },
      { agent_id: string; enabled: boolean }
    >(postgresDocumentTables.agent, { pool });
    await repository.upsert({
      key: { agent_id: "assistant" },
      payload: { agent_id: "assistant", enabled: true },
      values: {
        enabled: true,
        updated_at: new Date("2026-05-11T00:00:00Z"),
      },
    });

    await expect(repository.find({ agent_id: "assistant" })).resolves.toEqual({
      agent_id: "assistant",
      enabled: true,
      updated_at: "2026-05-11T00:00:00.000Z",
    });
  });
});
