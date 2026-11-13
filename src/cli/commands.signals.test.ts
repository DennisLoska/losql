import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeClaude } from "../core/agent/testing";
import { type CliDeps, runAsk, runExec, runHeadlessWithSignals } from "./commands";

type Sig = "SIGINT" | "SIGTERM";

function seam() {
  const state = {
    stderr: "",
    forced: [] as number[],
    onSignal: (_sig: Sig) => {},
  };
  const base = {
    rawStdout: () => {},
    rawStderr: (t: string) => {
      state.stderr += t;
    },
    subscribeSignals: (handler: (sig: Sig) => void) => {
      state.onSignal = handler;
      return () => {};
    },
    onForceExit: (c: 130 | 143) => {
      state.forced.push(c);
    },
    flush: async () => {},
  };
  return { state, base };
}

const SIGNALS = [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const;

describe("rule 1: after the first signal the command has a bounded grace period", () => {
  test("a command that never settles: the signal's code after the grace period, the line once, no forced exit", async () => {
    for (const [sig, code] of SIGNALS) {
      const { state, base } = seam();
      let aborted = false;
      const start = performance.now();
      const run = runHeadlessWithSignals({
        ...base,
        graceMs: 50,
        runCommand: (signal) => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
          setTimeout(() => state.onSignal(sig), 5);
          // Work that does not watch the abort signal (a read of standard input, a connect).
          return new Promise<number>(() => {});
        },
      });
      const exitCode = await Promise.race([run, Bun.sleep(1000).then(() => "hung" as const)]);
      const elapsed = performance.now() - start;
      expect(exitCode).toBe(code);
      expect(elapsed).toBeGreaterThanOrEqual(50);
      expect(aborted).toBe(true);
      expect(state.stderr).toBe("losql: interrupted\n");
      expect(state.forced).toEqual([]);
    }
  });

  test("the grace period is one second by default", async () => {
    const { state, base } = seam();
    const start = performance.now();
    const run = runHeadlessWithSignals({
      ...base,
      runCommand: () => {
        state.onSignal("SIGTERM");
        return new Promise<number>(() => {});
      },
    });
    const exitCode = await Promise.race([run, Bun.sleep(3000).then(() => "hung" as const)]);
    const elapsed = performance.now() - start;
    expect(exitCode).toBe(143);
    expect(elapsed).toBeGreaterThanOrEqual(950);
    expect(elapsed).toBeLessThan(2000);
    expect(state.stderr).toBe("losql: interrupted\n");
  });

  test("a command that settles within the period: as before, its cleanup ran and the signal's code is returned at once", async () => {
    for (const [sig, code] of SIGNALS) {
      for (const outcome of ["resolve", "reject"] as const) {
        const { state, base } = seam();
        let cleanedUp = false;
        let flushed = false;
        const start = performance.now();
        const exitCode = await runHeadlessWithSignals({
          ...base,
          graceMs: 5000,
          flush: async () => {
            flushed = true;
          },
          runCommand: async (signal) => {
            setTimeout(() => state.onSignal(sig), 5);
            try {
              await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
              await Bun.sleep(20);
              if (outcome === "reject") throw new Error("canceling statement due to user request");
              return 0;
            } finally {
              cleanedUp = true;
            }
          },
        });
        expect(exitCode).toBe(code);
        expect(performance.now() - start).toBeLessThan(1000);
        expect(cleanedUp).toBe(true);
        expect(flushed).toBe(false);
        expect(state.stderr).toBe("losql: interrupted\n");
        expect(state.forced).toEqual([]);
      }
    }
  });

  test("a second signal during the period forces the exit at once", async () => {
    for (const [sig, code] of SIGNALS) {
      const { state, base } = seam();
      let forcedBeforeGraceOver: number[] | null = null;
      const run = runHeadlessWithSignals({
        ...base,
        graceMs: 200,
        runCommand: () => {
          setTimeout(() => {
            state.onSignal(sig);
            state.onSignal(sig);
            forcedBeforeGraceOver = [...state.forced];
          }, 5);
          return new Promise<number>(() => {});
        },
      });
      const exitCode = await Promise.race([run, Bun.sleep(1000).then(() => "hung" as const)]);
      expect(forcedBeforeGraceOver as number[] | null).toEqual([code]);
      expect(exitCode).toBe(code);
      expect(state.stderr).toBe("losql: interrupted\n");
    }
  });

  test("without a signal a slow command is waited for as long as it takes", async () => {
    const { state, base } = seam();
    const exitCode = await runHeadlessWithSignals({
      ...base,
      graceMs: 10,
      runCommand: async () => {
        await Bun.sleep(80);
        return 4;
      },
    });
    expect(exitCode).toBe(4);
    expect(state.stderr).toBe("");
  });
});

