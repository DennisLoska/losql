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
  type RelationColumnDetail,
  type RelationConstraint,
  type RelationConstraintKind,
  type RelationDetails,
  type RelationIndex,
  type RelationRef,
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

/** Ordinary, partitioned and foreign tables are tables; views and materialized views are views. */
function relationKind(relkind: string): "table" | "view" {
  return relkind === "v" || relkind === "m" ? "view" : "table";
}

const CONSTRAINT_KINDS: Record<string, RelationConstraintKind> = {
  p: "PRIMARY KEY",
  u: "UNIQUE",
  f: "FOREIGN KEY",
  c: "CHECK",
};

const FK_ACTIONS: Record<string, string> = {
  a: "NO ACTION",
  r: "RESTRICT",
  c: "CASCADE",
  n: "SET NULL",
  d: "SET DEFAULT",
};

/**
 * Like Promise.all, but waits for every statement to settle before rejecting, so a slot is never
 * released while a sibling statement is still running on the side client.
 */
async function settleAll<T extends readonly unknown[]>(
  promises: readonly [...{ [K in keyof T]: Promise<T[K]> }],
): Promise<T> {
  const results = await Promise.allSettled(promises);
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
  return results.map((r) => (r as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

/** A text[] column as the client returns it (an array); anything else reads as no columns. */
function asTextArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  return [];
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
  // The tail of the exclusive queue for the side client: each holder runs alone on it, so a
  // read-only Run's transaction, its ROLLBACK and RESET ALL never interleave with other side work.
  let sideTail: Promise<void> = Promise.resolve();
  // Slots taken on the side queue and not yet released, waiting or running; 0 means it is idle.
  let sideOccupants = 0;
  let closingPromise: Promise<void> | null = null;

  const sessionClosedError = () => new QueryError("the Session is closed");
  const userCancelError = () =>
    new QueryError("canceling statement due to user request", { code: "57014" });
  const statementTimeoutError = () =>
    new QueryError("canceling statement due to statement timeout", { code: "57014" });

  /** Throws the canonical QueryError when the Session is closed or the caller gave up. */
  function checkSideCaller(signal: AbortSignal | undefined): void {
    if (closed) throw sessionClosedError();
    if (signal?.aborted) throw userCancelError();
  }

  /**
   * Resolves once `prevTurn` settles. A waiter that is aborted, times out or sees the Session close
   * is rejected at once; the caller still keeps its slot unreleased until `prevTurn` settles.
   */
  function waitForSideTurn(
    prevTurn: Promise<void>,
    signal: AbortSignal | undefined,
    timeoutMs: number | undefined,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (err?: QueryError) => {
        if (settled) return;
        settled = true;
        activeQueries.delete(cancelWait);
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (err) reject(err);
        else resolve();
      };
      const cancelWait = async () => finish(sessionClosedError());
      const onAbort = () => finish(userCancelError());

      activeQueries.add(cancelWait);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => finish(statementTimeoutError()), timeoutMs);
      }

      void prevTurn.then(() => {
        if (closed) finish(sessionClosedError());
        else if (signal?.aborted) finish(userCancelError());
        else finish();
      });
    });
  }

  /**
   * Runs `operation` alone on the side client. Callers are queued in the order they call; an
   * acquired slot is released in `finally`, and an abandoned waiter's slot is released only once its
   * predecessor settles, so no two operations ever overlap. With `interruptOnClose`, `close()`
   * rejects the caller at once while the slot stays held until the operation itself settles.
   */
  async function withSide<T>(
    operation: () => Promise<T>,
    options?: { signal?: AbortSignal; timeoutMs?: number; interruptOnClose?: boolean },
  ): Promise<T> {
    const signal = options?.signal;
    checkSideCaller(signal);

    const prevTurn = sideTail;
    let resolveTurn!: () => void;
    sideTail = new Promise<void>((resolve) => {
      resolveTurn = resolve;
    });
    sideOccupants++;
    let released = false;
    const releaseTurn = () => {
      if (released) return;
      released = true;
      sideOccupants--;
      resolveTurn();
    };

    try {
      await waitForSideTurn(prevTurn, signal, options?.timeoutMs);
    } catch (err) {
      void prevTurn.then(releaseTurn);
      throw err;
    }

    const held = (async () => {
      try {
        checkSideCaller(signal);
        return await operation();
      } finally {
        releaseTurn();
      }
    })();
    if (!options?.interruptOnClose) return held;

    let interrupt!: () => void;
    const closeInterrupt = new Promise<never>((_, reject) => {
      interrupt = () => reject(sessionClosedError());
    });
    const onClose = async () => interrupt();
    activeQueries.add(onClose);
    // The race may settle first; the operation's own outcome is then no longer awaited.
    held.catch(() => {});
    try {
      return await Promise.race([held, closeInterrupt]);
    } finally {
      activeQueries.delete(onClose);
    }
  }

  /**
   * One statement on the side client, only ever called inside a `withSide` slot. Its cancellation
   * is registered for `close()` and the caller's signal, and removed once it settles.
   */
  async function sideQuery<T extends object[]>(
    text: string,
    params: postgres.ParameterOrJSON<never>[],
    signal: AbortSignal | undefined,
  ): Promise<T> {
    checkSideCaller(signal);
    const query = side.unsafe<T>(text, params);
    const cancel = () => query.cancel().catch(() => {});
    const onAbort = () => {
      void cancel();
    };
    activeQueries.add(cancel);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await query;
    } finally {
      activeQueries.delete(cancel);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Looks up the uncached `oids` in pg_type and caches their names; an OID pg_type does not know is
   * cached as its number. Runs inside a `withSide` slot.
   */
  async function lookupTypeNames(oids: number[], signal: AbortSignal | undefined): Promise<void> {
    const missing = [...new Set(oids.filter((oid) => !typeNames.has(oid)))];
    if (missing.length === 0) return;

    const rows = await sideQuery<{ oid: string | number; typname: string }[]>(
      "select oid::bigint as oid, typname from pg_type where oid = any($1)",
      [missing],
      signal,
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

  /**
   * Fills the type name cache for a read-only Run's `oids`. Called only outside a `withSide` slot
   * (the queue is not reentrant), and takes its own short slot only on a cache miss. Both the wait
   * for that slot and the lookup itself end at `deadline` (the Run's timeout budget): the caller is
   * rejected at once with the statement-timeout QueryError and an in-flight lookup is canceled,
   * while the slot stays held until that lookup actually settles.
   */
  async function resolveTypeNames(
    oids: number[],
    signal: AbortSignal | undefined,
    deadline: number | undefined,
  ): Promise<void> {
    if (oids.every((oid) => typeNames.has(oid))) return;

    if (deadline === undefined) {
      await withSide(() => lookupTypeNames(oids, signal), { signal });
      return;
    }

    const timeoutMs = deadline - performance.now();
    if (timeoutMs <= 0) throw statementTimeoutError();

    const expiry = new AbortController();
    const lookupSignal = signal ? AbortSignal.any([signal, expiry.signal]) : expiry.signal;
    const lookup = withSide(() => lookupTypeNames(oids, lookupSignal), { signal, timeoutMs });
    // The deadline may win the race; the lookup's own outcome is then no longer awaited.
    lookup.catch(() => {});

    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expiry.abort();
        reject(statementTimeoutError());
      }, timeoutMs);
    });
    try {
      await Promise.race([lookup, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fills the type name cache for a user-connection Run's `oids` without ever waiting for a busy
   * side client: its work may be waiting for a lock the user's own open transaction holds. While it
   * is busy, uncached types show as their OIDs and are looked up in the background for later Runs.
   */
  async function resolveTypeNamesWithoutWaiting(oids: number[]): Promise<void> {
    if (oids.every((oid) => typeNames.has(oid))) return;

    if (sideOccupants === 0) {
      await withSide(() => lookupTypeNames(oids, undefined));
      return;
    }
    void withSide(() => lookupTypeNames(oids, undefined)).catch(() => {});
  }

  /** The Structure of one Relation; runs inside a `withSide` slot. Every value is a bound parameter. */
  async function describeOnSide(
    ref: RelationRef,
    signal: AbortSignal | undefined,
  ): Promise<RelationDetails | null> {
    const relRows = await sideQuery<{ oid: string; relkind: string; definition: string | null }[]>(
      "select c.oid::text as oid, c.relkind, case when c.relkind in ('v','m') then pg_get_viewdef(c.oid, true) end as definition from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relname = $2 and c.relkind in ('r','p','v','m','f')",
      [ref.namespace, ref.name],
      signal,
    );
    const rel = relRows[0];
    if (!rel) return null;

    const [columnRows, indexRows, constraintRows] = await settleAll([
      sideQuery<
        {
          name: string;
          type: string;
          notnull: boolean;
          generated_kind: string;
          identity: string;
          expr: string | null;
          pk_position: number | null;
        }[]
      >(
        "select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as notnull, a.attgenerated::text as generated_kind, a.attidentity::text as identity, pg_get_expr(ad.adbin, ad.adrelid) as expr, (select k.ord::int from pg_index i cross join lateral unnest(i.indkey::int2[]) with ordinality as k(attnum, ord) where i.indrelid = a.attrelid and i.indisprimary and k.ord <= i.indnkeyatts and k.attnum = a.attnum limit 1) as pk_position from pg_attribute a left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum where a.attrelid = $1::oid and a.attnum > 0 and not a.attisdropped order by a.attnum",
        [rel.oid],
        signal,
      ),
      sideQuery<
        {
          name: string;
          is_unique: boolean;
          is_primary: boolean;
          method: string | null;
          predicate: string | null;
          definition: string;
          nkey: number;
          columns: string[];
        }[]
      >(
        "select ic.relname as name, i.indisunique as is_unique, i.indisprimary as is_primary, am.amname as method, pg_get_expr(i.indpred, i.indrelid) as predicate, pg_get_indexdef(i.indexrelid) as definition, i.indnkeyatts::int as nkey, array(select pg_get_indexdef(i.indexrelid, s.pos, true) from generate_series(1, i.indnatts::int) as s(pos) order by s.pos) as columns from pg_index i join pg_class ic on ic.oid = i.indexrelid left join pg_am am on am.oid = ic.relam where i.indrelid = $1::oid order by i.indisprimary desc, ic.relname",
        [rel.oid],
        signal,
      ),
      sideQuery<
        {
          name: string;
          contype: string;
          definition: string | null;
          columns: string[];
          ref_namespace: string | null;
          ref_relation: string | null;
          ref_columns: string[];
          on_update: string;
          on_delete: string;
        }[]
      >(
        "select c.conname as name, c.contype::text as contype, pg_get_constraintdef(c.oid, true) as definition, array(select a.attname::text from unnest(c.conkey) with ordinality as k(attnum, ord) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum order by k.ord) as columns, fn.nspname as ref_namespace, fc.relname as ref_relation, array(select a.attname::text from unnest(c.confkey) with ordinality as k(attnum, ord) join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum order by k.ord) as ref_columns, c.confupdtype::text as on_update, c.confdeltype::text as on_delete from pg_constraint c left join pg_class fc on fc.oid = c.confrelid left join pg_namespace fn on fn.oid = fc.relnamespace where c.conrelid = $1::oid and c.contype in ('p','u','f','c') order by case c.contype when 'p' then 0 when 'u' then 1 when 'f' then 2 else 3 end, c.conname",
        [rel.oid],
        signal,
      ),
    ]);

    const columns: RelationColumnDetail[] = columnRows.map((row) => {
      const column: RelationColumnDetail = {
        name: row.name,
        type: row.type,
        nullable: !row.notnull,
        references: [],
      };
      if (row.generated_kind !== "") {
        column.generated = row.expr ?? (row.generated_kind === "v" ? "virtual" : "stored");
      } else if (row.identity === "a") {
        column.generated = "ALWAYS AS IDENTITY";
      } else if (row.identity === "d") {
        column.generated = "BY DEFAULT AS IDENTITY";
      } else if (row.expr !== null) {
        column.defaultValue = row.expr;
      }
      if (row.pk_position !== null) {
        column.primaryKeyPosition = Number(row.pk_position);
      }
      return column;
    });
    const columnsByName = new Map(columns.map((c) => [c.name, c]));

    const indexes: RelationIndex[] = indexRows.map((row) => {
      const all = asTextArray(row.columns);
      const keyCount = Number(row.nkey);
      const index: RelationIndex = {
        name: row.name,
        unique: row.is_unique,
        primary: row.is_primary,
        columns: all.slice(0, keyCount),
        definition: row.definition,
      };
      const included = all.slice(keyCount);
      if (included.length > 0) index.includedColumns = included;
      if (row.method) index.method = row.method;
      if (row.predicate !== null) index.predicate = row.predicate;
      return index;
    });

    const constraints: RelationConstraint[] = constraintRows.map((row) => {
      const localColumns = asTextArray(row.columns);
      const constraint: RelationConstraint = {
        name: row.name,
        kind: CONSTRAINT_KINDS[row.contype]!,
        columns: localColumns,
      };
      if (row.definition !== null) constraint.definition = row.definition;
      if (row.contype === "f" && row.ref_relation !== null) {
        const targetColumns = asTextArray(row.ref_columns);
        const onUpdate = FK_ACTIONS[row.on_update];
        const onDelete = FK_ACTIONS[row.on_delete];
        constraint.references = {
          ...(row.ref_namespace !== null ? { namespace: row.ref_namespace } : {}),
          relation: row.ref_relation,
          columns: targetColumns,
          ...(onUpdate ? { onUpdate } : {}),
          ...(onDelete ? { onDelete } : {}),
        };
        // conkey and confkey pair by ordinal position.
        localColumns.forEach((local, i) => {
          const target = targetColumns[i];
          const column = columnsByName.get(local);
          if (!column || target === undefined) return;
          column.references.push({
            ...(row.ref_namespace !== null ? { namespace: row.ref_namespace } : {}),
            relation: row.ref_relation!,
            column: target,
            constraintName: row.name,
            ...(onUpdate ? { onUpdate } : {}),
            ...(onDelete ? { onDelete } : {}),
          });
        });
      }
      return constraint;
    });

    const details: RelationDetails = {
      namespace: ref.namespace,
      name: ref.name,
      kind: relationKind(rel.relkind),
      columns,
      indexes,
      constraints,
    };
    if (rel.definition !== null) details.definition = rel.definition;
    return details;
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
        // The slot is held through ROLLBACK, RESET ALL and the advisory-lock release; the timeout
        // budget counts from the Run request, so time spent waiting for the slot is part of it.
        const execResult = isReadOnly
          ? await withSide(
              async () => {
                try {
                  const hasTimeout =
                    timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0;
                  let remainingMs: number | undefined;
                  if (hasTimeout) {
                    const elapsed = performance.now() - start;
                    const rem = timeoutMs - elapsed;
                    if (rem <= 0) throw statementTimeoutError();
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
              },
              { signal, timeoutMs },
            )
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

        // Outside the read-only slot (the queue is not reentrant). A read-only Run's lookup stays
        // within its timeout budget. A Run on the user connection may already have written, so a
        // late abort must not report it as canceled, and it never waits for a busy side client.
        const oids = rawColumns.map((c) => c.type);
        if (isReadOnly) {
          const hasTimeout =
            timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0;
          await resolveTypeNames(oids, signal, hasTimeout ? start + timeoutMs : undefined);
        } else {
          await resolveTypeNamesWithoutWaiting(oids);
        }
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
      try {
        return await withSide(
          async (): Promise<SchemaSnapshot> => {
            const relRows = await sideQuery<
              { oid: number; nspname: string; relname: string; relkind: string }[]
            >(
              "select c.oid::int as oid, n.nspname, c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r','p','v','m','f') and n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp%' order by n.nspname, c.relname",
              [],
              undefined,
            );

            if (relRows.length === 0) {
              return { dialect: "postgres", namespaces: [] };
            }

            const relOids = relRows.map((r) => Number(r.oid));

            const [colRows, pkRows, fkRows] = await settleAll([
              sideQuery<
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
                undefined,
              ),
              sideQuery<{ rel_oid: number; attnum: number }[]>(
                "select conrelid::int as rel_oid, unnest(conkey)::int as attnum from pg_constraint where conrelid = any($1) and contype = 'p'",
                [relOids],
                undefined,
              ),
              sideQuery<
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
                undefined,
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
                kind: relationKind(rel.relkind),
                columns: colsByRel.get(Number(rel.oid)) ?? [],
              });
            }

            return {
              dialect: "postgres",
              namespaces,
            };
          },
          { interruptOnClose: true },
        );
      } catch (err) {
        if (closed) {
          throw sessionClosedError();
        }
        throw toQueryError(err, secrets);
      }
    },

    async describeRelation(
      ref: RelationRef,
      options?: { signal?: AbortSignal },
    ): Promise<RelationDetails | null> {
      const signal = options?.signal;
      try {
        return await withSide(() => describeOnSide(ref, signal), {
          signal,
          interruptOnClose: true,
        });
      } catch (err) {
        if (closed) {
          throw sessionClosedError();
        }
        throw toQueryError(err, secrets);
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
