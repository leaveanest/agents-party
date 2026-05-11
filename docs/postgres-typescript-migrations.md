# PostgreSQL TypeScript Migrations

The TypeScript runtime owns PostgreSQL schema creation through `src/infrastructure/postgres/migrations.ts` and `src/infrastructure/postgres/schemaMigrations.ts`.

Run migrations with:

```bash
vp run migrate
```

`DATABASE_URL` must point at the target PostgreSQL database. Applied migrations are recorded in `schema_migrations`.

If a database already contains Alembic metadata, the TypeScript migration runner refuses to baseline it by default. After validating that the existing schema is at the expected Alembic head, set:

```bash
POSTGRES_ALLOW_ALEMBIC_BASELINE=true
```

This records the mirrored TypeScript migrations without replaying table creation SQL.

## Migration Policy

- New application migrations should be added to `schemaMigrations.ts`.
- Migration ids keep the existing Alembic sequence so the TypeScript cutover can be reconciled against deployed databases.
- The migration SQL mirrors the current Alembic schema for Slack installations, routing settings, OAuth state/connections, work items, Salesforce OAuth, and work-item calendar links.
- Python/Alembic remains legacy only until OSA-16 removes the Python implementation. It is not the target migration path for new TypeScript work.
- OAuth state consumption uses a delete-returning operation so callback state cannot be replayed after a successful consume.

## Rollout Notes

Before Python removal:

1. Run `vp run migrate` against a staging copy of production data.
2. Compare table and index presence with the current Alembic head.
3. Verify Slack OAuth install/fetch, thread routing settings, OAuth state reads/writes, and work-item reads/writes against the migrated database.
4. Take a production backup before running migrations in production.

Rollback is database-backup based for destructive cutover work. These TypeScript migrations are additive/idempotent and do not drop legacy tables.
