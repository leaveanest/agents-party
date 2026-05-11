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

type Queryable = {
  query<TResult extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<TResult>>;
};

export class PostgresMigrationRunner {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;

  constructor(options: { databaseUrl?: string; pool?: Pool }) {
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
      await ensureMigrationTable(client);
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

async function appliedMigrationIds(client: PoolClient): Promise<Set<string>> {
  const result = await client.query<{ id: string }>("select id from schema_migrations");
  return new Set(result.rows.map((row) => row.id));
}
