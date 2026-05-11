import { describe, expect, it } from "vite-plus/test";

import { PostgresMigrationRunner } from "../../../src/infrastructure/postgres/migrations.js";
import { postgresMigrations } from "../../../src/infrastructure/postgres/schemaMigrations.js";

describe("PostgresMigrationRunner", () => {
  it("applies unapplied migrations in one transaction and records them", async () => {
    const client = new RecordingClient([{ id: "20260330_0001" }]);
    const pool = {
      connect: async () => client,
      end: async () => undefined,
      query: client.query.bind(client),
    };
    const runner = new PostgresMigrationRunner({ pool: pool as never });

    const applied = await runner.migrate([
      { id: "20260330_0001", name: "already_applied", upSql: "select already_applied" },
      { id: "20260508_0002", name: "new_migration", upSql: "select new_migration" },
    ]);

    expect(applied).toEqual([
      expect.objectContaining({ id: "20260508_0002", name: "new_migration" }),
    ]);
    expect(client.sql).toEqual([
      "begin",
      expect.stringContaining("create table if not exists schema_migrations"),
      "select id from schema_migrations",
      "select new_migration",
      expect.stringContaining("insert into schema_migrations"),
      "commit",
    ]);
    expect(client.released).toBe(true);
  });

  it("keeps TypeScript migration definitions aligned with the legacy Alembic sequence", () => {
    expect(postgresMigrations.map((migration) => migration.id)).toEqual([
      "20260330_0001",
      "20260508_0002",
      "20260508_0003",
    ]);
    expect(postgresMigrations[0]?.upSql).toContain(
      "create table if not exists slack_installations",
    );
    expect(postgresMigrations[1]?.upSql).toContain(
      "create table if not exists salesforce_connections",
    );
    expect(postgresMigrations[2]?.upSql).toContain(
      "create table if not exists work_item_calendar_links",
    );
  });
});

class RecordingClient {
  readonly sql: string[] = [];
  released = false;

  constructor(private readonly appliedRows: Array<{ id: string }> = []) {}

  async query(text: string) {
    this.sql.push(normalizeSql(text));
    if (text.includes("select id from schema_migrations")) {
      return { rows: this.appliedRows };
    }
    return { rows: [] };
  }

  release(): void {
    this.released = true;
  }
}

function normalizeSql(sql: string): string {
  return sql.trim().replace(/\s+/gu, " ");
}
