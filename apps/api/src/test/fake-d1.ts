/**
 * In-memory stand-in for D1. Understands exactly the statement shapes
 * `src/data/d1.ts` emits (single-line INSERT with an explicit column list,
 * optional `ON CONFLICT(col)`, and SELECT with at most one `WHERE col = ?`),
 * which keeps the API testable in plain Node — no miniflare, no workerd.
 */
import type { SqlDatabase, SqlStatement } from "../data/d1.ts";

export type FakeRow = Record<string, unknown>;

const INSERT_RE = /^INSERT INTO (\w+) \(([^)]*)\) VALUES \(([^)]*)\)(?:\s+ON CONFLICT\((\w+)\))?/i;
const SELECT_RE = /^SELECT (.+?) FROM (\w+)(?:\s+WHERE\s+(\w+)\s*=\s*\?)?\s*$/i;

export interface FakeD1Options {
  /** Column names that should fail on INSERT, simulating an unapplied migration. */
  rejectColumns?: string[];
}

export class FakeD1 implements SqlDatabase {
  readonly tables: Record<string, FakeRow[]> = {};
  readonly executed: Array<{ sql: string; values: unknown[] }> = [];

  constructor(readonly options: FakeD1Options = {}) {}

  prepare(sql: string): SqlStatement {
    return new FakeStatement(this, sql.trim(), []);
  }

  rows(table: string): FakeRow[] {
    return this.tables[table] ?? [];
  }
}

class FakeStatement implements SqlStatement {
  constructor(
    private readonly db: FakeD1,
    private readonly sql: string,
    private readonly values: unknown[],
  ) {}

  bind(...values: unknown[]): SqlStatement {
    return new FakeStatement(this.db, this.sql, [...this.values, ...values]);
  }

  async first<T = FakeRow>(): Promise<T | null> {
    const rows = this.execute();
    return (rows[0] as T | undefined) ?? null;
  }

  async all<T = FakeRow>(): Promise<{ results: T[] }> {
    return { results: this.execute() as T[] };
  }

  async run(): Promise<unknown> {
    return { success: true, results: this.execute() };
  }

  private execute(): FakeRow[] {
    this.db.executed.push({ sql: this.sql, values: this.values });

    const insert = INSERT_RE.exec(this.sql);
    if (insert) {
      const [, table, columnList, placeholders, conflictColumn] = insert;
      const columns = columnList!.split(",").map((c) => c.trim());
      const placeholderCount = placeholders!.split(",").length;
      if (columns.length !== placeholderCount) throw new Error(`fake-d1: column/placeholder mismatch in: ${this.sql}`);
      const rejected = this.db.options.rejectColumns?.filter((c) => columns.includes(c)) ?? [];
      if (rejected.length > 0) throw new Error(`fake-d1: no such column: ${rejected[0]}`);

      const row: FakeRow = {};
      columns.forEach((column, i) => {
        row[column] = this.values[i] ?? null;
      });

      const rows = (this.db.tables[table!] ??= []);
      const existing = conflictColumn ? rows.findIndex((r) => r[conflictColumn] === row[conflictColumn]) : -1;
      if (existing >= 0) rows[existing] = { ...rows[existing], ...row };
      else rows.push(row);
      return [];
    }

    const select = SELECT_RE.exec(this.sql);
    if (select) {
      const [, , table, whereColumn] = select;
      const rows = this.db.tables[table!] ?? [];
      if (!whereColumn) return [...rows];
      return rows.filter((r) => r[whereColumn] === this.values[0]);
    }

    throw new Error(`fake-d1: unsupported statement: ${this.sql}`);
  }
}
