# PostgreSQL TypeScript Migrations

The TypeScript runtime owns PostgreSQL schema creation through `src/infrastructure/postgres/migrations.ts` and `src/infrastructure/postgres/schemaMigrations.ts`.

Run migrations with:

```bash
vp run migrate
```

`DATABASE_URL` must point at the target PostgreSQL database. Applied migrations are recorded in `schema_migrations`.
The runner takes a transaction-scoped PostgreSQL advisory lock before reading or applying migrations, so concurrent deploy hooks serialize instead of racing on the `schema_migrations` primary key.

If a database already contains Alembic metadata, the TypeScript migration runner refuses to baseline it by default. After validating that the existing schema is at the expected Alembic head, set:

```bash
POSTGRES_ALLOW_ALEMBIC_BASELINE=true
```

This records mirrored TypeScript migrations through the detected Alembic revision, then applies any later TypeScript migrations normally.

## Migration Policy

- New application migrations should be added to `schemaMigrations.ts`.
- Migration SQL describes the current TypeScript-owned schema. Removed feature tables are omitted, but legacy migration ids may remain as no-op placeholders when deployed Alembic or schema baselines need those ids for compatibility.
- The migration SQL creates the current schema for Slack installations, routing settings, OAuth state/connections, Salesforce OAuth, workspace credentials, and RSS feed processing.
- OAuth state consumption uses a delete-returning operation so callback state cannot be replayed after a successful consume.

## Rollout Notes

Before production schema rollout:

1. Run `vp run migrate` against a staging copy of production data.
2. Verify Slack OAuth install/fetch, thread routing settings, OAuth state reads/writes, and RSS feed reads/writes against the migrated database.
3. Take a production backup before running migrations in production.

Rollback is database-backup based for destructive cutover work. These TypeScript migrations are additive/idempotent and do not drop legacy tables.

Set `TEST_DATABASE_URL` to run the gated PostgreSQL integration test that applies the TypeScript migrations in an isolated schema and round-trips a JSON-backed repository through `pg`.
