import {
  createContext,
  createSignal,
  type JSX,
  onCleanup,
  type ParentProps,
  useContext,
} from "solid-js";
import { expandEnv } from "../../core/config";
import { parseConnection } from "../../core/db/connection";
import { extractPassword } from "../../core/db/postgres";
import { redactConnectionText, redactMessage } from "../../core/db/redact";
import {
  type Connection,
  type Driver,
  QueryError,
  type Result,
  type SchemaSnapshot,
} from "../../core/db/types";
import { classify } from "../../core/sql/classify";
import { appendHistory } from "../../core/state";
import { printable } from "../ui/printable";
import { useConfig } from "./config";
import { useDeps } from "./deps";
import { useKeys } from "./keys";
import { useStatus } from "./status";
import { useToast } from "./toast";

export type SessionStatus = "none" | "connecting" | "connected" | "disconnected";
export type RunOutcome =
  | { ok: true; statement: string; result: Result }
  | { ok: false; statement: string; error: QueryError };
export interface RunRequest {
  statements: string[];
  readOnly?: boolean;
  maxRows?: number;          // default config.results.maxRows
  record?: boolean;          // append to history; default true
  show?: boolean;            // make the outcome what the Results Pane shows; default true
}
export interface SessionApi {
  status(): SessionStatus;
  connection(): Connection | null;
  schema(): SchemaSnapshot | null;
  schemaError(): string | null;
  driver(): Driver | null;
  connect(input: string): Promise<{ ok: true } | { ok: false; message: string }>;   // a saved name, a URL or a path
  refreshSchema(): Promise<void>;
  run(request: RunRequest): Promise<RunOutcome[]>;      // in order, stopping at the first error
  explain(statement: string, analyze?: boolean, show?: boolean): Promise<RunOutcome[]>;   // show defaults to true
  running(): { statement: string; startedAt: number } | null;
  cancel(): boolean;                                    // true when a Run was in progress
  shown(): RunOutcome | null;                           // what the Results Pane shows
  show(outcome: RunOutcome | null): void;
  lastError(): Extract<RunOutcome, { ok: false }> | null;   // of the most recent recorded Run; cleared by a success
}

const LOST_CONNECTION_CODES = new Set([
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECTION_ENDED",
  "ECONNRESET",
  "EPIPE",
  "57P01",
]);

function isLostConnectionError(error: QueryError): boolean {
  return error.code !== undefined && LOST_CONNECTION_CODES.has(error.code);
}

export const REOPENED_WARNING =
  "The connection was lost and opened again. An open transaction, session settings and temporary tables are gone.";

const NOT_RUN_AGAIN =
  "The connection was lost and opened again; the statement was not run again because it may already have been applied.";

/** The original error, with the sentence that says why its Statement was not run again. */
function notRunAgain(error: QueryError): QueryError {
  const message = error.message.trimEnd();
  const joined = /[.!?]$/.test(message) || message === "" ? message : `${message}.`;
  const fields: { code?: string; position?: number; detail?: string; hint?: string } = {};
  if (error.code !== undefined) fields.code = error.code;
  if (error.position !== undefined) fields.position = error.position;
  if (error.detail !== undefined) fields.detail = error.detail;
  if (error.hint !== undefined) fields.hint = error.hint;
  return new QueryError(`${joined}${joined === "" ? "" : " "}${NOT_RUN_AGAIN}`, fields);
}

function toQueryError(err: unknown): QueryError {
  if (err instanceof QueryError) {
    return err;
  }
  const message = err instanceof Error ? err.message : String(err);
  return new QueryError(String(message));
}

const SessionContext = createContext<SessionApi>();

