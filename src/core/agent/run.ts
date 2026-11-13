import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, ExecResult } from "../exec";
import { ProviderError, type ProviderErrorKind } from "./errors";
import type { ProviderAdapter, ProviderRequest } from "./providers/types";

export { ProviderError, type ProviderErrorKind } from "./errors";

export const MAX_PROVIDER_OUTPUT_BYTES = 8 * 1024 * 1024;

export function classifyProviderError(message: string): ProviderErrorKind {
  const lower = message.toLowerCase();
  if (
    lower.includes("usage limit") ||
    lower.includes("rate limit") ||
    lower.includes("quota") ||
    lower.includes("429")
  ) {
    return "quota";
  }
  if (
    lower.includes("not logged in") ||
    lower.includes("log in") ||
    lower.includes("login") ||
    lower.includes("unauthorized") ||
    lower.includes("authenticate") ||
    lower.includes("api key") ||
    lower.includes("401")
  ) {
    return "auth";
  }
  return "other";
}

const PG_LETTERS_ENV_REGEX = /^PG[A-Z]+$/;
const LOSQL_URL_ENV_REGEX = /^LOSQL_.*_URL$/;

function isDatabaseCredentialEnvName(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    upper === "DATABASE_URL" ||
    upper.endsWith("_DATABASE_URL") ||
    PG_LETTERS_ENV_REGEX.test(upper) ||
    upper.startsWith("PG_") ||
    upper.startsWith("POSTGRES") ||
    upper.startsWith("MYSQL") ||
    upper.startsWith("MARIADB") ||
    LOSQL_URL_ENV_REGEX.test(upper)
  );
}

/** A saved Connection as far as the environment is concerned: its URL may name variables as `${NAME}`. */
export interface ConnectionEnvSource {
  url: string;
}

/** The same placeholder `expandEnv` of the configuration replaces. */
const ENV_PLACEHOLDER_REGEX = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** The names of the variables the saved Connections read as `${NAME}` (a password, a user, a query parameter). */
export function connectionEnvNames(connections: readonly ConnectionEnvSource[]): Set<string> {
  const names = new Set<string>();
  for (const connection of connections) {
    for (const match of connection.url.matchAll(ENV_PLACEHOLDER_REGEX)) {
      names.add(match[1]!);
    }
  }
  return names;
}

/**
 * The environment every process losql starts for a Provider gets: without database credentials,
 * and without the variables any of `connections` (the saved Connections) reads as `${NAME}`.
 */
export function sanitizeEnv(
  source: Record<string, string | undefined>,
  connections: readonly ConnectionEnvSource[] = [],
): Record<string, string | undefined> {
  const referenced = connectionEnvNames(connections);
  const clean: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    if (isDatabaseCredentialEnvName(key) || referenced.has(key)) {
      continue;
    }
    clean[key] = value;
  }
  return clean;
}