/** A SQLite Statement of roughly 100 ms. */
const SLOW_COUNT =
  "with recursive c(x) as (select 1 union all select x+1 from c where x < 1000000) select count(*) as n from c";

describe("rule 2: a signal that arrives while a SQLite Statement runs stops the Statements after it", () => {
  let dir: string;
  let dbFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "losql-signals-"));
    dbFile = join(dir, "work.db");
    new Database(dbFile, { create: true }).close();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const tableExists = (name: string) => {
    const db = new Database(dbFile, { readonly: true });
    try {
      return db.query("select 1 from sqlite_master where type = 'table' and name = ?").get(name) !== null;
    } finally {
      db.close();
    }
  };

  /**
   * Deps whose abort is scheduled for the next turn of the event loop the first time the command looks at
   * the signal (before its first Statement). The SQLite Driver runs a Statement synchronously, so the abort
   * becomes visible only when the command gives the event loop a turn: as a signal that arrives during the
   * first Statement.
   */
  function depsAbortingDuringFirstStatement(out: { stdout: string; stderr: string }): CliDeps {
    const controller = new AbortController();
    let armed = false;
    return {
      stdout: (t) => {
        out.stdout += t;
      },
      stderr: (t) => {
        out.stderr += t;
      },
      stdin: async () => "",
      env: { LOSQL_CONFIG_DIR: join(dir, "config"), LOSQL_STATE_DIR: join(dir, "state") },
      home: dir,
      cwd: dir,
      exec: (() => {
        throw new Error("no process may be started");
      }) as unknown as CliDeps["exec"],
      which: () => null,
      get signal() {
        if (!armed) {
          armed = true;
          setImmediate(() => controller.abort());
        }
        return controller.signal;
      },
    };
  }

  test("exec: the Statement after the one that was running does not run, and nothing is printed", async () => {
    const out = { stdout: "", stderr: "" };
    const code = await runExec(
      {
        kind: "exec",
        connection: dbFile,
        format: "table",
        readOnly: false,
        // The first Statement takes well over the 20 ms after which a turn of the event loop is taken.
        sql: `create table first as ${SLOW_COUNT}; create table marker(x); select 1 as n`,
      },
      depsAbortingDuringFirstStatement(out),
    );
    expect(code).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toBe("");
    // What already ran stays changed; what came after it did not run.
    expect(tableExists("first")).toBe(true);
    expect(tableExists("marker")).toBe(false);
  });

  test("exec: a signal during the last Statement: nothing is printed", async () => {
    const out = { stdout: "", stderr: "" };
    const code = await runExec(
      // The last Statement is short: after the last one a turn is always taken.
      { kind: "exec", connection: dbFile, format: "table", readOnly: false, sql: "create table only(x)" },
      depsAbortingDuringFirstStatement(out),
    );
    expect(code).toBe(1);
    expect(out.stdout).toBe("");
    expect(tableExists("only")).toBe(true);
  });

  test("ask --run: the Statement after the one that was running does not run, and no Result is printed", async () => {
    const sql = `${SLOW_COUNT}; select 2 as b`;
    const fake = fakeClaude([JSON.stringify({ action: "answer", message: "Two.", sql })]);
    const controller = new AbortController();
    let stdout = "";
    const deps: CliDeps = {
      stdout: (t) => {
        stdout += t;
        // The SQL line is written just before the Statements run: the abort lands during the first one.
        if (t === `${sql}\n`) setImmediate(() => controller.abort());
      },
      stderr: () => {},
      stdin: async () => "",
      env: { LOSQL_CONFIG_DIR: join(dir, "config"), LOSQL_STATE_DIR: join(dir, "state") },
      home: dir,
      cwd: dir,
      exec: fake.exec,
      which: fake.which,
      signal: controller.signal,
    };
    const code = await runAsk({ kind: "ask", connection: dbFile, provider: "claude", run: true, question: "q" }, deps);
    expect(code).toBe(1);
    expect(stdout).toBe(`${sql}\n`);
  });
});
