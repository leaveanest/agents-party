import { describe, expect, it } from "vite-plus/test";

import {
  PostgresJsonDocumentRepository,
  postgresDocumentTables,
} from "../../../src/infrastructure/postgres/jsonDocumentRepository.js";

describe("PostgresJsonDocumentRepository", () => {
  it("upserts payload-backed records with explicit key and index columns", async () => {
    const pool = new RecordingPool();
    const repository = new PostgresJsonDocumentRepository<
      { team_id: string; work_item_id: string },
      { title: string }
    >(postgresDocumentTables.workItem, { pool: pool as never });

    await repository.upsert({
      key: { team_id: "T1", work_item_id: "W1" },
      payload: { title: "Ship TypeScript persistence" },
      values: {
        status: "open",
        title: "Ship TypeScript persistence",
        updated_at: new Date("2026-05-11T00:00:00Z"),
        visibility_kind: "channel",
      },
    });

    expect(pool.queries[0]?.text).toContain('insert into "work_items"');
    expect(pool.queries[0]?.text).toContain('on conflict ("team_id", "work_item_id")');
    expect(pool.queries[0]?.values?.slice(0, 2)).toEqual(["T1", "W1"]);
    expect(pool.queries[0]?.values?.at(-1)).toBe(
      JSON.stringify({ title: "Ship TypeScript persistence" }),
    );
  });

  it("rejects unsafe SQL identifiers in table metadata", () => {
    expect(
      () =>
        new PostgresJsonDocumentRepository(
          {
            keyColumns: ["team_id"],
            tableName: "work_items; drop table users",
          },
          { pool: new RecordingPool() as never },
        ),
    ).toThrow("Unsafe SQL identifier");
  });

  it("consumes payload-backed records atomically with delete returning", async () => {
    const pool = new RecordingPool([{ payload: { state: "stored" } }]);
    const repository = new PostgresJsonDocumentRepository<
      { state_id: string; team_id: string },
      { state: string }
    >(postgresDocumentTables.googleOAuthState, { pool: pool as never });

    const payload = await repository.consume({ state_id: "S1", team_id: "T1" });

    expect(payload).toEqual({ state: "stored" });
    expect(pool.queries[0]?.text).toContain('delete from "google_oauth_states"');
    expect(pool.queries[0]?.text).toContain('returning "payload" as payload');
  });
});

class RecordingPool {
  readonly queries: Array<{ text: string; values?: unknown[] }> = [];

  constructor(private readonly rows: unknown[] = []) {}

  async query(text: string, values?: unknown[]) {
    this.queries.push({ text: normalizeSql(text), values });
    return { rows: this.rows };
  }
}

function normalizeSql(sql: string): string {
  return sql.trim().replace(/\s+/gu, " ");
}
