// Minimal ambient types for the better-sqlite3 surface this package uses
// (@types/better-sqlite3 is not a dependency). Internal only.
declare module "better-sqlite3" {
  interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }
  interface Statement {
    run(...params: unknown[]): RunResult;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }
  interface Transaction<F extends (...args: never[]) => unknown> {
    (...args: Parameters<F>): ReturnType<F>;
    immediate(...args: Parameters<F>): ReturnType<F>;
  }
  interface Database {
    prepare(sql: string): Statement;
    exec(sql: string): this;
    pragma(source: string, options?: { simple?: boolean }): unknown;
    transaction<F extends (...args: never[]) => unknown>(fn: F): Transaction<F>;
    close(): this;
    readonly open: boolean;
    readonly name: string;
  }
  interface DatabaseConstructor {
    new (filename: string, options?: Record<string, unknown>): Database;
    (filename: string, options?: Record<string, unknown>): Database;
  }
  const Database: DatabaseConstructor;
  export default Database;
  export type { Database, Statement };
}
