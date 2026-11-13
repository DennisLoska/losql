import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { classify, commandTag } from "../sql/classify";
import { splitStatements } from "../sql/statements";
import { normalizeSharedCell } from "./cells";
import { seedDemo } from "./demo";
import {
  type Cell,
  type Column,
  type Connection,
  DEFAULT_MAX_ROWS,
  type Driver,
  QueryError,
  refuseNulCharacter,
  type Relation,
  type RelationColumn,
  type Result,
  type RunOptions,
  type SchemaSnapshot,
} from "./types";

function normalizeCell(value: unknown): Cell {
  return normalizeSharedCell(value, { bigintToSafeNumber: true });
}

function inferType(rawValues: unknown[], colIndex: number): string {
  for (const row of rawValues) {
    const arr = row as unknown[];
    const val = arr[colIndex];
    if (val === null || val === undefined) continue;
    if (typeof val === "bigint") return "integer";
    if (typeof val === "number") return Number.isInteger(val) ? "integer" : "real";
    if (typeof val === "string") return "text";
    if (val instanceof Uint8Array) return "blob";
    if (typeof val === "boolean") return "integer";
  }
  return "";
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function toQueryError(err: unknown, isReadOnly = false): QueryError {
  if (err instanceof QueryError) return err;
  if (isReadOnly && err && typeof err === "object") {
    const rec = err as { code?: unknown; errno?: unknown; message?: unknown };
    const code = typeof rec.code === "string" ? rec.code : "";
    const msg = typeof rec.message === "string" ? rec.message : "";
    const errno = typeof rec.errno === "number" ? rec.errno : 0;
    if (
      code.startsWith("SQLITE_BUSY") ||
      code.startsWith("SQLITE_LOCKED") ||
      errno === 5 ||
      errno === 6 ||
      /database (?:table )?is locked/i.test(msg)
    ) {
      return new QueryError(
        "the database is locked by an open transaction; commit or roll back, then try again",
      );
    }
  }
  if (err instanceof Error) return new QueryError(err.message);
  return new QueryError(String(err));
}

export function openSqlite(connection: Connection, options?: { create?: boolean }): Driver {
  let db: Database | null = null;
  let roDb: Database | null = null;

  if (connection.url === "demo") {
    db = new Database(":memory:", { safeIntegers: true });
    seedDemo(db);
  } else if (connection.url === ":memory:") {
    db = new Database(":memory:", { safeIntegers: true });
  } else {
    const filePath = connection.url.startsWith("sqlite:")
      ? connection.url.slice("sqlite:".length)
      : connection.display;
    if (!existsSync(filePath) && !options?.create) {
      throw new QueryError(`no such file: ${filePath}`);
    }
    try {
      db = new Database(filePath, { create: true, readwrite: true, safeIntegers: true });
      roDb = new Database(filePath, { readonly: true, safeIntegers: true });
    } catch (err) {
      if (db) {
        try {
          db.close();
        } catch {
          // ignore cleanup errors
        }
      }
      throw toQueryError(err);
    }
  }

  const mainDb = db;

  function resolveDuplicateColumnNames(
    handle: Database,
    statementText: string,
    totalCols: number,
    originalNames: readonly string[],
  ): string[] {
    const clean = splitStatements(statementText)[0]?.text ?? statementText.replace(/;+\s*$/, "");
    let wrapperStmt: ReturnType<Database["prepare"]> | null = null;
    try {
      wrapperStmt = handle.prepare(`select * from (\n${clean}\n) limit 0`);
      const wrapperNames = wrapperStmt.columnNames;
      if (wrapperNames.length === totalCols) {
        const seen = new Set<string>();
        const candidates = wrapperNames.map((name) => {
          const m = name.match(/^(.*):(\d+)$/s);
          const stripped = m && seen.has(m[1]!) ? m[1]! : name;
          seen.add(stripped);
          return { raw: name, stripped };
        });

        const resolved = candidates.map((c) => c.stripped);
        const origWithColon = originalNames.filter((n) => /:\d+$/s.test(n));
        if (origWithColon.length > 0) {
          // For each user-specified name ending in :N, find which column in the query had that exact name.
          // Since bun:sqlite's originalNames lists unique names in order of their LAST occurrence,
          // we match originalNames from right to left against candidates.
          let origIdx = originalNames.length - 1;
          for (let i = totalCols - 1; i >= 0 && origIdx >= 0; i--) {
            const target = originalNames[origIdx]!;
            const c = candidates[i]!;
            const m = target.match(/^(.*):(\d+)$/s);
            if (m && seen.has(m[1]!) && c.stripped === m[1]!) {
              resolved[i] = target;
              origIdx--;
            } else if (c.raw === target || c.stripped === target) {
              resolved[i] = target;
              origIdx--;
            }
          }
        }
        return resolved;
      }
    } catch {
      // Fall back to positional names if the statement cannot be wrapped as a subquery (e.g. RETURNING)
    } finally {
      if (wrapperStmt) {
        try {
          wrapperStmt.finalize();
        } catch {
          // ignore cleanup errors
        }
      }
    }
    return Array.from({ length: totalCols }, (_, i) => `column${i + 1}`);
  }

  return {
    connection,

    async run(statement: string, runOpts?: RunOptions): Promise<Result> {
      refuseNulCharacter(statement);
      const start = performance.now();
      const max = runOpts?.maxRows ?? DEFAULT_MAX_ROWS;
      const isReadOnly = Boolean(runOpts?.readOnly);

      const statements = splitStatements(statement);
      if (statements.length === 0) {
        throw new QueryError("nothing to run");
      }
      if (statements.length > 1) {
        throw new QueryError("more than one Statement: run them one at a time");
      }
      const singleStatementText = statements[0]!.text;

      if (isReadOnly && classify(statement) !== "read") {
        throw new QueryError("attempt to write a readonly database");
      }

      const handle = isReadOnly && roDb ? roDb : mainDb;
      const usePragmaQueryOnly = isReadOnly && !roDb;
      let priorQueryOnly = false;
      let stmt: ReturnType<Database["prepare"]> | null = null;

      try {
        if (usePragmaQueryOnly) {
          const qoRow = handle.query("PRAGMA query_only").get() as
            | { query_only?: number | bigint }
            | null;
          priorQueryOnly = Number(qoRow?.query_only ?? 0) !== 0;
          handle.exec("PRAGMA query_only = ON");
        }

        stmt = handle.prepare(singleStatementText);
        const columnNames = stmt.columnNames;
        const declared = stmt.declaredTypes;
        const totalCols = declared.length;
        const cmd = commandTag(singleStatementText);

        if (totalCols === 0) {
          const info = stmt.run();
          const durationMs = performance.now() - start;
          return {
            columns: [],
            rows: [],
            truncated: false,
            affected: info.changes,
            command: cmd,
            durationMs,
          };
        }

        const hasDuplicates = totalCols !== columnNames.length;
        const useValues = hasDuplicates || columnNames.includes("__proto__");

        const rawRows: unknown[][] = [];
        let truncated = false;

        if (useValues) {
          // bun:sqlite only exposes array rows via stmt.values(), which materialises all rows; use it only when columns have duplicate names.
          const allValues = stmt.values() as unknown[][];
          if (allValues.length > max) {
            truncated = true;
            for (let i = 0; i < max; i++) {
              rawRows.push(allValues[i]!);
            }
          } else {
            rawRows.push(...allValues);
          }
        } else {
          for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) {
            if (rawRows.length >= max) {
              truncated = true;
              break;
            }
            rawRows.push(columnNames.map((name) => row[name]));
          }
        }

        const resolvedNames = hasDuplicates
          ? resolveDuplicateColumnNames(handle, singleStatementText, totalCols, columnNames)
          : columnNames;

        const columns: Column[] = resolvedNames.map((name, i) => {
          const decl = declared[i];
          const type =
            typeof decl === "string" && decl.trim().length > 0
              ? decl.toLowerCase()
              : inferType(rawRows, i);
          return { name, type };
        });

        const rows: Cell[][] = rawRows.map((rawRow) => rawRow.map((cell) => normalizeCell(cell)));
        const durationMs = performance.now() - start;

        return {
          columns,
          rows,
          truncated,
          affected: null,
          command: cmd,
          durationMs,
        };
      } catch (err) {
        throw toQueryError(err, isReadOnly);
      } finally {
        if (stmt) {
          try {
            stmt.finalize();
          } catch {
            // ignore cleanup errors
          }
        }
        if (usePragmaQueryOnly) {
          try {
            handle.exec(`PRAGMA query_only = ${priorQueryOnly ? "ON" : "OFF"}`);
          } catch {
            // ignore cleanup errors
          }
        }
      }
    },

    async schema(): Promise<SchemaSnapshot> {
      try {
        const relRows = mainDb
          .query(
            "select type, name from sqlite_schema where type in ('table','view') and substr(name, 1, 7) <> 'sqlite_' order by name",
          )
          .all() as { type: "table" | "view"; name: string }[];

        const colRowsByRel = new Map<
          string,
          { name: string; type: string; notnull: number | bigint; pk: number | bigint }[]
        >();
        const primaryKeysByRel = new Map<string, string[]>();

        for (const r of relRows) {
          const quoted = quoteIdent(r.name);
          const rawColRows = mainDb.query(`pragma table_xinfo(${quoted})`).all() as {
            name: string;
            type: string;
            notnull: number | bigint;
            pk: number | bigint;
            hidden: number | bigint;
          }[];
          const colRows = rawColRows.filter((c) => Number(c.hidden) !== 1);
          colRowsByRel.set(r.name.toLowerCase(), colRows);

          const pks = colRows
            .filter((c) => Number(c.pk) > 0)
            .sort((a, b) => Number(a.pk) - Number(b.pk))
            .map((c) => c.name);
          primaryKeysByRel.set(r.name.toLowerCase(), pks.length > 0 ? pks : ["rowid"]);
        }

        const relations: Relation[] = relRows.map((r) => {
          const quoted = quoteIdent(r.name);
          const fkRows = mainDb.query(`pragma foreign_key_list(${quoted})`).all() as {
            seq: number | bigint;
            from: string;
            table: string;
            to: string | null;
          }[];
          const fkMap = new Map<string, { relation: string; column: string }>();
          for (const fk of fkRows) {
            const targetPks = primaryKeysByRel.get(fk.table.toLowerCase()) ?? ["rowid"];
            const seqIdx = Number(fk.seq ?? 0);
            const targetCol = fk.to ?? targetPks[seqIdx] ?? targetPks[0] ?? "rowid";
            fkMap.set(fk.from, { relation: fk.table, column: targetCol });
          }

          const colRows = colRowsByRel.get(r.name.toLowerCase()) ?? [];

          const columns: RelationColumn[] = colRows.map((c) => {
            const col: RelationColumn = {
              name: c.name,
              type: (c.type ?? "").toLowerCase(),
              nullable: Number(c.notnull) === 0,
              primaryKey: Number(c.pk) > 0,
            };
            const ref = fkMap.get(c.name);
            if (ref) {
              col.references = ref;
            }
            return col;
          });

          return {
            name: r.name,
            kind: r.type,
            columns,
          };
        });

        return {
          dialect: "sqlite",
          namespaces: [{ name: "main", relations }],
        };
      } catch (err) {
        throw toQueryError(err);
      }
    },

    async close(): Promise<void> {
      try {
        if (roDb) {
          roDb.close();
          roDb = null;
        }
      } finally {
        mainDb.close();
      }
    },
  };
}

