import postgres from "postgres";
import { expandEnv } from "../config";
import { classify } from "../sql/classify";
import { splitStatements } from "../sql/statements";
import { normalizeSharedCell } from "./cells";
import { redactMessage } from "./redact";
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

const SEEDED_TYPE_NAMES: readonly [number, string][] = [
  [16, "bool"],
  [17, "bytea"],
  [20, "int8"],
  [21, "int2"],
  [23, "int4"],
  [25, "text"],
  [114, "json"],
  [700, "float4"],
  [701, "float8"],
  [1042, "bpchar"],
  [1043, "varchar"],
  [1082, "date"],
  [1083, "time"],
  [1114, "timestamp"],
  [1184, "timestamptz"],
  [1186, "interval"],
  [1266, "timetz"],
  [1700, "numeric"],
  [2950, "uuid"],
  [3802, "jsonb"],
];

export interface EffectivePostgresTarget {
  host: string;
  port: number;
  user: string;
  database: string;
  password: string;
  cleanUrl: string;
}

const TARGET_QUERY_KEYS = new Set([
  "host",
  "hostname",
  "port",
  "user",
  "username",
  "database",
  "db",
  "password",
  "pass",
]);

function parsePercentDecodedQuery(rawSearch: string): Record<string, string> {
  const query: Record<string, string> = {};
  const body = rawSearch.startsWith("?") ? rawSearch.slice(1) : rawSearch;
  if (!body) return query;
  for (const part of body.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const rawKey = eq === -1 ? part : part.slice(0, eq);
    const rawVal = eq === -1 ? "" : part.slice(eq + 1);
    const key = decodeURIComponent(rawKey);
    const val = decodeURIComponent(rawVal);
    query[key] = val;
  }
  return query;
}

function parseSingleHostTarget(rawHost: string): { host: string; inlinePort: string | null } {
  const parts = rawHost.split(",").filter(Boolean);
  if (parts.length !== 1) {
    throw new Error("ambiguous or empty host target");
  }
  const single = parts[0]!;
  const ipv6Match = single.match(/^\[([^\]]+)\](?::(\d*))?$/);
  if (ipv6Match) {
    return {
      host: `[${ipv6Match[1]!}]`,
      inlinePort: ipv6Match[2] ? ipv6Match[2] : null,
    };
  }
  if (single.startsWith("/")) {
    const colonMatch = single.match(/^(.*):(\d+)$/);
    if (colonMatch) {
      return { host: colonMatch[1]!, inlinePort: colonMatch[2]! };
    }
    return { host: single, inlinePort: null };
  }
  const hostPortMatch = single.match(/^([^:]+)(?::(\d*))?$/);
  if (!hostPortMatch || !hostPortMatch[1]) {
    throw new Error("invalid host target");
  }
  return {
    host: hostPortMatch[1],
    inlinePort: hostPortMatch[2] ? hostPortMatch[2] : null,
  };
}

export function computeEffectivePostgresTarget(
  parsed: URL,
  rawUrl?: string,
): EffectivePostgresTarget {
  const authUser = parsed.username ? decodeURIComponent(parsed.username) : "";
  const authPassword = parsed.password ? decodeURIComponent(parsed.password) : "";
  const authDb = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  const query = parsePercentDecodedQuery(parsed.search);
  // An empty value of a target parameter counts as not given, as the client treats it.
  for (const key of TARGET_QUERY_KEYS) {
    if (query[key] === "") {
      delete query[key];
    }
  }

  const qHost = query.hostname || query.host;
  let host: string;
  let hostInlinePort: string | null = null;
  if (qHost !== undefined) {
    const parsedHost = parseSingleHostTarget(qHost);
    host = parsedHost.host;
    hostInlinePort = parsedHost.inlinePort;
  } else if (parsed.hostname) {
    if (parsed.hostname.includes(",")) {
      throw new Error("multiple hosts in authority");
    }
    host = decodeURIComponent(parsed.hostname);
  } else {
    host = "localhost";
  }

  const rawPort =
    query.port !== undefined
      ? query.port
      : qHost !== undefined
        ? (hostInlinePort ?? "5432")
        : parsed.port || "5432";
  if (!/^\d+$/.test(rawPort)) {
    throw new Error("invalid port");
  }
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("port out of range");
  }

  const user = query.user || query.username || authUser;
  const database = query.database || query.db || authDb;
  const password = query.pass || query.password || authPassword;

  const remainingPairs: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (TARGET_QUERY_KEYS.has(k)) continue;
    remainingPairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }

  const cleanSearch = remainingPairs.length > 0 ? `?${remainingPairs.join("&")}` : "";
  const cleanHost = host.startsWith("/") ? "localhost" : host;
  const cleanUserPart = user ? `${encodeURIComponent(user)}@` : "";
  const cleanDbPart = database ? `/${encodeURIComponent(database)}` : "/";
  const cleanUrl =
    `postgres://${cleanUserPart}${cleanHost}:${port}${cleanDbPart}${cleanSearch}` || rawUrl || "";

  return {
    host,
    port,
    user,
    database,
    password,
    cleanUrl,
  };
}

