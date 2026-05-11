import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

export type PostgresMigration = {
  id: string;
  name: string;
  upSql: string;
};

export type AppliedMigration = {
  appliedAt: Date;
  id: string;
  name: string;
};

export type PostgresMigrationRunnerOptions = {
  allowAlembicBaseline?: boolean;
  databaseUrl?: string;
  pool?: Pool;
};

export class AlembicBaselineRequiredError extends Error {
  constructor(readonly alembicVersion: string | undefined) {
    super(
      alembicVersion === undefined
        ? "Existing Alembic metadata was detected. Set POSTGRES_ALLOW_ALEMBIC_BASELINE=true only after validating schema parity."
        : `Existing Alembic revision '${alembicVersion}' was detected. Set POSTGRES_ALLOW_ALEMBIC_BASELINE=true only after validating schema parity.`,
    );
    this.name = "AlembicBaselineRequiredError";
  }
}

type Queryable = {
  query<TResult extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<TResult>>;
};

export class PostgresMigrationRunner {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;

  constructor(private readonly options: PostgresMigrationRunnerOptions) {
    if (options.pool === undefined && options.databaseUrl === undefined) {
      throw new Error("databaseUrl or pool is required for PostgreSQL migrations.");
    }
    this.pool = options.pool ?? new Pool({ connectionString: options.databaseUrl });
    this.ownsPool = options.pool === undefined;
  }

  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  async listApplied(): Promise<AppliedMigration[]> {
    await ensureMigrationTable(this.pool);
    const result = await this.pool.query<{
      applied_at: Date;
      id: string;
      name: string;
    }>(
      `select id, name, applied_at
       from schema_migrations
       order by id`,
    );
    return result.rows.map((row) => ({
      appliedAt: row.applied_at,
      id: row.id,
      name: row.name,
    }));
  }

  async migrate(migrations: readonly PostgresMigration[]): Promise<AppliedMigration[]> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await acquireMigrationLock(client);
      await ensureMigrationTable(client);
      await baselineAlembicIfNeeded(client, migrations, this.options.allowAlembicBaseline ?? false);
      const applied = await appliedMigrationIds(client);
      const newlyApplied: AppliedMigration[] = [];

      for (const migration of migrations) {
        if (applied.has(migration.id)) {
          continue;
        }
        await client.query(migration.upSql);
        await client.query(
          `insert into schema_migrations (id, name, applied_at)
           values ($1, $2, now())`,
          [migration.id, migration.name],
        );
        newlyApplied.push({
          appliedAt: new Date(),
          id: migration.id,
          name: migration.name,
        });
      }

      await client.query("commit");
      return newlyApplied;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

async function ensureMigrationTable(queryable: Queryable): Promise<void> {
  await queryable.query(`
    create table if not exists schema_migrations (
      id text primary key,
      name text not null,
      applied_at timestamp with time zone not null
    )
  `);
}

async function acquireMigrationLock(client: PoolClient): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    "agents_party_schema_migrations",
  ]);
}

async function appliedMigrationIds(client: PoolClient): Promise<Set<string>> {
  const result = await client.query<{ id: string }>("select id from schema_migrations");
  return new Set(result.rows.map((row) => row.id));
}

async function baselineAlembicIfNeeded(
  client: PoolClient,
  migrations: readonly PostgresMigration[],
  allowBaseline: boolean,
): Promise<void> {
  if ((await appliedMigrationIds(client)).size > 0) {
    return;
  }

  const alembicVersion = await readAlembicVersion(client);
  if (alembicVersion === undefined) {
    return;
  }
  if (!allowBaseline) {
    throw new AlembicBaselineRequiredError(alembicVersion);
  }

  const baselineIndex = migrations.findIndex((migration) => migration.id === alembicVersion);
  if (baselineIndex === -1) {
    throw new AlembicBaselineRequiredError(alembicVersion);
  }

  for (const migration of migrations.slice(0, baselineIndex + 1)) {
    await client.query(
      `insert into schema_migrations (id, name, applied_at)
       values ($1, $2, now())
       on conflict (id) do nothing`,
      [migration.id, migration.name],
    );
  }
}

async function readAlembicVersion(client: PoolClient): Promise<string | undefined> {
  const exists = await client.query<{ exists: boolean }>(
    `select exists (
       select 1
       from information_schema.tables
       where table_schema = current_schema()
         and table_name = 'alembic_version'
     )`,
  );
  if (exists.rows[0]?.exists !== true) {
    return undefined;
  }
  const result = await client.query<{ version_num: string }>(
    "select version_num from alembic_version limit 1",
  );
  return result.rows[0]?.version_num;
}
