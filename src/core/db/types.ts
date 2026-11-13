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

export interface Driver {
  readonly connection: Connection;
  run(statement: string, options?: RunOptions): Promise<Result>;
  schema(): Promise<SchemaSnapshot>;
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
