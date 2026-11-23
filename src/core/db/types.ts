export type Dialect = "sqlite" | "postgres";

export interface Connection {
  id: string;
  name: string;
  dialect: Dialect;
  url: string;
  display: string;
}

export interface Column {
  name: string;
  type: string;
}

export type Cell = null | boolean | number | string | { [key: string]: Cell } | Cell[];

export interface Result {
  columns: Column[];
  rows: Cell[][];
  truncated: boolean;
  affected: number | null;
  command: string;
  durationMs: number;
}

export interface RunOptions {
  maxRows?: number;
  readOnly?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RelationColumn {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  references?: { relation: string; column: string };
}

export interface Relation {
  name: string;
  kind: "table" | "view";
  columns: RelationColumn[];
}

export interface SchemaSnapshot {
  dialect: Dialect;
  namespaces: { name: string; relations: Relation[] }[];
}

export interface RelationRef {
  namespace: string;
  name: string;
}

export interface RelationForeignKeyRef {
  namespace?: string;
  relation: string;
  column: string;
  constraintName?: string;
  onUpdate?: string;
  onDelete?: string;
}

export interface RelationColumnDetail {
  name: string;
  type: string;
  nullable: boolean;
  /** Raw SQL default expression; undefined means no default declared, "NULL" means explicit DEFAULT NULL. */
  defaultValue?: string;
  /** 1-based position in PRIMARY KEY, undefined if not part of PK. */
  primaryKeyPosition?: number;
  /** Generated column expression or kind if applicable. */
  generated?: string;
  /** All foreign key references originating from this column (supports multiple FKs). */
  references: RelationForeignKeyRef[];
}

export interface RelationIndex {
  name: string;
  unique: boolean;
  primary: boolean;
  /** Ordered key columns or expressions. */
  columns: string[];
  /** Optional INCLUDE columns (PostgreSQL). */
  includedColumns?: string[];
  /** Index access method (e.g. btree, gin, gist) when available. */
  method?: string;
  /** Partial index WHERE predicate when present. */
  predicate?: string;
  /** Raw CREATE INDEX / pg_get_indexdef definition when available. */
  definition?: string;
}

export type RelationConstraintKind = "PRIMARY KEY" | "UNIQUE" | "FOREIGN KEY" | "CHECK";

export interface RelationConstraint {
  name?: string;
  kind: RelationConstraintKind;
  columns: string[];
  /** Human-readable constraint expression / SQL definition when available. */
  definition?: string;
  /** Structured FK target when kind === "FOREIGN KEY". */
  references?: {
    namespace?: string;
    relation: string;
    columns: string[];
    onUpdate?: string;
    onDelete?: string;
  };
}

export interface RelationDetails {
  namespace: string;
  name: string;
  kind: "table" | "view";
  columns: RelationColumnDetail[];
  /** undefined means metadata unavailable (e.g. fallback driver); [] means confirmed none. */
  indexes?: RelationIndex[];
  /** undefined means metadata unavailable; [] means confirmed none. */
  constraints?: RelationConstraint[];
  /** Stored CREATE TABLE/VIEW SQL (SQLite) or pg_get_viewdef (PostgreSQL). */
  definition?: string;
}

export interface Driver {
  readonly connection: Connection;
  run(statement: string, options?: RunOptions): Promise<Result>;
  schema(): Promise<SchemaSnapshot>;
  /**
   * The Structure of one Relation: columns, indexes, constraints and stored definition. Null when
   * the namespace or the Relation does not exist. A Driver without it offers only `schema()`.
   */
  describeRelation?(ref: RelationRef, options?: { signal?: AbortSignal }): Promise<RelationDetails | null>;
  close(): Promise<void>;
  /**
   * True once after the Driver's main connection was closed by something other than `close()` (the
   * server ended it, the network dropped it). The client library then opens a new connection by
   * itself, so what the old one held (an open transaction, session settings, temporary tables) is
   * gone. Each loss is reported once. A Driver that cannot lose its connection does not have this.
   */
  takeLostConnection?(): boolean;
}

export class QueryError extends Error {
  code?: string;
  position?: number;
  detail?: string;
  hint?: string;
  constructor(
    message: string,
    fields?: { code?: string; position?: number; detail?: string; hint?: string },
  ) {
    super(message);
    this.name = "QueryError";
    if (fields) {
      if (fields.code !== undefined) this.code = fields.code;
      if (fields.position !== undefined) this.position = fields.position;
      if (fields.detail !== undefined) this.detail = fields.detail;
      if (fields.hint !== undefined) this.hint = fields.hint;
    }
  }
}

export const DEFAULT_MAX_ROWS = 1000;

/**
 * SQLite reads the text of a Statement only up to its first NUL character (U+0000), so a text
 * with a NUL would run as something else than what was shown and confirmed. Every Driver calls
 * this on a caller's text before anything else reaches the database.
 */
export function refuseNulCharacter(statement: string): void {
  if (statement.includes("\u0000")) {
    throw new QueryError("the statement contains a NUL character (U+0000) and was not run");
  }
}
