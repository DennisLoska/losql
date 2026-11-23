import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { classify, commandTag } from "../sql/classify";
import { splitStatements } from "../sql/statements";
import { normalizeSharedCell } from "./cells";
import { seedDemo } from "./demo";
import { asciiFold, parseSqliteIndexDdl, parseSqliteTableDdl } from "./sqlite-ddl";
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
  type RelationColumnDetail,
  type RelationConstraint,
  type RelationDetails,
  type RelationForeignKeyRef,
  type RelationIndex,
  type RelationRef,
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

type Num = number | bigint;

interface XInfoRow {
  cid: Num;
  name: string;
  type: string | null;
  notnull: Num;
  dflt_value: string | null;
  pk: Num;
  hidden: Num;
}

/** SQLite compares identifiers ignoring the case of ASCII letters only. */
function sameName(a: string, b: string): boolean {
  return asciiFold(a) === asciiFold(b);
}

/** A foreign key action as `pragma foreign_key_list` reports it; an omitted one is NO ACTION. */
function fkAction(action: string | undefined): string {
  return action === undefined ? "NO ACTION" : action.toUpperCase();
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, i) => sameName(name, b[i]!));
}

/** The only parsed constraint that `matches`, or undefined when none or several do. */
function uniqueMatch(
  parsed: readonly RelationConstraint[],
  matches: (c: RelationConstraint) => boolean,
): RelationConstraint | undefined {
  const found = parsed.filter(matches);
  return found.length === 1 ? found[0] : undefined;
}

/**
 * The Structure of one Relation, read from the catalog of `db`. PRAGMAs give the facts; the stored
 * SQL adds constraint names, CHECK expressions, generated column expressions and index terms where
 * it can be read, and the PRAGMA facts stand alone where it cannot.
 */
