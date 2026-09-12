/**
 * In-memory stand-in for D1. Understands exactly the statement shapes the stores
 * emit (single-line INSERT with an explicit column list, optional
 * `ON CONFLICT(col)`; SELECT with at most one `WHERE col = ?`, optional
 * `ORDER BY col [ASC|DESC]` and `LIMIT`; `DELETE ... WHERE col = ?`), which keeps
 * the API testable in plain Node — no miniflare, no workerd.
 */
import type { SqlDatabase, SqlStatement } from "../data/d1.ts";

export type FakeRow = Record<string, unknown>;

const INSERT_RE = /^INSERT INTO (\w+) \(([^)]*)\) VALUES \(([^)]*)\)(?:\s+ON CONFLICT\((\w+)\))?/i;
const SELECT_RE =
  /^SELECT (.+?) FROM (\w+)(?:\s+WHERE\s+(\w+)\s*=\s*\?)?(?:\s+ORDER BY\s+(\w+)(?:\s+(ASC|DESC))?)?(?:\s+LIMIT\s+(\?|\d+))?\s*$/i;
const DELETE_RE = /^DELETE FROM (\w+)(?:\s+WHERE\s+(\w+)\s*=\s*\?)?\s*$/i;

/** Tables whose primary key is `INTEGER PRIMARY KEY AUTOINCREMENT` in migrations/. */
const AUTOINCREMENT: Record<string, string> = { imessage_log: "id" };

export interface FakeD1Options {
  /** Column names that should fail on INSERT, simulating an unapplied migration. */
  rejectColumns?: string[];
  /** Table names that should fail on any statement, simulating an unapplied migration. */
  rejectTables?: string[];
}

export class FakeD1 implements SqlDatabase {
  readonly tables: Record<string, FakeRow[]> = {};
  readonly executed: Array<{ sql: string; values: unknown[] }> = [];
  readonly sequences: Record<string, number> = {};

  constructor(readonly options: FakeD1Options = {}) {}

  prepare(sql: string): SqlStatement {
    return new FakeStatement(this, sql.trim(), []);
  }

  rows(table: string): FakeRow[] {
    return this.tables[table] ?? [];
  }

  nextId(table: string): number {
    this.sequences[table] = (this.sequences[table] ?? 0) + 1;
    return this.sequences[table]!;
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

    const rejectedTable = this.db.options.rejectTables?.find((t) => new RegExp(`\\b${t}\\b`, "i").test(this.sql));
    if (rejectedTable) throw new Error(`fake-d1: no such table: ${rejectedTable}`);

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
      const sequenceColumn = AUTOINCREMENT[table!];
      if (sequenceColumn && !columns.includes(sequenceColumn)) row[sequenceColumn] = this.db.nextId(table!);

      const rows = (this.db.tables[table!] ??= []);
      const existing = conflictColumn ? rows.findIndex((r) => r[conflictColumn] === row[conflictColumn]) : -1;
      if (existing >= 0) rows[existing] = { ...rows[existing], ...row };
      else rows.push(row);
      return [];
    }

    const select = SELECT_RE.exec(this.sql);
    if (select) {
      const [, , table, whereColumn, orderColumn, direction, limit] = select;
      let rows = [...(this.db.tables[table!] ?? [])];
      const bound = [...this.values];
      if (whereColumn) {
        const wanted = bound.shift();
        rows = rows.filter((r) => r[whereColumn] === wanted);
      }
      if (orderColumn) {
        const sign = (direction ?? "ASC").toUpperCase() === "DESC" ? -1 : 1;
        rows.sort((a, b) => sign * compare(a[orderColumn], b[orderColumn]));
      }
      if (limit) {
        const count = Number(limit === "?" ? bound.shift() : limit);
        if (Number.isFinite(count)) rows = rows.slice(0, Math.max(0, count));
      }
      return rows;
    }

    const del = DELETE_RE.exec(this.sql);
    if (del) {
      const [, table, whereColumn] = del;
      const rows = this.db.tables[table!] ?? [];
      const kept = whereColumn ? rows.filter((r) => r[whereColumn] !== this.values[0]) : [];
      this.db.tables[table!] = kept;
      return [];
    }

    throw new Error(`fake-d1: unsupported statement: ${this.sql}`);
  }
}

/** SQLite's ordering rules, reduced to what the store's columns actually hold: NULLs first, then numbers/strings. */
function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : 1;
}
