import { homedir } from "node:os";
import type { ParsedArgs } from "./args";
import { escapeControl } from "./terminal-text";
import { describeProviderError, providerHintSource } from "../core/agent/advice";
import { detectProviders } from "../core/agent/detect";
import { runAgent } from "../core/agent/loop";
import { PROVIDERS } from "../core/agent/providers";
import { runProvider } from "../core/agent/run";
import { loadConfig, PROVIDER_IDS, type ProviderId } from "../core/config";
import { ConnectionError, openSession, parseConnection } from "../core/db/connection";
import { resultToCsv, resultToJson, resultToTable } from "../core/db/format";
import { type Connection, QueryError, type Result } from "../core/db/types";
import { bunExec, type Exec } from "../core/exec";
import { resolvePaths } from "../core/paths";
import { splitStatements } from "../core/sql/statements";
import { loadState } from "../core/state";

export interface CliDeps {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  stdin: () => Promise<string>;
  env: Record<string, string | undefined>;
  home: string;
  cwd: string;
  exec: Exec;
  which: (bin: string) => string | null;
  signal?: AbortSignal;
  tty?: { stdout: boolean; stderr: boolean };
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const pendingWrites = new Set<Promise<void>>();
let firstStdoutWriteError: Error | null = null;

function isBrokenPipeError(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: unknown }).code === "EPIPE",
  );
}

function recordStreamError(stream: NodeJS.WriteStream, err: unknown): void {
  if (!err || isBrokenPipeError(err)) return;
  if (stream === process.stdout && !firstStdoutWriteError) {
    firstStdoutWriteError = err instanceof Error ? err : new Error(String(err));
  }
}

export function consumeStdoutWriteError(): Error | null {
  const err = firstStdoutWriteError;
  firstStdoutWriteError = null;
  return err;
}

function safeWrite(stream: NodeJS.WriteStream, text: string): void {
  if (text.length === 0) return;
  if (stream.destroyed || stream.writableEnded) return;
  if (stream.errored) {
    recordStreamError(stream, stream.errored);
    return;
  }
  let settled = false;
  let tracked!: Promise<void>;
  tracked = new Promise<void>((resolve) => {
    const onError = (err: unknown) => {
      recordStreamError(stream, err);
      done();
    };
    const done = () => {
      if (settled) return;
      settled = true;
      stream.off("error", onError);
      stream.off("close", done);
      pendingWrites.delete(tracked);
      resolve();
    };
    stream.once("error", onError);
    stream.once("close", done);
    try {
      stream.write(text, (err) => {
        if (err) {
          recordStreamError(stream, err);
        }
        done();
      });
    } catch (err) {
      recordStreamError(stream, err);
      done();
    }
  });
  if (!settled) {
    pendingWrites.add(tracked);
  }
}

function flushStream(stream: NodeJS.WriteStream): Promise<void> {
  if (stream.destroyed || stream.writableEnded) {
    return Promise.resolve();
  }
  if (stream.errored) {
    recordStreamError(stream, stream.errored);
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    const onError = (err: unknown) => {
      recordStreamError(stream, err);
      done();
    };
    const done = () => {
      if (settled) return;
      settled = true;
      stream.off("error", onError);
      stream.off("close", done);
      resolve();
    };
    stream.once("error", onError);
    stream.once("close", done);
    try {
      stream.write("", (err) => {
        if (err) {
          recordStreamError(stream, err);
        }
        done();
      });
    } catch (err) {
      recordStreamError(stream, err);
      done();
    }
  });
}

export async function flushCliStreams(): Promise<void> {
  while (pendingWrites.size > 0) {
    await Promise.all([...pendingWrites]);
  }
  await Promise.all([flushStream(process.stdout), flushStream(process.stderr)]);
}