function describeSqliteRelation(db: Database, ref: RelationRef): RelationDetails | null {
  const databases = db.query("pragma database_list").all() as { name: string }[];
  const namespace = databases.find((d) => sameName(d.name, ref.namespace))?.name;
  if (namespace === undefined) return null;
  const ns = quoteIdent(namespace);
  const catalog = sameName(namespace, "temp") ? "sqlite_temp_schema" : `${ns}.sqlite_schema`;

  const relation = db
    .query(
      `select type, name, sql from ${catalog} where type in ('table', 'view') and name = ?1 collate nocase order by name = ?1 desc limit 1`,
    )
    .get(ref.name) as { type: "table" | "view"; name: string; sql: string | null } | null;
  if (!relation) return null;
  const name = relation.name;
  const rel = quoteIdent(name);
  const definition = relation.sql ?? undefined;

  const xinfo = (table: string) =>
    (db.query(`pragma ${ns}.table_xinfo(${quoteIdent(table)})`).all() as XInfoRow[]).filter(
      (c) => Number(c.hidden) !== 1,
    );
  const colRows = xinfo(name);

  if (relation.type === "view") {
    const columns = colRows.map(
      (c): RelationColumnDetail => ({
        name: c.name,
        type: (c.type ?? "").toLowerCase(),
        nullable: Number(c.notnull) === 0,
        references: [],
      }),
    );
    const details: RelationDetails = { namespace, name, kind: "view", columns, indexes: [], constraints: [] };
    if (definition !== undefined) details.definition = definition;
    return details;
  }

  const parsed = definition !== undefined ? parseSqliteTableDdl(definition) : { constraints: [], generated: new Map<string, string>() };

  // Indexes, read first: a declared PRIMARY KEY that SQLite backs with an index is no rowid alias.
  const indexList = db.query(`pragma ${ns}.index_list(${rel})`).all() as {
    name: string;
    unique: Num;
    origin: string;
    partial: Num;
  }[];
  const indexes: RelationIndex[] = [];
  const uniqueConstraints: RelationConstraint[] = [];
  for (const idx of indexList) {
    const keyRows = (
      db.query(`pragma ${ns}.index_xinfo(${quoteIdent(idx.name)})`).all() as {
        seqno: Num;
        cid: Num;
        name: string | null;
        key: Num;
      }[]
    )
      .filter((k) => Number(k.key) === 1)
      .sort((a, b) => Number(a.seqno) - Number(b.seqno));
    const indexSql = (
      db.query(`select sql from ${catalog} where type = 'index' and name = ?1`).get(idx.name) as
        | { sql: string | null }
        | null
    )?.sql;
    const parsedIndex = indexSql ? parseSqliteIndexDdl(indexSql) : { terms: [] as string[] };
    const columns = keyRows.map((k) => {
      const cid = Number(k.cid);
      if (cid === -2) return parsedIndex.terms[Number(k.seqno)] ?? "";
      if (cid === -1) return "rowid";
      return k.name ?? "";
    });
    const index: RelationIndex = {
      name: idx.name,
      unique: Boolean(Number(idx.unique)),
      primary: idx.origin === "pk",
      columns,
    };
    if (parsedIndex.predicate !== undefined) index.predicate = parsedIndex.predicate;
    if (indexSql) index.definition = indexSql;
    indexes.push(index);

    if (idx.origin === "u") {
      const unique: RelationConstraint = { kind: "UNIQUE", columns };
      const match = uniqueMatch(
        parsed.constraints,
        (c) => c.kind === "UNIQUE" && sameNames(c.columns, columns),
      );
      if (match?.name !== undefined) unique.name = match.name;
      uniqueConstraints.push(unique);
    }
  }

  let withoutRowid = false;
  try {
    const row = db.query(`pragma ${ns}.table_list(${rel})`).get() as { wr?: Num } | null;
    withoutRowid = Number(row?.wr ?? 0) === 1;
  } catch {
    // SQLite before 3.37 has no table_list: read the table options from the stored SQL.
    withoutRowid = definition !== undefined && /\)\s*[^)]*\bwithout\s+rowid\b[^)]*$/i.test(definition);
  }

  const pkRows = colRows.filter((c) => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk));
  const isRowidAlias =
    !withoutRowid &&
    pkRows.length === 1 &&
    asciiFold(pkRows[0]!.type ?? "") === "integer" &&
    !indexList.some((i) => i.origin === "pk");

  // Foreign keys, grouped by id, each group in declared column order.
  const fkRows = db.query(`pragma ${ns}.foreign_key_list(${rel})`).all() as {
    id: Num;
    seq: Num;
    table: string;
    from: string;
    to: string | null;
    on_update: string;
    on_delete: string;
  }[];
  const groups = new Map<number, typeof fkRows>();
  for (const row of fkRows) {
    const id = Number(row.id);
    const group = groups.get(id) ?? [];
    group.push(row);
    groups.set(id, group);
  }
  const parentKeys = new Map<string, string[]>();
  // The primary key of a parent table; empty when the parent is no table or cannot be read.
  const parentKey = (table: string): string[] => {
    const key = asciiFold(table);
    let cols = parentKeys.get(key);
    if (!cols) {
      cols = [];
      try {
        const parent = db
          .query(`select name from ${catalog} where type = 'table' and name = ?1 collate nocase`)
          .get(table) as { name: string } | null;
        if (parent) {
          cols = xinfo(parent.name)
            .filter((c) => Number(c.pk) > 0)
            .sort((a, b) => Number(a.pk) - Number(b.pk))
            .map((c) => c.name);
        }
      } catch {
        // An unreadable parent has no known key.
      }
      parentKeys.set(key, cols);
    }
    return cols;
  };
  const fkConstraints: RelationConstraint[] = [];
  const refsByColumn = new Map<string, RelationForeignKeyRef[]>();
  for (const id of [...groups.keys()].sort((a, b) => a - b)) {
    const group = groups.get(id)!.sort((a, b) => Number(a.seq) - Number(b.seq));
    const first = group[0]!;
    const from = group.map((r) => r.from);
    let to: string[];
    if (group.every((r) => r.to !== null)) {
      to = group.map((r) => r.to!);
    } else {
      const pk = parentKey(first.table);
      to = pk.length === group.length ? pk : group.map(() => "");
    }
    const declaredTargets = group.every((r) => r.to !== null) ? to : [];
    const match = uniqueMatch(
      parsed.constraints,
      (c) =>
        c.kind === "FOREIGN KEY" &&
        c.references !== undefined &&
        sameName(c.references.relation, first.table) &&
        sameNames(c.columns, from) &&
        sameNames(c.references.columns, declaredTargets) &&
        fkAction(c.references.onUpdate) === fkAction(first.on_update) &&
        fkAction(c.references.onDelete) === fkAction(first.on_delete),
    );
    const constraint: RelationConstraint = {
      kind: "FOREIGN KEY",
      columns: from,
      references: { relation: first.table, columns: to, onUpdate: first.on_update, onDelete: first.on_delete },
    };
    if (match?.name !== undefined) constraint.name = match.name;
    fkConstraints.push(constraint);
    group.forEach((r, i) => {
      const fkRef: RelationForeignKeyRef = {
        relation: first.table,
        column: to[i]!,
        onUpdate: first.on_update,
        onDelete: first.on_delete,
      };
      if (constraint.name !== undefined) fkRef.constraintName = constraint.name;
      const key = asciiFold(r.from);
      refsByColumn.set(key, [...(refsByColumn.get(key) ?? []), fkRef]);
    });
  }

  const columns = colRows.map((c): RelationColumnDetail => {
    const pk = Number(c.pk);
    const column: RelationColumnDetail = {
      name: c.name,
      type: (c.type ?? "").toLowerCase(),
      nullable: Number(c.notnull) === 0 && !(pk > 0 && (withoutRowid || isRowidAlias)),
      references: refsByColumn.get(asciiFold(c.name)) ?? [],
    };
    if (c.dflt_value !== null) column.defaultValue = String(c.dflt_value);
    if (pk > 0) column.primaryKeyPosition = pk;
    const hidden = Number(c.hidden);
    if (hidden === 2 || hidden === 3) {
      column.generated = parsed.generated.get(asciiFold(c.name)) ?? (hidden === 2 ? "VIRTUAL" : "STORED");
    }
    return column;
  });

  const constraints: RelationConstraint[] = [];
  if (pkRows.length > 0) {
    const pkColumns = pkRows.map((c) => c.name);
    const primary: RelationConstraint = { kind: "PRIMARY KEY", columns: pkColumns };
    const match = uniqueMatch(
      parsed.constraints,
      (c) => c.kind === "PRIMARY KEY" && sameNames(c.columns, pkColumns),
    );
    if (match?.name !== undefined) primary.name = match.name;
    constraints.push(primary);
  }
  constraints.push(...uniqueConstraints, ...fkConstraints);
  for (const check of parsed.constraints) {
    if (check.kind === "CHECK") constraints.push(check);
  }

  const details: RelationDetails = { namespace, name, kind: "table", columns, indexes, constraints };
  if (definition !== undefined) details.definition = definition;
  return details;
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
  let closed = false;

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

    async describeRelation(
      ref: RelationRef,
      describeOpts?: { signal?: AbortSignal },
    ): Promise<RelationDetails | null> {
      if (closed) throw new QueryError("the Session is closed");
      if (describeOpts?.signal?.aborted) {
        throw new QueryError("canceling statement due to user request");
      }
      try {
        return describeSqliteRelation(mainDb, ref);
      } catch (err) {
        throw toQueryError(err);
      }
    },

    async close(): Promise<void> {
      closed = true;
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

