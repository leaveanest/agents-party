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
    expect(client.sql).toContain("begin");
    expect(client.sql).toContain("select pg_advisory_xact_lock(hashtextextended($1, 0))");
    expect(client.sql).toContain("select new_migration");
    expect(client.sql).toContain("commit");
    expect(client.released).toBe(true);
  });

  it("keeps TypeScript migration definitions aligned with the current schema", () => {
    expect(postgresMigrations.map((migration) => migration.id)).toEqual([
      "20260330_0001",
      "20260508_0002",
      "20260508_0003",
      "20260512_0004",
      "20260512_0005",
      "20260512_0006",
      "20260513_0007",
      "20260515_0008",
    ]);
    expect(postgresMigrations[0]?.upSql).toContain(
      "create table if not exists slack_installations",
    );
    expect(postgresMigrations[1]?.upSql).toContain(
      "create table if not exists salesforce_connections",
    );
    expect(postgresMigrations[2]?.upSql).not.toContain("work_item_calendar_links");
    expect(postgresMigrations[3]?.upSql).toContain("add column if not exists default_model_id");
    expect(postgresMigrations[3]?.upSql).toContain("payload ->> 'default_model_id'");
    expect(postgresMigrations[3]?.upSql).toContain("payload ->> 'model_scope' = 'thread'");
    expect(postgresMigrations[4]?.upSql).toContain(
      "create table if not exists workspace_credentials",
    );
    expect(postgresMigrations[5]?.upSql).toContain(
      "create table if not exists rss_feed_subscriptions",
    );
    expect(postgresMigrations[5]?.upSql).toContain(
      "create table if not exists rss_processed_articles",
    );
    expect(postgresMigrations[6]?.upSql).toContain(
      "create table if not exists salesforce_pdf_workflow_settings",
    );
    expect(postgresMigrations[6]?.upSql).toContain(
      "create table if not exists salesforce_pdf_templates",
    );
    expect(postgresMigrations[7]?.upSql).toContain("create table if not exists app_user_settings");
    expect(postgresMigrations[7]?.upSql).toContain(
      "primary key (scope_kind, scope_id, slack_user_id)",
    );
    expect(postgresMigrations[7]?.upSql).toContain("scope_kind in ('enterprise', 'team')");
    expect(postgresMigrations[7]?.upSql).toContain("locale in ('ja', 'en')");
  });

  it("requires explicit Alembic baseline when legacy metadata is present", async () => {
    const client = new RecordingClient([], "legacy_removed_revision");
    const pool = {
      connect: async () => client,
      end: async () => undefined,
      query: client.query.bind(client),
    };
    const runner = new PostgresMigrationRunner({ pool: pool as never });

    await expect(
      runner.migrate([{ id: "20260330_0001", name: "initial", upSql: "select should_not_run" }]),
    ).rejects.toThrow("Existing Alembic revision");
    expect(client.sql).toContain("rollback");
  });

  it("baselines through the removed work-item Alembic revision and applies remaining migrations", async () => {
    const client = new RecordingClient([], "20260508_0003");
    const pool = {
      connect: async () => client,
      end: async () => undefined,
      query: client.query.bind(client),
    };
    const runner = new PostgresMigrationRunner({
      allowAlembicBaseline: true,
      pool: pool as never,
    });

    const applied = await runner.migrate([
      { id: "20260330_0001", name: "initial", upSql: "select initial" },
      { id: "20260508_0002", name: "salesforce", upSql: "select salesforce" },
      { id: "20260508_0003", name: "removed_work_items", upSql: "select removed_work_items" },
      { id: "20260512_0004", name: "model_routing", upSql: "select model_routing" },
    ]);

    expect(applied).toEqual([expect.objectContaining({ id: "20260512_0004" })]);
    expect(client.sql).not.toContain("select initial");
    expect(client.sql).not.toContain("select salesforce");
    expect(client.sql).not.toContain("select removed_work_items");
    expect(client.sql).toContain("select model_routing");
  });

  it("rejects Alembic baseline when the legacy revision is not mirrored", async () => {
    const client = new RecordingClient([], "20260511_unknown");
    const pool = {
      connect: async () => client,
      end: async () => undefined,
      query: client.query.bind(client),
    };
    const runner = new PostgresMigrationRunner({
      allowAlembicBaseline: true,
      pool: pool as never,
    });

    await expect(
      runner.migrate([{ id: "20260330_0001", name: "initial", upSql: "select should_not_run" }]),
    ).rejects.toThrow("Existing Alembic revision");
    expect(client.sql).not.toContain("select should_not_run");
    expect(client.sql).toContain("rollback");
  });
});

class RecordingClient {
  readonly sql: string[] = [];
  released = false;

  constructor(
    private readonly appliedRows: Array<{ id: string }> = [],
    private readonly alembicVersion?: string,
  ) {}

  async query(text: string, values?: unknown[]) {
    this.sql.push(normalizeSql(text));
    if (text.includes("select id from schema_migrations")) {
      return { rows: this.appliedRows };
    }
    if (text.includes("insert into schema_migrations") && typeof values?.[0] === "string") {
      this.appliedRows.push({ id: values[0] });
      return { rows: [] };
    }
    if (text.includes("information_schema.tables")) {
      return { rows: [{ exists: this.alembicVersion !== undefined }] };
    }
    if (text.includes("select version_num from alembic_version")) {
      return {
        rows: this.alembicVersion === undefined ? [] : [{ version_num: this.alembicVersion }],
      };
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