/**
 * Runs a headless command with SIGINT/SIGTERM handling in three phases:
 * - while the command works: the work is cancelled, `losql: interrupted` is printed, exit 130/143;
 *   the command is waited for at most `graceMs` (1,000 ms by default), so work that does not watch the
 *   abort (a read of standard input, a connect) does not hold the process; output it already wrote is
 *   not waited for (a reader that has stalled does not hold the process);
 * - while its output is still being written: writing stops at once (the pending flush is abandoned),
 *   `losql: interrupted` is printed, exit 130/143 (the output is incomplete);
 * - after everything was written: the command's own code stands and nothing more is printed.
 * In every phase a second signal calls `onForceExit` at once.
 */
export async function runHeadlessWithSignals(opts: {
  runCommand: (signal: AbortSignal) => Promise<number>;
  rawStdout: (text: string) => void;
  rawStderr: (text: string) => void;
  subscribeSignals?: (handler: (sig: "SIGINT" | "SIGTERM") => void) => () => void;
  flush?: () => Promise<void>;
  onForceExit?: (code: 130 | 143) => void;
  /** How long the command is waited for after the first signal; 1,000 ms by default. */
  graceMs?: number;
}): Promise<number> {
  const controller = new AbortController();
  const graceMs = opts.graceMs ?? 1000;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let endGrace!: () => void;
  const graceOver = new Promise<{ kind: "grace" }>((resolve) => {
    endGrace = () => resolve({ kind: "grace" });
  });
  let phase: "working" | "writing" | "done" = "working";
  let signalSeen = false;
  let signalExitCode: 130 | 143 | null = null;
  let stopWriting!: () => void;
  const writingStopped = new Promise<"stopped">((resolve) => {
    stopWriting = () => resolve("stopped");
  });

  const handleSignal = (sig: "SIGINT" | "SIGTERM") => {
    const code = sig === "SIGINT" ? 130 : 143;
    if (signalSeen) {
      opts.onForceExit?.(code);
      return;
    }
    signalSeen = true;
    if (phase === "done") {
      return;
    }
    signalExitCode = code;
    opts.rawStderr("losql: interrupted\n");
    controller.abort();
    stopWriting();
    if (phase === "working") {
      graceTimer = setTimeout(endGrace, graceMs);
    }
  };

  /** Waits for the output to be written; false when a signal stopped the writing first. */
  const flushUnlessStopped = async (): Promise<boolean> => {
    if (!opts.flush) return true;
    if (phase === "writing" && signalExitCode !== null) return false;
    const outcome = await Promise.race([opts.flush().then(() => "flushed" as const), writingStopped]);
    return outcome === "flushed";
  };

  const unsubscribe = opts.subscribeSignals
    ? opts.subscribeSignals(handleSignal)
    : (() => {
        const onInt = () => handleSignal("SIGINT");
        const onTerm = () => handleSignal("SIGTERM");
        process.on("SIGINT", onInt);
        process.on("SIGTERM", onTerm);
        return () => {
          process.off("SIGINT", onInt);
          process.off("SIGTERM", onTerm);
        };
      })();

  let finalCode = 1;
  try {
    let running: Promise<number>;
    try {
      running = opts.runCommand(controller.signal);
    } catch (err) {
      running = Promise.reject(err);
    }
    const settled = await Promise.race([
      running.then(
        (code) => ({ kind: "returned" as const, code }),
        (err: unknown) => ({ kind: "threw" as const, err }),
      ),
      graceOver,
    ]);
    if (settled.kind === "grace") {
      // The command did not settle within the grace period after the signal: it is not waited for any
      // longer, and the caller ends the process.
      consumeStdoutWriteError();
      return signalExitCode ?? 1;
    }
    try {
      if (settled.kind === "threw") throw settled.err;
      finalCode = signalExitCode ?? settled.code;
    } catch (err) {
      if (signalExitCode !== null) {
        finalCode = signalExitCode;
      } else if (err instanceof UsageError) {
        opts.rawStderr(escapeControl(`losql: ${err.message}\n`));
        finalCode = 2;
      } else if (err instanceof QueryError) {
        opts.rawStderr(escapeControl(`losql: ${err.message}\n`));
        if (err.detail) opts.rawStderr(escapeControl(`detail: ${err.detail}\n`));
        if (err.hint) opts.rawStderr(escapeControl(`hint: ${err.hint}\n`));
        finalCode = 1;
      } else {
        const message = err instanceof Error ? err.message : String(err);
        opts.rawStderr(escapeControl(`losql: ${message}\n`));
        finalCode = 1;
      }
    }

    if (signalExitCode !== null) {
      // Interrupted while working: the flush is given up as in the writing phase, so a reader that
      // has stalled does not keep the process until a second signal.
      consumeStdoutWriteError();
      return signalExitCode;
    }

    phase = "writing";
    if (!(await flushUnlessStopped())) {
      return signalExitCode ?? 1;
    }
    const writeErr = consumeStdoutWriteError();
    if (writeErr) {
      opts.rawStderr(escapeControl(`losql: could not write output: ${writeErr.message}\n`));
      if (finalCode === 0) {
        finalCode = 1;
      }
      if (!(await flushUnlessStopped())) {
        return signalExitCode ?? 1;
      }
    }
    phase = "done";
    return finalCode;
  } finally {
    phase = "done";
    if (graceTimer !== null) clearTimeout(graceTimer);
    unsubscribe();
  }
}