export async function runProvider(
  adapter: ProviderAdapter,
  request: ProviderRequest,
  deps: {
    exec: Exec;
    binPath: string;
    env?: Record<string, string | undefined>;
    /** The saved Connections: the variables they read as `${NAME}` are not handed to the Provider. */
    connections?: readonly ConnectionEnvSource[];
    signal?: AbortSignal;
    timeoutMs?: number;
    onText?: (text: string) => void;
  },
): Promise<string> {
  const sanitizedRequest: ProviderRequest = {
    ...request,
    prompt: request.prompt.replaceAll("\0", "\uFFFD"),
    system: request.system.replaceAll("\0", "\uFFFD"),
  };
  const cmd = adapter.command(sanitizedRequest);
  const env = sanitizeEnv(deps.env ?? process.env, deps.connections);
  let cwd: string;
  try {
    cwd = await mkdtemp(join(tmpdir(), "losql-agent-"));
  } catch {
    throw new ProviderError("other", `${adapter.label} could not be run`);
  }

  // When the Turn is aborted, its directory goes at once, synchronously, before the abort reaches the
  // caller: a command line that ends shortly after a signal leaves nothing behind, even while the
  // Provider process is still ending. Nothing awaits between this and the start of the process.
  let removed = false;
  const removeNow = () => {
    if (removed) return;
    removed = true;
    try {
      rmSync(cwd, { recursive: true, force: true, maxRetries: 2 });
    } catch {
      // Ignore cleanup failure so it never replaces the outcome
    }
  };
  const signal = deps.signal;
  if (signal && !signal.aborted) signal.addEventListener("abort", removeNow, { once: true });

  try {
    const textParts: string[] = [];
    let lastFinal: string | undefined;
    let firstError: string | undefined;

    let result: ExecResult;
    try {
      result = await deps.exec({
        cmd: [deps.binPath, ...cmd.args],
        cwd,
        env,
        stdin: cmd.stdin,
        signal: deps.signal,
        timeoutMs: deps.timeoutMs,
        maxOutputBytes: MAX_PROVIDER_OUTPUT_BYTES,
        onStdoutLine: (line) => {
          const event = adapter.parse(line);
          if (!event) return;
          if (event.type === "text") {
            textParts.push(event.text);
            try {
              deps.onText?.(event.text);
            } catch {
              // Ignore listener errors
            }
          } else if (event.type === "final") {
            if (event.text.trim().length > 0) {
              lastFinal = event.text;
            }
          } else if (event.type === "error" && firstError === undefined) {
            firstError = event.message;
          }
        },
      });
    } catch (err) {
      const code =
        typeof err === "object" && err !== null && "code" in err
          ? (err as { code?: unknown }).code
          : undefined;
      if (code === "ENOENT") {
        throw new ProviderError("missing", `${adapter.label} could not be started: not found`);
      }
      if (code === "EACCES") {
        throw new ProviderError(
          "missing",
          `${adapter.label} could not be started: permission denied`,
        );
      }
      throw new ProviderError("other", `${adapter.label} could not be run`);
    }

    if (result.aborted) {
      removeNow();
      throw new ProviderError("cancelled", `${adapter.label} was cancelled`);
    }
    if (result.timedOut) {
      throw new ProviderError("timeout", `${adapter.label} did not answer in time`);
    }
    if (result.outputLimitHit) {
      throw new ProviderError("other", `${adapter.label} produced too much output`);
    }
    let lastNonBlankText = "";
    if (!adapter.streamingText) {
      for (let i = textParts.length - 1; i >= 0; i--) {
        if (textParts[i]!.trim().length > 0) {
          lastNonBlankText = textParts[i]!;
          break;
        }
      }
    }
    const fallbackText = adapter.streamingText ? textParts.join("") : lastNonBlankText;
    const rawReply = lastFinal !== undefined ? lastFinal : fallbackText;
    const reply = rawReply.trim();

    if (result.code === 0 && reply.length > 0) {
      return reply;
    }

    if (firstError !== undefined) {
      throw new ProviderError(classifyProviderError(firstError), firstError);
    }

    if (reply.length > 0) {
      return reply;
    }

    if (result.code !== 0) {
      const stderrLines = result.stderr
        .split(/\r?\n/)
        .filter((line) => !/^\s*at\s/.test(line))
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      if (stderrLines.length > 0) {
        const message = stderrLines[stderrLines.length - 1]!;
        let kind = classifyProviderError(message);
        if (kind === "other") {
          kind = classifyProviderError(stderrLines.join("\n"));
        }
        throw new ProviderError(kind, message);
      }
      throw new ProviderError(
        "other",
        `${adapter.label} exited with code ${result.code} and no output`,
      );
    }

    throw new ProviderError("other", `${adapter.label} returned no text`);
  } finally {
    signal?.removeEventListener("abort", removeNow);
    if (!removed) {
      try {
        await rm(cwd, { recursive: true, force: true, maxRetries: 2 });
      } catch {
        // Ignore cleanup failure so it never replaces the outcome
      }
    }
  }
}