export function resolvePostgresTarget(rawUrl: string): EffectivePostgresTarget {
  const trimmed = rawUrl.trim();
  const pgSchemeMatch = trimmed.match(/^(postgres|postgresql):\/\//i);
  const normalizedUrl = pgSchemeMatch
    ? `postgres://${trimmed.slice(pgSchemeMatch[0].length)}`
    : trimmed;
  const parsed = new URL(normalizedUrl);
  return computeEffectivePostgresTarget(parsed, normalizedUrl);
}

/** The password a Postgres URL carries (in its user part or as `password=`/`pass=`), decoded. */
export function extractPassword(rawUrl: string): string | undefined {
  if (!rawUrl) return undefined;
  try {
    const target = resolvePostgresTarget(rawUrl);
    if (target.password) return target.password;
  } catch {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.password) {
        try {
          return decodeURIComponent(parsed.password);
        } catch {
          return parsed.password;
        }
      }
      const query = parsePercentDecodedQuery(parsed.search);
      const qPw = query.pass || query.password;
      if (qPw) return qPw;
    } catch {
      const match = rawUrl.match(/^(?:postgres|postgresql):\/\/[^/:?#]+:([^@]+)@/i);
      if (match?.[1]) {
        return match[1];
      }
    }
  }
  return undefined;
}

function redactWithSecrets(
  text: string,
  secretsList: { url?: string; password?: string }[],
): string {
  let out = text;
  for (const s of secretsList) {
    out = redactMessage(out, s);
  }
  return out;
}

function toQueryError(
  err: unknown,
  secretsList: { url?: string; password?: string }[],
): QueryError {
  if (err instanceof QueryError) {
    return new QueryError(redactWithSecrets(err.message, secretsList), {
      code: err.code,
      position: err.position,
      detail: err.detail !== undefined ? redactWithSecrets(err.detail, secretsList) : undefined,
      hint: err.hint !== undefined ? redactWithSecrets(err.hint, secretsList) : undefined,
    });
  }
  if (err && typeof err === "object") {
    const rec = err as {
      message?: unknown;
      code?: unknown;
      position?: unknown;
      detail?: unknown;
      hint?: unknown;
    };
    const rawMessage = typeof rec.message === "string" && rec.message.length > 0 ? rec.message : String(err);
    const code = typeof rec.code === "string" && rec.code.length > 0 ? rec.code : undefined;
    const posNum = Number(rec.position);
    const position = Number.isFinite(posNum) && posNum > 0 ? posNum : undefined;
    const detail =
      typeof rec.detail === "string" && rec.detail.length > 0
        ? redactWithSecrets(rec.detail, secretsList)
        : undefined;
    const hint =
      typeof rec.hint === "string" && rec.hint.length > 0
        ? redactWithSecrets(rec.hint, secretsList)
        : undefined;
    return new QueryError(redactWithSecrets(rawMessage, secretsList), {
      code,
      position,
      detail,
      hint,
    });
  }
  return new QueryError(redactWithSecrets(String(err), secretsList));
}

function normalizeCell(value: unknown): Cell {
  return normalizeSharedCell(value);
}

export function buildPostgresClientArgs(target: EffectivePostgresTarget): {
  url: string;
  options: {
    host: string;
    port: number;
    user?: string;
    database?: string;
    password?: string;
  };
} {
  const clientHost =
    target.host.startsWith("[") && target.host.endsWith("]")
      ? target.host.slice(1, -1)
      : target.host;
  return {
    url: target.cleanUrl,
    options: {
      host: clientHost,
      port: target.port,
      ...(target.user ? { user: target.user } : {}),
      ...(target.database ? { database: target.database } : {}),
      ...(target.password ? { password: target.password } : {}),
    },
  };
}

function createClient(target: EffectivePostgresTarget, onclose?: () => void) {
  const { url, options } = buildPostgresClientArgs(target);
  return postgres(url, {
    ...options,
    max: 1,
    // A Session's connection is never retired by the library: that would end an open transaction.
    max_lifetime: null,
    ...(onclose ? { onclose } : {}),

    onnotice: () => {},
    connect_timeout: 10,
    idle_timeout: 0,
    types: {
      int8: {
        to: 20,
        from: [20],
        serialize: (v: unknown) => String(v),
        parse: (v: string) => String(v),
      },
      numeric: {
        to: 1700,
        from: [1700],
        serialize: (v: unknown) => String(v),
        parse: (v: string) => String(v),
      },
      date: {
        to: 1082,
        from: [1082],
        serialize: (v: unknown) => String(v),
        parse: (v: string) => String(v),
      },
      time: {
        to: 1083,
        from: [1083],
        serialize: (v: unknown) => String(v),
        parse: (v: string) => String(v),
      },
      timestamp: {
        to: 1114,
        from: [1114],
        serialize: (v: unknown) => String(v),
        parse: (v: string) => String(v),
      },
      interval: {
        to: 1186,
        from: [1186],
        serialize: (v: unknown) => String(v),
        parse: (v: string) => String(v),
      },
      timetz: {
        to: 1266,
        from: [1266],
        serialize: (v: unknown) => String(v),
        parse: (v: string) => String(v),
      },
    },
  });
}

function expandPostgresUrl(
  template: string,
  env: Record<string, string | undefined>,
): string {
  const trimmed = template.trim();
  if (/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(trimmed)) {
    return expandEnv(template, env);
  }
  const schemeIdx = template.indexOf("://");
  if (schemeIdx === -1) {
    return expandEnv(template, env);
  }
  const authStart = schemeIdx + 3;
  let authEnd = template.length;
  for (let i = authStart; i < template.length; i++) {
    const ch = template[i];
    if (ch === "/" || ch === "?" || ch === "#") {
      authEnd = i;
      break;
    }
  }
  const authority = template.slice(authStart, authEnd);
  const lastAt = authority.lastIndexOf("@");
  if (lastAt === -1) {
    return expandEnv(template, env);
  }
  const userinfoEnd = authStart + lastAt;
  const prefix = template.slice(0, authStart);
  const userinfo = template.slice(authStart, userinfoEnd);
  const suffix = template.slice(userinfoEnd);

  const expandedUserinfo = userinfo.replace(
    /\$\{[A-Za-z_][A-Za-z0-9_]*\}/g,
    (placeholder) => encodeURIComponent(expandEnv(placeholder, env)),
  );
  return `${prefix}${expandedUserinfo}${expandEnv(suffix, env)}`;
}

export async function openPostgres(
  connection: Connection,
  options?: { env?: Record<string, string | undefined> },
): Promise<Driver> {
  const env = options?.env ?? process.env;
  let expandedUrl = connection.url;
  let target: EffectivePostgresTarget;
  const secrets: { url?: string; password?: string }[] = [
    { url: connection.url, password: extractPassword(connection.url) },
  ];

  try {
    expandedUrl = expandPostgresUrl(connection.url, env);
    secrets.push({ url: expandedUrl, password: extractPassword(expandedUrl) });
    target = resolvePostgresTarget(expandedUrl);
    if (target.password) {
      secrets.push({ password: target.password });
    }
  } catch (err) {
    throw toQueryError(err, secrets);
  }

  // Set when the main connection was closed by anything but close(): the library opens a new one by
  // itself at the next query, and what the old one held is gone. Reported once by takeLostConnection.
  let mainConnectionLost = false;
  let closed = false;
  const user = createClient(target, () => {
    if (!closed) mainConnectionLost = true;
  });
  const side = createClient(target);

  try {
    await user.unsafe("select 1");
  } catch (err) {
    await Promise.allSettled([user.end({ timeout: 0 }), side.end({ timeout: 0 })]);
    throw toQueryError(err, secrets);
  }


  const typeNames = new Map<number, string>(SEEDED_TYPE_NAMES);
  const activeQueries = new Set<() => Promise<unknown>>();
  let readOnlyChain: Promise<void> = Promise.resolve();
  let closingPromise: Promise<void> | null = null;

  async function resolveTypeNames(oids: number[]): Promise<void> {
    const missing = [...new Set(oids.filter((oid) => !typeNames.has(oid)))];
    if (missing.length === 0) return;

    const rows = await side.unsafe<{ oid: string | number; typname: string }[]>(
      "select oid::bigint as oid, typname from pg_type where oid = any($1)",
      [missing],
    );
    for (const row of rows) {
      typeNames.set(Number(row.oid), row.typname);
    }
    for (const oid of missing) {
      if (!typeNames.has(oid)) {
        typeNames.set(oid, String(oid));
      }
    }
  }

  async function executeQuery(
    client: postgres.ISql<{
      int8: string;
      numeric: string;
      date: string;
      time: string;
      timestamp: string;
      interval: string;
      timetz: string;
    }>,
    statement: string,
    max: number,
    signal: AbortSignal | undefined,
    timeoutMs: number | undefined,
    useClientTimer: boolean,
  ): Promise<{
    rawColumns: { name: string; type: number }[];
    rows: Cell[][];
    truncated: boolean;
    command: string;
    count: number | null;
  }> {
    const rows: Cell[][] = [];
    let truncated = false;
    let rawColumns: { name: string; type: number }[] | undefined;

    const query = client.unsafe(statement).values();
    const cancelFn = () => query.cancel().catch(() => {});
    activeQueries.add(cancelFn);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      void cancelFn();
    };

    if (closed) {
      onAbort();
    } else if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    if (useClientTimer && timeoutMs !== undefined && timeoutMs > 0) {
      timer = setTimeout(() => {
        void cancelFn();
      }, timeoutMs);
    }

    try {
      const res = await query.cursor(200, (batch: unknown[][]) => {
        const batchWithMeta = batch as unknown[][] & {
          columns?: { name: string; type: number }[];
        };
        if (!rawColumns && Array.isArray(batchWithMeta.columns)) {
          rawColumns = batchWithMeta.columns;
        }
        for (const rawRow of batch) {
          if (rows.length < max) {
            rows.push(rawRow.map((cell) => normalizeCell(cell)));
          } else {
            truncated = true;
            return user.CLOSE;
          }
        }
        return undefined;
      });

      const resWithMeta = res as unknown as {
        columns?: { name: string; type: number }[];
        command?: string | null;
        count?: number | null;
      };
      if (!rawColumns && Array.isArray(resWithMeta.columns)) {
        rawColumns = resWithMeta.columns;
      }

      const finalColumns = rawColumns ?? [];
      const command =
        typeof resWithMeta.command === "string" && resWithMeta.command.length > 0
          ? resWithMeta.command
          : finalColumns.length > 0
            ? "SELECT"
            : "";
      const count = typeof resWithMeta.count === "number" ? resWithMeta.count : null;

      return {
        rawColumns: finalColumns,
        rows,
        truncated,
        command,
        count,
      };
    } finally {
      activeQueries.delete(cancelFn);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    }
  }

  function acquireReadOnlyTurn(
    prevTurn: Promise<void>,
    signal: AbortSignal | undefined,
    timeoutMs: number | undefined,
  ): Promise<void> {
    if (closed) {
      return Promise.reject(new QueryError("the Session is closed"));
    }
    if (signal?.aborted) {
      return Promise.reject(
        new QueryError("canceling statement due to user request", { code: "57014" }),
      );
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        activeQueries.delete(cancelWait);
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
      };

      const cancelWait = async () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new QueryError("the Session is closed"));
      };

      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new QueryError("canceling statement due to user request", { code: "57014" }));
      };

      activeQueries.add(cancelWait);
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new QueryError("canceling statement due to statement timeout", { code: "57014" }));
        }, timeoutMs);
      }

      void prevTurn.then(() => {
        if (settled) return;
        settled = true;
        cleanup();
        if (closed) {
          reject(new QueryError("the Session is closed"));
          return;
        }
        resolve();
      });
    });
  }

  return {
    connection,

    async run(statement: string, runOpts?: RunOptions): Promise<Result> {
      if (closed) {
        throw new QueryError("the Session is closed");
      }

      refuseNulCharacter(statement);

      if (splitStatements(statement).length === 0) {
        throw new QueryError("nothing to run");
      }

      const start = performance.now();
      const max = runOpts?.maxRows ?? DEFAULT_MAX_ROWS;
      const isReadOnly = Boolean(runOpts?.readOnly);
      const timeoutMs = runOpts?.timeoutMs;
      const signal = runOpts?.signal;

      if (isReadOnly && classify(statement) !== "read") {
        throw new QueryError("attempt to write a readonly database", { code: "25006" });
      }

      try {
        // Read-only guarantees: the Statement gate (classify(statement) === "read") plus a
        // read-only transaction (BEGIN READ ONLY) that is always rolled back, followed by
        // resetting session parameters and releasing advisory locks on the side connection.
        // It does not prevent functions with side effects outside the transaction (for example
        // pg_terminate_backend or pg_notify).
        const execResult = isReadOnly
          ? await (() => {
              const prevTurn = readOnlyChain;
              let releaseTurn!: () => void;
              readOnlyChain = new Promise<void>((r) => {
                releaseTurn = r;
              });

              return (async () => {
                let tookTurn = false;
                try {
                  await acquireReadOnlyTurn(prevTurn, signal, timeoutMs);
                  tookTurn = true;
                  try {
                    const hasTimeout =
                      timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0;
                    let remainingMs: number | undefined;
                    if (hasTimeout) {
                      const elapsed = performance.now() - start;
                      const rem = timeoutMs - elapsed;
                      if (rem <= 0) {
                        throw new QueryError("canceling statement due to statement timeout", {
                          code: "57014",
                        });
                      }
                      remainingMs = Math.max(1, Math.floor(rem));
                    }

                    return await side.begin("read only", async (tx) => {
                      if (remainingMs !== undefined) {
                        await tx.unsafe(`set local statement_timeout = ${remainingMs}; select 1`);
                      }
                      try {
                        return await executeQuery(tx, statement, max, signal, remainingMs, false);
                      } finally {
                        await tx.rollback().catch(() => {});
                      }
                    });
                  } finally {
                    if (!closed) {
                      await side
                        .unsafe("reset all; select pg_advisory_unlock_all()")
                        .catch(() => {});
                    }
                  }
                } finally {
                  if (tookTurn) {
                    releaseTurn();
                  } else {
                    void prevTurn.then(releaseTurn);
                  }
                }
              })();
            })()
          : await executeQuery(user, statement, max, signal, timeoutMs, true);

        const { rawColumns, rows, truncated, command, count } = execResult;

        if (rawColumns.length === 0) {
          const durationMs = performance.now() - start;
          return {
            columns: [],
            rows: [],
            truncated: false,
            affected: count,
            command,
            durationMs,
          };
        }

        await resolveTypeNames(rawColumns.map((c) => c.type));
        const columns: Column[] = rawColumns.map((c) => ({
          name: c.name,
          type: typeNames.get(c.type) ?? String(c.type),
        }));

        const durationMs = performance.now() - start;
        return {
          columns,
          rows,
          truncated,
          affected: null,
          command,
          durationMs,
        };
      } catch (err) {
        throw toQueryError(err, secrets);
      }
    },

    async schema(): Promise<SchemaSnapshot> {
      if (closed) {
        throw new QueryError("the Session is closed");
      }

      const activeSchemaQueries = new Set<{ cancel: () => Promise<void> }>();
      let rejectOnClose: ((err: QueryError) => void) | null = null;
      const closeInterrupt = new Promise<never>((_, reject) => {
        rejectOnClose = reject;
      });
      const cancelSchema = async () => {
        rejectOnClose?.(new QueryError("the Session is closed"));
        await Promise.allSettled(
          [...activeSchemaQueries].map((q) => q.cancel().catch(() => {})),
        );
      };
      activeQueries.add(cancelSchema);

      const trackSchemaQuery = <T extends object>(q: Promise<T> & { cancel: () => Promise<void> }): Promise<T> => {
        activeSchemaQueries.add(q);
        return q.finally(() => {
          activeSchemaQueries.delete(q);
        });
      };

      try {
        return await Promise.race([
          closeInterrupt,
          (async (): Promise<SchemaSnapshot> => {
            const relRows = await trackSchemaQuery(
              side.unsafe<{ oid: number; nspname: string; relname: string; relkind: string }[]>(
                "select c.oid::int as oid, n.nspname, c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r','p','v','m') and n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp%' order by n.nspname, c.relname",
              ),
            );

            if (relRows.length === 0) {
              return { dialect: "postgres", namespaces: [] };
            }

            const relOids = relRows.map((r) => Number(r.oid));

            const [colRows, pkRows, fkRows] = await Promise.all([
              trackSchemaQuery(
                side.unsafe<
                  {
                    rel_oid: number;
                    attnum: number;
                    name: string;
                    type: string;
                    notnull: boolean;
                  }[]
                >(
                  "select a.attrelid::int as rel_oid, a.attnum::int as attnum, a.attname as name, t.typname as type, a.attnotnull as notnull from pg_attribute a join pg_type t on t.oid = a.atttypid where a.attrelid = any($1) and a.attnum > 0 and not a.attisdropped order by a.attrelid, a.attnum",
                  [relOids],
                ),
              ),
              trackSchemaQuery(
                side.unsafe<{ rel_oid: number; attnum: number }[]>(
                  "select conrelid::int as rel_oid, unnest(conkey)::int as attnum from pg_constraint where conrelid = any($1) and contype = 'p'",
                  [relOids],
                ),
              ),
              trackSchemaQuery(
                side.unsafe<
                  {
                    rel_oid: number;
                    attnum: number;
                    ref_schema: string;
                    ref_table: string;
                    ref_column: string;
                  }[]
                >(
                  "select con.conrelid::int as rel_oid, u.attnum::int as attnum, fn.nspname as ref_schema, fc.relname as ref_table, fa.attname as ref_column from pg_constraint con cross join lateral unnest(con.conkey, con.confkey) as u(attnum, ref_attnum) join pg_class fc on fc.oid = con.confrelid join pg_namespace fn on fn.oid = fc.relnamespace join pg_attribute fa on fa.attrelid = con.confrelid and fa.attnum = u.ref_attnum where con.conrelid = any($1) and con.contype = 'f'",
                  [relOids],
                ),
              ),
            ]);

            const pkSet = new Set<string>();
            for (const pk of pkRows) {
              pkSet.add(`${pk.rel_oid}:${pk.attnum}`);
            }

            const fkMap = new Map<string, { relation: string; column: string }>();
            for (const fk of fkRows) {
              fkMap.set(`${fk.rel_oid}:${fk.attnum}`, {
                relation: `${fk.ref_schema}.${fk.ref_table}`,
                column: fk.ref_column,
              });
            }

            const colsByRel = new Map<number, RelationColumn[]>();
            for (const col of colRows) {
              const relOid = Number(col.rel_oid);
              const key = `${relOid}:${col.attnum}`;
              const relCol: RelationColumn = {
                name: col.name,
                type: col.type,
                nullable: !col.notnull,
                primaryKey: pkSet.has(key),
              };
              const ref = fkMap.get(key);
              if (ref) {
                relCol.references = ref;
              }
              let list = colsByRel.get(relOid);
              if (!list) {
                list = [];
                colsByRel.set(relOid, list);
              }
              list.push(relCol);
            }

            const namespaces: { name: string; relations: Relation[] }[] = [];
            const nsMap = new Map<string, Relation[]>();

            for (const rel of relRows) {
              let relations = nsMap.get(rel.nspname);
              if (!relations) {
                relations = [];
                nsMap.set(rel.nspname, relations);
                namespaces.push({ name: rel.nspname, relations });
              }
              relations.push({
                name: rel.relname,
                kind: rel.relkind === "r" || rel.relkind === "p" ? "table" : "view",
                columns: colsByRel.get(Number(rel.oid)) ?? [],
              });
            }

            return {
              dialect: "postgres",
              namespaces,
            };
          })(),
        ]);
      } catch (err) {
        if (closed) {
          throw new QueryError("the Session is closed");
        }
        throw toQueryError(err, secrets);
      } finally {
        activeQueries.delete(cancelSchema);
      }
    },

    takeLostConnection(): boolean {
      const lost = mainConnectionLost;
      mainConnectionLost = false;
      return lost;
    },

    async close(): Promise<void> {
      if (closingPromise) return closingPromise;
      closed = true;
      mainConnectionLost = false;
      closingPromise = (async () => {
        const cancellations = [...activeQueries].map((cancel) => cancel());
        await Promise.allSettled(cancellations);
        const endWithBound = async (c: typeof user) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              c.end({ timeout: 2 }).catch(() => {}),
              new Promise<void>((r) => {
                timer = setTimeout(r, 2000);
                timer.unref?.();
              }),
            ]);
          } finally {
            if (timer !== undefined) {
              clearTimeout(timer);
            }
          }
        };
        try {
          await endWithBound(side);
        } finally {
          await endWithBound(user);
        }
      })();
      return closingPromise;
    },
  };
}