/**
 * Returns a function to await after each Statement of a script: it gives the event loop a turn so that a
 * pending signal is delivered. The SQLite Driver runs a Statement synchronously, and a chain of awaits on
 * it moves on in microtasks only: without these turns a signal would not be seen until every Statement
 * has run. A turn costs more than a short Statement, so it is taken after the last Statement and
 * otherwise only when more than 20 ms have passed since the last one.
 */
function signalTurns(): (lastStatement: boolean) => Promise<void> {
  let lastTurn = performance.now();
  return async (lastStatement) => {
    if (!lastStatement && performance.now() - lastTurn <= 20) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    lastTurn = performance.now();
  };
}



function writeStdout(deps: CliDeps, text: string): void {
  deps.stdout(deps.tty?.stdout ? escapeControl(text) : text);
}

function writeStderr(deps: CliDeps, text: string): void {
  deps.stderr(escapeControl(text));
}

export function realCliDeps(): CliDeps {
  return {
    stdout: (text) => safeWrite(process.stdout, text),
    stderr: (text) => safeWrite(process.stderr, text),
    stdin: () => Bun.stdin.text(),
    env: process.env,
    home: homedir(),
    cwd: process.cwd(),
    exec: bunExec,
    which: (bin) => Bun.which(bin),
    tty: {
      stdout: Boolean(process.stdout.isTTY),
      stderr: Boolean(process.stderr.isTTY),
    },
  };
}

export async function resolveConnection(arg: string | undefined, deps: CliDeps): Promise<Connection> {
  const paths = resolvePaths(deps.env, deps.home);
  const { config } = await loadConfig(paths);

  let raw = arg?.trim();
  if (!raw) {
    const fromEnv = deps.env.DATABASE_URL?.trim();
    if (fromEnv) {
      raw = fromEnv;
    } else {
      const state = await loadState(paths);
      const fromState = state.lastConnection?.trim();
      if (fromState) {
        raw = fromState;
      }
    }
  }

  if (!raw) {
    throw new UsageError(
      "no connection: pass -c <connection>, set DATABASE_URL, or connect once in the TUI",
    );
  }

  try {
    const saved = config.connections.find((c) => c.name === raw);
    if (saved) {
      return parseConnection(saved.url, { name: saved.name, cwd: deps.cwd });
    }
    return parseConnection(raw, { cwd: deps.cwd });
  } catch (err) {
    if (err instanceof ConnectionError) {
      throw new UsageError(err.message);
    }
    throw err;
  }
}

