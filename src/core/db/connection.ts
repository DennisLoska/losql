import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { computeEffectivePostgresTarget, type EffectivePostgresTarget } from "./postgres";
import { redactConnectionInput } from "./redact";
import { openSqlite } from "./sqlite";
import type { Connection, Dialect, Driver } from "./types";

export class ConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionError";
  }
}

const SQLITE_EXTENSIONS = [".db", ".sqlite", ".sqlite3", ".db3"];

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length > 0) {
    return slug;
  }
  const hash = BigInt.asUintN(64, BigInt(Bun.hash(value)));
  return `conn-${hash.toString(16)}`;
}

function makeId(dialect: Dialect, displayWithoutScheme: string, customName?: string): string {
  if (customName !== undefined) {
    return slugify(customName);
  }
  return slugify(`${dialect}-${displayWithoutScheme}`);
}

export function parseConnection(
  input: string,
  options?: { name?: string; cwd?: string; exists?: (path: string) => boolean },
): Connection {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new ConnectionError("empty connection");
  }

  const customName = options?.name !== undefined ? redactConnectionInput(options.name) : undefined;

  if (trimmed === ":memory:") {
    const name = customName ?? "memory";
    const id = customName !== undefined ? slugify(customName) : "memory";
    return {
      id,
      name,
      dialect: "sqlite",
      url: ":memory:",
      display: ":memory:",
    };
  }

  if (trimmed === "demo") {
    const name = customName ?? "demo";
    const id = customName !== undefined ? slugify(customName) : "demo";
    return {
      id,
      name,
      dialect: "sqlite",
      url: "demo",
      display: "demo",
    };
  }

  const pgSchemeMatch = trimmed.match(/^(postgres|postgresql):\/\//i);
  if (pgSchemeMatch) {
    const afterScheme = trimmed.slice(pgSchemeMatch[0].length);
    const normalizedUrl = `postgres://${afterScheme}`;
    let target: EffectivePostgresTarget;
    let ambiguousCredentials = false;
    try {
      if (/\s/.test(afterScheme)) {
        throw new Error("whitespace in URL");
      }
      const parsed = new URL(normalizedUrl);
      if (!parsed.username && !parsed.password && afterScheme.includes("@")) {
        ambiguousCredentials = true;
        throw new Error("ambiguous unencoded credentials");
      }
      target = computeEffectivePostgresTarget(parsed, normalizedUrl);
    } catch {
      const hint = ambiguousCredentials
        ? "; percent-encode special characters in the password"
        : "";
      throw new ConnectionError(
        `unsupported connection: ${redactConnectionInput(trimmed)} (use a postgres:// URL, a SQLite file path, or "demo"${hint})`,
      );
    }
    const userPart = target.user ? `${target.user}@` : "";
    const displayWithoutScheme = `${userPart}${target.host}:${target.port}/${target.database}`;
    const display = `postgres://${displayWithoutScheme}`;
    const url = normalizedUrl;
    const name = customName ?? (target.database || target.host);
    const id = makeId("postgres", displayWithoutScheme, customName);
    return {
      id,
      name,
      dialect: "postgres",
      url,
      display,
    };
  }

  const cwd = options?.cwd ?? process.cwd();
  const exists = options?.exists ?? existsSync;

  let rawPath: string | null = null;
  if (trimmed.startsWith("sqlite://")) {
    rawPath = trimmed.slice("sqlite://".length);
  } else if (trimmed.startsWith("sqlite:")) {
    rawPath = trimmed.slice("sqlite:".length);
  } else if (trimmed.startsWith("file://")) {
    rawPath = trimmed.slice("file://".length);
  } else if (trimmed.startsWith("file:")) {
    rawPath = trimmed.slice("file:".length);
  }

  if (rawPath !== null) {
    const absPath = resolve(cwd, rawPath);
    const name = customName ?? basename(absPath);
    const id = makeId("sqlite", absPath, customName);
    return {
      id,
      name,
      dialect: "sqlite",
      url: `sqlite:${absPath}`,
      display: absPath,
    };
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    throw new ConnectionError(
      `unsupported connection: ${redactConnectionInput(trimmed)} (use a postgres:// URL, a SQLite file path, or "demo")`,
    );
  }

  const absPath = resolve(cwd, trimmed);
  const lower = absPath.toLowerCase();
  const hasSqliteExt = SQLITE_EXTENSIONS.some((ext) => lower.endsWith(ext));

  if (hasSqliteExt || exists(absPath)) {
    const name = customName ?? basename(absPath);
    const id = makeId("sqlite", absPath, customName);
    return {
      id,
      name,
      dialect: "sqlite",
      url: `sqlite:${absPath}`,
      display: absPath,
    };
  }

  throw new ConnectionError(
    `unsupported connection: ${redactConnectionInput(trimmed)} (use a postgres:// URL, a SQLite file path, or "demo")`,
  );
}

export async function openSession(
  connection: Connection,
  options?: { env?: Record<string, string | undefined>; create?: boolean },
): Promise<Driver> {
  if (connection.dialect === "sqlite") {
    return openSqlite(connection, { create: options?.create });
  }
  const { openPostgres } = await import("./postgres");
  return openPostgres(connection, { env: options?.env });
}