export function SessionProvider(
  props: ParentProps<{
    onQuit: (hook: () => void | Promise<void>) => void;
    expose?: (api: SessionApi) => void;
  }>,
): JSX.Element {
  const deps = useDeps();
  const config = useConfig();
  const status = useStatus();
  const toast = useToast();
  const keys = useKeys();

  const [sessionStatus, setSessionStatus] = createSignal<SessionStatus>("none");
  const [driverSignal, setDriverSignal] = createSignal<Driver | null>(null);
  const [schemaSignal, setSchemaSignal] = createSignal<SchemaSnapshot | null>(null);
  const [schemaErrorSignal, setSchemaErrorSignal] = createSignal<string | null>(null);
  const [runningSignal, setRunningSignal] = createSignal<{ statement: string; startedAt: number } | null>(null);
  const [shownSignal, setShownSignal] = createSignal<RunOutcome | null>(null);
  const [lastErrorSignal, setLastErrorSignal] = createSignal<Extract<RunOutcome, { ok: false }> | null>(null);

  let currentController: AbortController | null = null;
  let activeRun: { cancelled: boolean } | null = null;
  let connectGeneration = 0;
  let schemaSeq = 0;
  let historyWarned = false;
  let closing = false;

  const refreshSchema = async (): Promise<void> => {
    const activeDriver = driverSignal();
    if (!activeDriver) {
      status.say("No connection", "error");
      return;
    }
    const seq = ++schemaSeq;
    setSchemaErrorSignal(null);
    try {
      const snap = await activeDriver.schema();
      if (!closing && seq === schemaSeq && driverSignal() === activeDriver) {
        setSchemaErrorSignal(null);
        setSchemaSignal(snap);
      }
    } catch (err) {
      if (!closing && seq === schemaSeq && driverSignal() === activeDriver) {
        const message = err instanceof Error ? err.message : String(err);
        setSchemaErrorSignal(message);
        toast.show({
          message,
          kind: "warning",
        });
      }
    }
  };

  const connect = async (
    input: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> => {
    if (closing) {
      return { ok: false, message: "the application is closing" };
    }
    const trimmed = input.trim();
    const hadDriver = driverSignal() !== null;
    if (!hadDriver) {
      setSessionStatus("connecting");
    }

    const gen = ++connectGeneration;
    // The URLs that were tried, as written and with the environment expanded: hidden in an error.
    const tried: string[] = [];

    try {
      const saved = config.config().connections.find((c) => c.name === trimmed);
      const connection = saved
        ? parseConnection(saved.url, { name: saved.name, cwd: deps.cwd })
        : parseConnection(trimmed, { cwd: deps.cwd });
      tried.push(connection.url);
      try {
        tried.unshift(expandEnv(connection.url, deps.env));
      } catch {
        // a variable that is not set: the Driver reports it
      }

      const nextDriver = await deps.openSession(connection);

      if (closing || gen !== connectGeneration) {
        try {
          await nextDriver.close();
        } catch {
          // ignore
        }
        return { ok: false, message: "superseded by a newer connect" };
      }

      const prevDriver = driverSignal();
      setDriverSignal(nextDriver);
      setSessionStatus("connected");
      setShownSignal(null);
      setLastErrorSignal(null);
      setSchemaSignal(null);
      setSchemaErrorSignal(null);

      if (prevDriver && prevDriver !== nextDriver) {
        try {
          await prevDriver.close();
        } catch {
          // ignore close error on previous driver
        }
      }

      if (closing || driverSignal() !== nextDriver) {
        return { ok: false, message: "superseded by a newer connect" };
      }

      // What came from DATABASE_URL (at start or as the Connections dialog's choice) stays out of the
      // state file: the user keeps it in the environment so that it, and a password in it, is in no
      // file. The last Connection remembered before is kept.
      const envUrl = deps.env.DATABASE_URL?.trim();
      const fromEnv = !saved && envUrl !== undefined && envUrl !== "" && trimmed === envUrl;
      if (!fromEnv) {
        void config
          .setState({ lastConnection: saved ? saved.name : trimmed })
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            toast.show({
              message: printable(`State could not be saved: ${msg}`),
              kind: "warning",
            });
          });
      }

      void refreshSchema();

      return { ok: true };
    } catch (err) {
      if (!hadDriver && driverSignal() === null && gen === connectGeneration) {
        setSessionStatus("none");
      }
      // A second layer over the Driver's own: no Driver, wrapper or library error that repeats the URL
      // puts a password on screen.
      let message = err instanceof Error ? err.message : String(err);
      // The same secrets the Driver hides: the URL that was tried and the password it carries.
      for (const url of tried) message = redactMessage(message, { url, password: extractPassword(url) });
      return { ok: false, message: redactConnectionText(message) };
    }
  };

  const cancel = (): boolean => {
    if (runningSignal() === null || !activeRun) {
      return false;
    }
    activeRun.cancelled = true;
    currentController?.abort();
    return true;
  };

  const removeInterrupt = keys.onInterrupt(cancel);

  let closePromise: Promise<void> | null = null;
  const closeCurrentDriver = (): Promise<void> => {
    closing = true;
    connectGeneration++;
    setSchemaErrorSignal(null);
    if (closePromise) return closePromise;
    const activeDriver = driverSignal();
    if (!activeDriver) {
      return Promise.resolve();
    }
    setDriverSignal(null);
    closePromise = Promise.resolve()
      .then(() => activeDriver.close())
      .catch(() => {});
    return closePromise;
  };

  onCleanup(() => {
    removeInterrupt();
    void closeCurrentDriver();
  });

  props.onQuit(async () => {
    await closeCurrentDriver();
  });

  const run = async (request: RunRequest): Promise<RunOutcome[]> => {
    const heldDriver = driverSignal();
    if (!heldDriver) {
      status.say("Not connected (use :connect)", "error");
      return [];
    }
    let activeDriver: Driver = heldDriver;
    if (runningSignal() !== null || activeRun !== null) {
      status.say("A Run is already in progress");
      return [];
    }

    const outcomes: RunOutcome[] = [];
    const maxRows = request.maxRows ?? config.config().results.maxRows;
    const record = request.record ?? true;
    const show = request.show ?? true;
    let sawDdl = false;
    const runState = { cancelled: false };
    activeRun = runState;

    const isStillCurrent = () => !closing && driverSignal() === activeDriver;

    // Every time the Session's connection was opened again after a loss, by the Session or by the
    // client library on its own, the user is told once that what the old connection held is gone.
    const warnReopened = () => {
      toast.show({ message: REOPENED_WARNING, kind: "warning" });
    };
    const noticeSilentReopen = () => {
      if (isStillCurrent() && activeDriver.takeLostConnection?.()) {
        warnReopened();
      }
    };

    // Opens the Session again on the same Connection and makes it the Session's Driver. Null when it
    // could not be opened, or when the Session changed meanwhile (then the new Driver is closed).
    const reopen = async (): Promise<Driver | null> => {
      let reopened: Driver;
      try {
        reopened = await deps.openSession(activeDriver.connection);
      } catch {
        if (isStillCurrent()) {
          setSessionStatus("disconnected");
        }
        return null;
      }
      if (!isStillCurrent() || runState.cancelled) {
        void reopened.close().catch(() => {});
        return null;
      }
      const prev = activeDriver;
      activeDriver = reopened;
      setDriverSignal(reopened);
      setSessionStatus("connected");
      void prev.close().catch(() => {});
      warnReopened();
      return reopened;
    };

    try {
      // A Session that already knew its connection was lost is opened again before the Run, and the
      // Statement is then sent once. When it cannot be opened, the held Driver is tried once.
      if (sessionStatus() !== "connected" && request.statements.length > 0) {
        setRunningSignal({ statement: request.statements[0]!, startedAt: deps.clock.now() });
        await reopen();
        if (!isStillCurrent()) {
          return outcomes;
        }
      }

      for (const statement of request.statements) {
        const startedAt = deps.clock.now();
        const wallStart = deps.now();
        setRunningSignal({ statement, startedAt });

        if (runState.cancelled) {
          const cancelledOutcome: RunOutcome = {
            ok: false,
            statement,
            error: new QueryError("cancelled"),
          };
          outcomes.push(cancelledOutcome);
          if (isStillCurrent() && record) {
            try {
              await appendHistory(deps.paths, {
                ts: new Date(deps.now()).toISOString(),
                connection: activeDriver.connection.id,
                sql: statement,
                ok: false,
                rows: null,
                ms: 0,
              });
            } catch (err) {
              if (!historyWarned) {
                historyWarned = true;
                const msg = err instanceof Error ? err.message : String(err);
                toast.show({
                  message: printable(`History could not be saved: ${msg}`),
                  kind: "warning",
                });
              }
            }
          }
          break;
        }

        const controller = new AbortController();
        currentController = controller;

        // A loss the Driver noticed before this Statement: nothing of it was sent on the old
        // connection, so it runs as usual on the new one.
        noticeSilentReopen();

        let outcome: RunOutcome;
        try {
          let result: Result;
          try {
            result = await activeDriver.run(statement, {
              maxRows,
              readOnly: request.readOnly,
              signal: controller.signal,
            });
          } catch (err) {
            const qErr = toQueryError(err);
            if (isLostConnectionError(qErr) && !controller.signal.aborted && !runState.cancelled && isStillCurrent()) {
              // The Session is opened again once. Only a read is sent again: a write may already have
              // been applied by the server before the connection broke.
              const reopened = await reopen();
              if (!reopened) {
                throw qErr;
              }
              if (classify(statement) !== "read") {
                throw notRunAgain(qErr);
              }
              result = await reopened.run(statement, {
                maxRows,
                readOnly: request.readOnly,
                signal: controller.signal,
              });
            } else {
              throw qErr;
            }
          }
          if (isStillCurrent()) {
            setSessionStatus("connected");
          }
          outcome = { ok: true, statement, result };
        } catch (err) {
          outcome = { ok: false, statement, error: toQueryError(err) };
        }
        noticeSilentReopen();

        outcomes.push(outcome);

        if (!isStillCurrent()) {
          break;
        }

        if (record) {
          const rawMs = outcome.ok
            ? outcome.result.durationMs
            : Math.max(0, deps.now() - wallStart);
          const ms = Math.round(rawMs);
          try {
            await appendHistory(deps.paths, {
              ts: new Date(deps.now()).toISOString(),
              connection: activeDriver.connection.id,
              sql: statement,
              ok: outcome.ok,
              rows: outcome.ok ? outcome.result.rows.length : null,
              ms,
            });
          } catch (err) {
            if (!historyWarned) {
              historyWarned = true;
              const msg = err instanceof Error ? err.message : String(err);
              toast.show({
                message: printable(`History could not be saved: ${msg}`),
                kind: "warning",
              });
            }
          }
        }

        if (!isStillCurrent()) {
          break;
        }

        if (outcome.ok) {
          if (classify(statement) === "ddl") {
            sawDdl = true;
          }
        } else {
          break;
        }
      }
    } finally {
      currentController = null;
      activeRun = null;
      setRunningSignal(null);
    }

    if (isStillCurrent()) {
      const errorOutcome = outcomes.find(
        (o): o is Extract<RunOutcome, { ok: false }> => !o.ok,
      );

      if (show && outcomes.length > 0) {
        if (errorOutcome) {
          setShownSignal(errorOutcome);
        } else {
          let withColumns: RunOutcome | null = null;
          for (let i = outcomes.length - 1; i >= 0; i--) {
            const item = outcomes[i]!;
            if (item.ok && item.result.columns.length > 0) {
              withColumns = item;
              break;
            }
          }
          setShownSignal(withColumns ?? outcomes[outcomes.length - 1]!);
        }
      }

      if (record && outcomes.length > 0) {
        setLastErrorSignal(errorOutcome ?? null);
      }

      if (sawDdl) {
        void refreshSchema();
      }
    }

    return outcomes;
  };

  const explain = async (
    statement: string,
    analyze?: boolean,
    show = true,
  ): Promise<RunOutcome[]> => {
    const activeDriver = driverSignal();
    const dialect = activeDriver?.connection.dialect ?? "sqlite";
    let sql: string;
    if (dialect === "postgres") {
      sql = analyze
        ? `explain (analyze, buffers) ${statement}`
        : `explain ${statement}`;
    } else {
      sql = `explain query plan ${statement}`;
    }
    return run({
      statements: [sql],
      readOnly: true,
      record: false,
      show,
    });
  };

  const api: SessionApi = {
    status: sessionStatus,
    connection: () => driverSignal()?.connection ?? null,
    schema: schemaSignal,
    schemaError: () => (driverSignal() === null ? null : schemaErrorSignal()),
    driver: driverSignal,
    connect,
    refreshSchema,
    run,
    explain,
    running: runningSignal,
    cancel,
    shown: shownSignal,
    show: (outcome) => {
      setShownSignal(outcome);
    },
    lastError: lastErrorSignal,
  };

  props.expose?.(api);

  return <SessionContext.Provider value={api}>{props.children}</SessionContext.Provider>;
}

export function useSession(): SessionApi {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within a SessionProvider");
  return ctx;
}