export async function runExec(
  args: Extract<ParsedArgs, { kind: "exec" }>,
  deps: CliDeps,
): Promise<number> {
  const sql = args.sql === "-" ? await deps.stdin() : args.sql;
  const statements = splitStatements(sql);
  if (statements.length === 0) {
    throw new UsageError("exec: nothing to run");
  }

  const connection = await resolveConnection(args.connection, deps);
  const driver = await openSession(connection, { env: deps.env });
  try {
    let lastWithColumns: Result | null = null;
    let lastResult: Result | null = null;
    const letSignalsIn = signalTurns();

    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i]!;
      if (deps.signal?.aborted) {
        return 1;
      }
      let res: Result;
      try {
        res = await driver.run(stmt.text, {
          maxRows: args.maxRows,
          readOnly: args.readOnly,
          ...(deps.signal ? { signal: deps.signal } : {}),
        });
      } catch (err) {
        if (statements.length > 1 && !deps.signal?.aborted) {
          writeStderr(deps, `losql: statement ${i + 1} of ${statements.length} failed\n`);
        }
        throw err;
      }
      lastResult = res;
      if (res.columns.length > 0) {
        lastWithColumns = res;
      }
      await letSignalsIn(i === statements.length - 1);
      if (deps.signal?.aborted) {
        return 1;
      }
    }

    const chosen = lastWithColumns ?? lastResult!;
    if (chosen.columns.length === 0) {
      const summary = resultToTable(chosen);
      if (args.format === "json") {
        writeStdout(deps, `${resultToJson(chosen)}\n`);
        writeStderr(deps, summary);
      } else if (args.format === "csv") {
        writeStderr(deps, summary);
      } else {
        writeStdout(deps, summary);
      }
    } else if (args.format === "json") {
      writeStdout(deps, `${resultToJson(chosen)}\n`);
    } else if (args.format === "csv") {
      writeStdout(deps, resultToCsv(chosen));
    } else {
      writeStdout(deps, resultToTable(chosen));
    }

    if (chosen.truncated) {
      writeStderr(deps, "losql: more rows available (raise --max-rows)\n");
    }

    return 0;
  } finally {
    await driver.close();
  }
}

export async function runProviders(
  args: Extract<ParsedArgs, { kind: "providers" }>,
  deps: CliDeps,
): Promise<number> {
  // The saved Connections name the variables their passwords are read from; no Provider process gets them.
  const { config } = await loadConfig(resolvePaths(deps.env, deps.home));
  const connections = config.connections;
  const statuses = await detectProviders({ which: deps.which, exec: deps.exec, connections });

  if (deps.signal?.aborted) {
    return 1;
  }

  if (args.json) {
    writeStdout(deps, `${JSON.stringify(statuses, null, 2)}\n`);
    return 0;
  }

  for (const status of statuses) {
    if (deps.signal?.aborted) {
      return 1;
    }
    if (!status.installed || !status.path) {
      writeStdout(deps, `${status.label}  not found  (${status.installHint})\n`);
      continue;
    }

    let line = `${status.label}  ${status.version ?? "?"}  ${status.path}`;
    if (args.test) {
      const adapter = PROVIDERS[status.id];
      const start = performance.now();
      try {
        await runProvider(
          adapter,
          {
            prompt: "Reply with the single word: ok",
            system: "You are a connectivity check. Reply with one word.",
          },
          {
            exec: deps.exec,
            binPath: status.path,
            env: deps.env,
            connections,
            ...(deps.signal ? { signal: deps.signal } : {}),
            timeoutMs: 60000,
          },
        );
        const seconds = ((performance.now() - start) / 1000).toFixed(1);
        line += `  replied in ${seconds}s`;
      } catch (err) {
        if (deps.signal?.aborted) {
          return 1;
        }
        const message = err instanceof Error ? err.message : String(err);
        line += `  failed: ${message}`;
      }
    }
    if (deps.signal?.aborted) {
      return 1;
    }
    writeStdout(deps, `${line}\n`);
  }

  return 0;
}

function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

export async function runAsk(
  args: Extract<ParsedArgs, { kind: "ask" }>,
  deps: CliDeps,
): Promise<number> {
  if (args.provider !== undefined && !isProviderId(args.provider)) {
    throw new UsageError(`unknown provider ${args.provider}`);
  }

  const paths = resolvePaths(deps.env, deps.home);
  const { config } = await loadConfig(paths);
  const statuses = await detectProviders({ which: deps.which, exec: deps.exec, connections: config.connections });

  if (deps.signal?.aborted) {
    return 1;
  }

  const chosenId: ProviderId | null =
    (args.provider as ProviderId | undefined) ??
    config.agent.provider ??
    statuses.find((s) => s.installed)?.id ??
    null;

  if (chosenId === null) {
    writeStderr(deps, 'losql: no provider is installed (run "losql providers" to see what is supported)\n');
    return 1;
  }

  const status = statuses.find((s) => s.id === chosenId)!;
  if (!status.installed || !status.path) {
    writeStderr(deps, `losql: ${status.label} is not installed (${status.installHint})\n`);
    return 1;
  }

  const adapter = PROVIDERS[chosenId];
  const binPath = status.path;
  const model =
    args.model ??
    (chosenId === config.agent.provider ? (config.agent.model ?? undefined) : undefined);

  const connection = await resolveConnection(args.connection, deps);
  const driver = await openSession(connection, { env: deps.env });
  try {
    const outcome = await runAgent(
      {
        intent: "ask",
        text: args.question,
        conversation: [],
      },
      {
        driver,
        config: config.agent,
        ...(deps.signal ? { signal: deps.signal } : {}),
        ask: (prompt, system, onText) =>
          runProvider(
            adapter,
            { prompt, system, ...(model !== undefined ? { model } : {}) },
            {
              exec: deps.exec,
              binPath,
              env: deps.env,
              connections: config.connections,
              ...(deps.signal ? { signal: deps.signal } : {}),
              timeoutMs: config.agent.stepTimeoutMs,
              onText,
            },
          ),
      },
      (event) => {
        if (deps.signal?.aborted) return;
        if (event.type === "step") {
          const { action } = event.step;
          if (action.action === "query") {
            writeStderr(deps, `losql: query ${escapeControl(action.sql).replace(/\s+/g, " ").trim()}\n`);
          } else if (action.action === "describe") {
            writeStderr(deps, `losql: describe ${escapeControl(action.relations.join(", "))}\n`);
          }
        }
      },
    );

    if (deps.signal?.aborted) {
      return 1;
    }

    if (!outcome.ok) {
      // The same message and hint the interface shows for a Provider error of this kind.
      const { message, hint } = describeProviderError(outcome.kind, outcome.message, providerHintSource(adapter));
      writeStderr(deps, `losql: ${message}\n`);
      if (hint.length > 0) {
        writeStderr(deps, `${hint}\n`);
      }
      return 1;
    }

    if (outcome.message) {
      writeStderr(deps, `${outcome.message}\n`);
    }

    if (outcome.sql !== undefined && outcome.sql.length > 0) {
      writeStdout(deps, `${outcome.sql}\n`);
      if (args.run) {
        const statements = splitStatements(outcome.sql);
        let lastWithColumns: Result | null = null;
        let lastResult: Result | null = null;
        const letSignalsIn = signalTurns();
        for (const [i, stmt] of statements.entries()) {
          if (deps.signal?.aborted) {
            return 1;
          }
          const res = await driver.run(stmt.text, {
            readOnly: true,
            ...(deps.signal ? { signal: deps.signal } : {}),
          });
          lastResult = res;
          if (res.columns.length > 0) {
            lastWithColumns = res;
          }
          await letSignalsIn(i === statements.length - 1);
          if (deps.signal?.aborted) {
            return 1;
          }
        }
        const chosen = lastWithColumns ?? lastResult;
        if (chosen) {
          writeStdout(deps, resultToTable(chosen));
        }
      }
    }

    return 0;
  } finally {
    await driver.close();
  }
}
