import { mkdir, rm } from "node:fs/promises";
import { afterEach, describe, expect, test } from "bun:test";
import { QueryError, type Connection, type Driver, type Result } from "../../core/db/types";
import { readHistory } from "../../core/state";
import { mount, type TestApp } from "../testing";

let app: TestApp;
afterEach(async () => {
  await app?.dispose();
});

const connected = () =>
  app.waitFor(
    () =>
      app.api.session.status() === "connected" &&
      app.api.session.schema() !== null,
  );

const emptyResult: Result = {
  columns: [{ name: "x", type: "integer" }],
  rows: [[1]],
  truncated: false,
  affected: null,
  command: "SELECT",
  durationMs: 1,
};

describe("fix 1: a failing history write never fails a Run", () => {
  test("when historyFile is a directory, run resolves with its outcome, shown is set, and the failure is reported once", async () => {
    app = await mount({
      seed: async (deps) => {
        await rm(deps.paths.historyFile, { recursive: true, force: true });
        await mkdir(deps.paths.historyFile, { recursive: true });
      },
    });
    await connected();

    const outcomes = await app.api.session.run({ statements: ["select 1 as x"] });
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]!.ok && outcomes[0]!.result.rows).toEqual([[1]]);
    expect(app.api.session.shown()).toBe(outcomes[0]!);

    const historyToastsAfterFirst = app.api.toast
      .items()
      .filter((t) => t.message.startsWith("History could not be saved: "));
    const statusMsgAfterFirst = app.api.status.message();
    const reportedFirst =
      historyToastsAfterFirst.length === 1 ||
      (statusMsgAfterFirst?.text.startsWith("History could not be saved: ") ?? false);
    expect(reportedFirst).toBe(true);

    // Second run: reported at most once per application
    app.api.status.clear();
    const outcomes2 = await app.api.session.run({ statements: ["select 2 as y"] });
    expect(outcomes2.length).toBe(1);
    expect(outcomes2[0]!.ok && outcomes2[0]!.result.rows).toEqual([[2]]);
    expect(app.api.session.shown()).toBe(outcomes2[0]!);

    const historyToastsAfterSecond = app.api.toast
      .items()
      .filter((t) => t.message.startsWith("History could not be saved: "));
    expect(historyToastsAfterSecond.length).toBeLessThanOrEqual(1);
    expect(
      app.api.status.message()?.text.startsWith("History could not be saved: ") ?? false,
    ).toBe(false);
  });
});

describe("fix 2: a Run never replaces a Session it does not belong to", () => {
  test("a Run on Connection A interrupted by connecting to B leaves connection() as B, closes A once, never closes B, opens no Driver after switch, and writes no shown/lastError/history", async () => {
    const openedLog: string[] = [];
    const closedLog: string[] = [];
    let rejectRunA!: (err: unknown) => void;

    app = await mount({
      connection: "postgres://localhost/dba",
      deps: {
        openSession: async (connection: Connection): Promise<Driver> => {
          openedLog.push(connection.id);
          return {
            connection,
            run: async () => {
              if (connection.id.includes("dba")) {
                return new Promise<Result>((_resolve, reject) => {
                  rejectRunA = reject;
                });
              }
              return emptyResult;
            },
            schema: async () => ({ dialect: "postgres", namespaces: [] }),
            close: async () => {
              closedLog.push(connection.id);
              if (connection.id.includes("dba") && rejectRunA) {
                rejectRunA(
                  new QueryError("write CONNECTION_CLOSED", {
                    code: "CONNECTION_CLOSED",
                  }),
                );
              }
            },
          };
        },
      },
    });
    await connected();
    const idA = app.api.session.connection()!.id;

    const runPromise = app.api.session.run({ statements: ["select pg_sleep(10)"] });
    await app.settle();

    const connRes = await app.api.session.connect("postgres://localhost/dbb");
    expect(connRes.ok).toBe(true);
    const idB = app.api.session.connection()!.id;
    const openedCountAtSwitch = openedLog.length;

    const outcomes = await runPromise;
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]!.ok).toBe(false);

    expect(app.api.session.connection()?.id).toBe(idB);
    expect(closedLog).toEqual([idA]);
    expect(openedLog.length).toBe(openedCountAtSwitch);
    expect(app.api.session.shown()).toBeNull();
    expect(app.api.session.lastError()).toBeNull();
    expect(await readHistory(app.deps.paths)).toEqual([]);
  });

  test("a Run interrupted by quit() opens no Driver and records no history", async () => {
    const openedLog: string[] = [];
    const closedLog: string[] = [];
    let rejectRun!: (err: unknown) => void;

    app = await mount({
      connection: "postgres://localhost/dba",
      deps: {
        openSession: async (connection: Connection): Promise<Driver> => {
          openedLog.push(connection.id);
          return {
            connection,
            run: async () =>
              new Promise<Result>((_resolve, reject) => {
                rejectRun = reject;
              }),
            schema: async () => ({ dialect: "postgres", namespaces: [] }),
            close: async () => {
              closedLog.push(connection.id);
              rejectRun?.(
                new QueryError("write CONNECTION_CLOSED", {
                  code: "CONNECTION_CLOSED",
                }),
              );
            },
          };
        },
      },
    });
    await connected();
    expect(openedLog.length).toBe(1);

    const runPromise = app.api.session.run({ statements: ["select pg_sleep(10)"] });
    await app.settle();

    await app.api.quit();
    const outcomes = await runPromise;
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]!.ok).toBe(false);
    expect(openedLog.length).toBe(1);
    expect(closedLog.length).toBe(1);
    expect(await readHistory(app.deps.paths)).toEqual([]);
  });
});

describe("fix 3: the latest connect wins and every Driver is closed exactly once", () => {
  test("slow close of the first Driver with two connects in sequence: second wins, each Driver closed at most once, first resolves ok: false", async () => {
    const closeCounts = new Map<string, number>();
    let releaseCloseA!: () => void;
    const gateCloseA = new Promise<void>((resolve) => {
      releaseCloseA = resolve;
    });
    let releaseOpenB!: () => void;
    const gateOpenB = new Promise<void>((resolve) => {
      releaseOpenB = resolve;
    });

    app = await mount({
      connection: "postgres://localhost/dba",
      deps: {
        openSession: async (connection: Connection): Promise<Driver> => {
          if (connection.id.includes("dbb")) {
            await gateOpenB;
          }
          return {
            connection,
            run: async () => emptyResult,
            schema: async () => ({ dialect: "postgres", namespaces: [] }),
            close: async () => {
              closeCounts.set(connection.id, (closeCounts.get(connection.id) ?? 0) + 1);
              if (connection.id.includes("dba")) {
                await gateCloseA;
              }
            },
          };
        },
      },
    });
    await connected();
    const idA = app.api.session.connection()!.id;

    // Start first connect (B) and let it reach openSession
    const p1 = app.api.session.connect("postgres://localhost/dbb");
    await Promise.resolve();
    releaseOpenB();
    // Wait a microtask so p1 finishes openSession(B)
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Start second connect (C) which finishes first
    const p2 = app.api.session.connect("postgres://localhost/dbc");
    const res2 = await p2;
    expect(res2).toEqual({ ok: true });
    const idC = app.api.session.connection()!.id;
    expect(idC).toContain("dbc");

    // Release slow close of A
    releaseCloseA();
    const res1 = await p1;
    expect(res1).toEqual({ ok: false, message: "superseded by a newer connect" });
    expect(app.api.session.connection()?.id).toBe(idC);
    expect(app.api.session.status()).toBe("connected");

    // A and B closed once each, C not closed yet
    expect(closeCounts.get(idA)).toBe(1);
    for (const [id, count] of closeCounts.entries()) {
      expect(count).toBe(1);
      expect(id).not.toBe(idC);
    }
  });

  test("a failing later connect while an earlier one is still opening supersedes the earlier one and leaves status as failed connect", async () => {
    let releaseFirst!: () => void;
    const gateFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const closedIds: string[] = [];

    app = await mount({
      connection: null,
      deps: {
        openSession: async (connection: Connection): Promise<Driver> => {
          if (connection.id.includes("dbslow")) {
            await gateFirst;
            return {
              connection,
              run: async () => emptyResult,
              schema: async () => ({ dialect: "postgres", namespaces: [] }),
              close: async () => {
                closedIds.push(connection.id);
              },
            };
          }
          throw new QueryError("connect ECONNREFUSED");
        },
      },
    });
    expect(app.api.session.status()).toBe("none");

    const pSlow = app.api.session.connect("postgres://localhost/dbslow");
    expect(app.api.session.status()).toBe("connecting");

    const pFail = app.api.session.connect("postgres://localhost/dbfail");
    const resFail = await pFail;
    expect(resFail.ok).toBe(false);
    expect(app.api.session.status()).toBe("none");

    releaseFirst();
    const resSlow = await pSlow;
    expect(resSlow).toEqual({ ok: false, message: "superseded by a newer connect" });
    expect(app.api.session.status()).toBe("none");
    expect(app.api.session.connection()).toBeNull();
    expect(closedIds.length).toBe(1);
  });

  test("an older failing connect does not clear connecting status of a newer connect that is still opening", async () => {
    let rejectFirst!: (err: unknown) => void;
    let releaseSecond!: () => void;

    app = await mount({
      connection: null,
      deps: {
        openSession: async (connection: Connection): Promise<Driver> => {
          if (connection.id.includes("dbfirst")) {
            return new Promise<Driver>((_resolve, reject) => {
              rejectFirst = reject;
            });
          }
          return new Promise<Driver>((resolve) => {
            releaseSecond = () =>
              resolve({
                connection,
                run: async () => emptyResult,
                schema: async () => ({ dialect: "postgres", namespaces: [] }),
                close: async () => {},
              });
          });
        },
      },
    });

    const p1 = app.api.session.connect("postgres://localhost/dbfirst");
    const p2 = app.api.session.connect("postgres://localhost/dbsecond");
    expect(app.api.session.status()).toBe("connecting");

    rejectFirst(new QueryError("first boom"));
    const res1 = await p1;
    expect(res1.ok).toBe(false);
    // Newer connect is still in flight -> status remains connecting!
    expect(app.api.session.status()).toBe("connecting");

    releaseSecond();
    const res2 = await p2;
    expect(res2).toEqual({ ok: true });
    expect(app.api.session.status()).toBe("connected");
  });
});

describe("fix 4: durations and row counts in statusline and history", () => {
  test("statusline formats 1 row · 0.4 ms and history stores Math.round(ms)", async () => {
    app = await mount({
      connection: "postgres://localhost/dba",
      deps: {
        openSession: async (connection: Connection): Promise<Driver> => ({
          connection,
          run: async (): Promise<Result> => ({
            columns: [{ name: "x", type: "integer" }],
            rows: [[1]],
            truncated: false,
            affected: null,
            command: "SELECT",
            durationMs: 0.3593740000000025,
          }),
          schema: async () => ({ dialect: "postgres", namespaces: [] }),
          close: async () => {},
        }),
      },
    });
    await connected();

    await app.api.session.run({ statements: ["select 1"] });
    await app.settle();
    expect(app.frame()).toContain("1 row · 0.4 ms");

    const history = await readHistory(app.deps.paths);
    expect(history[0]?.ms).toBe(0);
  });

  test("statusline formats N rows · integer ms and history stores Math.round(ms)", async () => {
    app = await mount({
      connection: "postgres://localhost/dba",
      deps: {
        openSession: async (connection: Connection): Promise<Driver> => ({
          connection,
          run: async (): Promise<Result> => ({
            columns: [{ name: "x", type: "integer" }],
            rows: [[1], [2]],
            truncated: false,
            affected: null,
            command: "SELECT",
            durationMs: 12.6,
          }),
          schema: async () => ({ dialect: "postgres", namespaces: [] }),
          close: async () => {},
        }),
      },
    });
    await connected();

    await app.api.session.run({ statements: ["select 1, 2"] });
    await app.settle();
    expect(app.frame()).toContain("2 rows · 13 ms");

    const history = await readHistory(app.deps.paths);
    expect(history[0]?.ms).toBe(13);
  });
});

describe("fix 5: saving state cannot turn a successful connect into a failure", () => {
  test("when stateFile is a directory and cannot be saved, connect resolves ok: true, reports a warning, and loads the schema", async () => {
    app = await mount({ connection: null });
    expect(app.api.session.status()).toBe("none");

    // Turn stateFile into a directory so config.setState rejects
    await rm(app.deps.paths.stateFile, { recursive: true, force: true });
    await mkdir(app.deps.paths.stateFile, { recursive: true });

    const res = await app.api.session.connect("demo");
    expect(res).toEqual({ ok: true });
    expect(app.api.session.status()).toBe("connected");
    expect(app.api.session.connection()?.name).toBe("demo");

    await app.waitFor(() => app.api.session.schema() !== null);
    expect(
      app.api.session.schema()!.namespaces[0]!.relations.map((r) => r.name),
    ).toContain("orders");

    const warnings = app.api.toast.items().filter((t) => t.kind === "warning");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });
});

describe("fix 6: cancel() stops the whole Run", () => {
  test("cancelling right after Statement 1 resolves prevents Statement 2 from being sent to the Driver and ends with a cancelled outcome", async () => {
    const seen: string[] = [];
    let resolveStmt1!: (res: Result) => void;

    app = await mount({
      connection: "postgres://localhost/dba",
      deps: {
        openSession: async (connection: Connection): Promise<Driver> => ({
          connection,
          run: async (statement: string) => {
            seen.push(statement);
            if (seen.length === 1) {
              return new Promise<Result>((resolve) => {
                resolveStmt1 = resolve;
              });
            }
            return emptyResult;
          },
          schema: async () => ({ dialect: "postgres", namespaces: [] }),
          close: async () => {},
        }),
      },
    });
    await connected();

    // When no Run is in progress, cancel() returns false
    expect(app.api.session.cancel()).toBe(false);

    const runPromise = app.api.session.run({
      statements: ["select 1", "select 2", "select 3"],
    });
    await app.settle();
    expect(seen).toEqual(["select 1"]);

    // Resolve Statement 1 and immediately cancel in the same microtask turn before Statement 2 starts
    const afterStmt1 = Promise.resolve().then(() => {
      const wasRunning = app.api.session.cancel();
      expect(wasRunning).toBe(true);
    });
    resolveStmt1(emptyResult);
    await afterStmt1;

    const outcomes = await runPromise;
    expect(seen).toEqual(["select 1"]);
    expect(outcomes.length).toBe(2);
    expect(outcomes[0]!.ok).toBe(true);
    expect(outcomes[1]!.ok).toBe(false);
    expect(outcomes[1]!.statement).toBe("select 2");
    expect(outcomes[1]!.ok === false && outcomes[1]!.error).toBeInstanceOf(QueryError);
    expect(outcomes[1]!.ok === false && outcomes[1]!.error.message.toLowerCase()).toContain("cancel");
    expect(app.api.session.cancel()).toBe(false);
  });
});

describe("fix 7: the status follows the Session", () => {
  test("(a) after a failed reopen sets disconnected, status returns to connected as soon as a Statement succeeds on the held Driver", async () => {
    let opened = 0;
    let runCall = 0;

    app = await mount({
      connection: "postgres://localhost/dba",
      deps: {
        openSession: async (connection: Connection): Promise<Driver> => {
          opened++;
          if (opened > 1) {
            throw new QueryError("connect ECONNREFUSED");
          }
          return {
            connection,
            run: async () => {
              runCall++;
              if (runCall === 1) {
                throw new QueryError("read ECONNRESET", { code: "ECONNRESET" });
              }
              return emptyResult;
            },
            schema: async () => ({ dialect: "postgres", namespaces: [] }),
            close: async () => {},
          };
        },
      },
    });
    await connected();

    const [first] = await app.api.session.run({ statements: ["select 1"] });
    expect(first!.ok).toBe(false);
    expect(app.api.session.status()).toBe("disconnected");

    const [second] = await app.api.session.run({ statements: ["select 1"] });
    expect(second!.ok).toBe(true);
    expect(app.api.session.status()).toBe("connected");
  });

  test("(b) when reopen works and the retried Statement fails, status stays connected and the retried Statement's own error is the outcome", async () => {
    let opened = 0;

    app = await mount({
      connection: "postgres://localhost/dba",
      deps: {
        openSession: async (connection: Connection): Promise<Driver> => {
          opened++;
          const driverNo = opened;
          return {
            connection,
            run: async () => {
              if (driverNo === 1) {
                throw new QueryError("write CONNECTION_CLOSED", {
                  code: "CONNECTION_CLOSED",
                });
              }
              throw new QueryError("relation \"missing_table\" does not exist");
            },
            schema: async () => ({ dialect: "postgres", namespaces: [] }),
            close: async () => {},
          };
        },
      },
    });
    await connected();

    const [outcome] = await app.api.session.run({
      statements: ["select * from missing_table"],
    });
    expect(outcome!.ok).toBe(false);
    expect(outcome!.ok === false && outcome!.error.message).toBe(
      "relation \"missing_table\" does not exist",
    );
    expect(app.api.session.status()).toBe("connected");
  });
});

describe("fix 8: the Driver is closed when the provider goes away", () => {
  test("after dispose() the scripted Driver was closed once, and quit followed by dispose closes it once", async () => {
    const closed: string[] = [];
    app = await mount({
      connection: "postgres://localhost/dba",
      deps: {
        openSession: async (connection: Connection): Promise<Driver> => ({
          connection,
          run: async () => emptyResult,
          schema: async () => ({ dialect: "postgres", namespaces: [] }),
          close: async () => {
            closed.push(connection.id);
          },
        }),
      },
    });
    await connected();

    await app.dispose();
    expect(closed.length).toBe(1);

    // Also test quit() followed by dispose() closes once
    const closed2: string[] = [];
    app = await mount({
      connection: "postgres://localhost/dbb",
      deps: {
        openSession: async (connection: Connection): Promise<Driver> => ({
          connection,
          run: async () => emptyResult,
          schema: async () => ({ dialect: "postgres", namespaces: [] }),
          close: async () => {
            closed2.push(connection.id);
          },
        }),
      },
    });
    await connected();
    await app.api.quit();
    await app.dispose();
    expect(closed2.length).toBe(1);
  });

  test("a connect resolved after dispose leaves its Driver closed and stores nothing", async () => {
    let releaseConnect!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    const closed: string[] = [];

    app = await mount({
      connection: null,
      deps: {
        openSession: async (connection: Connection): Promise<Driver> => {
          await gate;
          return {
            connection,
            run: async () => emptyResult,
            schema: async () => ({ dialect: "postgres", namespaces: [] }),
            close: async () => {
              closed.push(connection.id);
            },
          };
        },
      },
    });

    const pConnect = app.api.session.connect("postgres://localhost/dba");
    await app.dispose();

    releaseConnect();
    const res = await pConnect;
    expect(res.ok).toBe(false);
    expect(closed.length).toBe(1);
    expect(app.api.session.driver()).toBeNull();
  });
});

describe("fix 9: :refresh without a Session says so", () => {
  test(":refresh without a Session shows No connection on the status line", async () => {
    app = await mount({ connection: null });
    expect(app.api.session.status()).toBe("none");

    await app.press("<Esc>");
    expect(app.frame()).not.toContain("Connections");

    await app.press(":refresh<CR>");
    expect(app.api.status.message()?.text).toBe("No connection");
    expect(app.frame()).toContain("No connection");
  });
});

describe("fix 10: the Session context does not wait for the renderer", () => {
  test("run, connect and refreshSchema resolve even when renderer.idle() never resolves", async () => {
    app = await mount();
    await connected();

    const stalledIdle = () => new Promise<void>(() => {});
    app.setup.renderer.idle = stalledIdle;

    const outcomes = await app.api.session.run({ statements: ["select 1 as one"] });
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]!.ok).toBe(true);

    const connRes = await app.api.session.connect(":memory:");
    expect(connRes).toEqual({ ok: true });

    await app.api.session.refreshSchema();
    expect(app.api.session.schema()).not.toBeNull();
  });
});

describe("Follow-up Fix 5: the Session that is held is always finished", () => {
  test("when X.close() is slow, connect(B) swaps B in, connect(C) rejects in openSession, then X.close() finishes: connect(B) resolves ok: true, connection() is B, schema refresh for B was started, state saved with B, C's failure reported, and X closed once", async () => {
    let releaseCloseX!: () => void;
    const gateCloseX = new Promise<void>((resolve) => {
      releaseCloseX = resolve;
    });
    const closeCounts = new Map<string, number>();
    let schemaCallsB = 0;

    app = await mount({
      connection: "postgres://localhost/dbx",
      deps: {
        openSession: async (connection: Connection): Promise<Driver> => {
          if (connection.id.includes("dbc")) {
            throw new QueryError("connect C ECONNREFUSED");
          }
          return {
            connection,
            run: async () => emptyResult,
            schema: async () => {
              if (connection.id.includes("dbb")) {
                schemaCallsB++;
              }
              return { dialect: "postgres", namespaces: [{ name: "public", relations: [] }] };
            },
            close: async () => {
              closeCounts.set(connection.id, (closeCounts.get(connection.id) ?? 0) + 1);
              if (connection.id.includes("dbx")) {
                await gateCloseX;
              }
            },
          };
        },
      },
    });
    await connected();
    const idX = app.api.session.connection()!.id;

    // Start connect(B) -> opens B, swaps B in, awaits X.close()
    const pB = app.api.session.connect("postgres://localhost/dbb");
    await app.waitFor(() => app.api.session.connection()?.id.includes("dbb") ?? false);
    const idB = app.api.session.connection()!.id;

    // Start connect(C) -> openSession rejects
    const resC = await app.api.session.connect("postgres://localhost/dbc");
    expect(resC).toEqual({ ok: false, message: "connect C ECONNREFUSED" });

    // Release X.close()
    releaseCloseX();
    const resB = await pB;

    expect(resB).toEqual({ ok: true });
    expect(app.api.session.connection()?.id).toBe(idB);
    expect(schemaCallsB).toBeGreaterThanOrEqual(1);
    await app.waitFor(() => app.api.session.schema() !== null);
    expect(app.api.config.state().lastConnection).toBe("postgres://localhost/dbb");
    expect(closeCounts.get(idX)).toBe(1);
    expect(closeCounts.get(idB) ?? 0).toBe(0);
  });
});

describe("Follow-up Fix 6: connect after quitting opens nothing", () => {
  test("connect called after quit() or after dispose() resolves { ok: false, message: 'the application is closing' } without calling openSession or changing status", async () => {
    let opened = 0;
    app = await mount({
      connection: null,
      deps: {
        openSession: async (connection: Connection): Promise<Driver> => {
          opened++;
          return {
            connection,
            run: async () => emptyResult,
            schema: async () => ({ dialect: "postgres", namespaces: [] }),
            close: async () => {},
          };
        },
      },
    });
    expect(app.api.session.status()).toBe("none");

    await app.api.quit();
    const resAfterQuit = await app.api.session.connect("postgres://localhost/dba");
    expect(resAfterQuit).toEqual({ ok: false, message: "the application is closing" });
    expect(opened).toBe(0);
    expect(app.api.session.status()).toBe("none");

    await app.dispose();

    // Second test: after dispose() when previously connected
    let opened2 = 0;
    app = await mount({
      connection: "postgres://localhost/dba",
      deps: {
        openSession: async (connection: Connection): Promise<Driver> => {
          opened2++;
          return {
            connection,
            run: async () => emptyResult,
            schema: async () => ({ dialect: "postgres", namespaces: [] }),
            close: async () => {},
          };
        },
      },
    });
    await connected();
    expect(opened2).toBe(1);
    expect(app.api.session.status()).toBe("connected");

    await app.dispose();
    const statusAtDispose = app.api.session.status();
    const resAfterDispose = await app.api.session.connect("postgres://localhost/dbb");
    expect(resAfterDispose).toEqual({ ok: false, message: "the application is closing" });
    expect(opened2).toBe(1);
    expect(app.api.session.status()).toBe(statusAtDispose);
  });
});

describe("Follow-up Fix 7: the newest Schema refresh wins", () => {
  test("two overlapping refreshes resolved in reverse order leave schema() as the newer snapshot and ignore an older refresh failure", async () => {
    let schemaCall = 0;
    let resolveFirst!: (snap: { dialect: "postgres"; namespaces: { name: string; relations: [] }[] }) => void;
    let resolveSecond!: (snap: { dialect: "postgres"; namespaces: { name: string; relations: [] }[] }) => void;
    let rejectThird!: (err: unknown) => void;
    let resolveFourth!: (snap: { dialect: "postgres"; namespaces: { name: string; relations: [] }[] }) => void;

    app = await mount({
      connection: "postgres://localhost/dba",
      deps: {
        openSession: async (connection: Connection): Promise<Driver> => ({
          connection,
          run: async () => emptyResult,
          schema: async () => {
            schemaCall++;
            const callNo = schemaCall;
            if (callNo === 1) {
              // Initial connect refresh
              return { dialect: "postgres", namespaces: [{ name: "initial", relations: [] }] };
            }
            if (callNo === 2) {
              return new Promise((resolve) => {
                resolveFirst = resolve;
              });
            }
            if (callNo === 3) {
              return new Promise((resolve) => {
                resolveSecond = resolve;
              });
            }
            if (callNo === 4) {
              return new Promise((_resolve, reject) => {
                rejectThird = reject;
              });
            }
            return new Promise((resolve) => {
              resolveFourth = resolve;
            });
          },
          close: async () => {},
        }),
      },
    });
    await connected();
    expect(app.api.session.schema()?.namespaces[0]?.name).toBe("initial");

    // Start two refreshes in sequence
    const r1 = app.api.session.refreshSchema();
    const r2 = app.api.session.refreshSchema();

    // Resolve the second (newer) refresh first
    const snapNewer = { dialect: "postgres" as const, namespaces: [{ name: "newer", relations: [] as [] }] };
    resolveSecond(snapNewer);
    await r2;
    expect(app.api.session.schema()).toEqual(snapNewer);

    // Resolve the first (older) refresh last -> schema() stays the newer snapshot
    const snapOlder = { dialect: "postgres" as const, namespaces: [{ name: "older", relations: [] as [] }] };
    resolveFirst(snapOlder);
    await r1;
    expect(app.api.session.schema()).toEqual(snapNewer);

    // Also test older refresh rejecting after newer refresh started -> no warning toast reported
    const r3 = app.api.session.refreshSchema();
    const r4 = app.api.session.refreshSchema();
    const snapFourth = { dialect: "postgres" as const, namespaces: [{ name: "fourth", relations: [] as [] }] };
    resolveFourth(snapFourth);
    await r4;
    rejectThird(new Error("stale schema boom"));
    await r3;
    expect(app.api.session.schema()).toEqual(snapFourth);
    expect(app.api.toast.items().some((t) => t.message.includes("stale schema boom"))).toBe(false);
  });
});

describe("Follow-up Fix 8: tests for the guards that no test covers", () => {
  test("(a1) & (c): a Run loses its connection, reopen is held on a gate, quit() happens, then gate is released: reopened Driver is closed once, never stored, and status follows the Session", async () => {
    let openCountA = 0;
    let releaseReopen!: () => void;
    const gateReopen = new Promise<void>((resolve) => {
      releaseReopen = resolve;
    });
    const closedDrivers: number[] = [];
    let reopenedDriverRef: Driver | null = null;

    app = await mount({
      connection: "postgres://localhost/dba",
      deps: {
        openSession: async (connection: Connection): Promise<Driver> => {
          openCountA++;
          const driverNo = openCountA;
          if (driverNo === 2) {
            await gateReopen;
          }
          const drv: Driver = {
            connection,
            run: async () => {
              if (driverNo === 1) {
                throw new QueryError("read ECONNRESET", { code: "ECONNRESET" });
              }
              return emptyResult;
            },
            schema: async () => ({ dialect: "postgres", namespaces: [] }),
            close: async () => {
              closedDrivers.push(driverNo);
            },
          };
          if (driverNo === 2) {
            reopenedDriverRef = drv;
          }
          return drv;
        },
      },
    });
    await connected();
    expect(openCountA).toBe(1);

    const runPromise = app.api.session.run({ statements: ["select 1"] });
    await app.waitFor(() => openCountA === 2);

    await app.api.quit();
    const statusAfterQuit = app.api.session.status();

    releaseReopen();
    const outcomes = await runPromise;
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]!.ok).toBe(false);

    expect(reopenedDriverRef).not.toBeNull();
    expect(app.api.session.driver()).toBeNull();
    expect(closedDrivers.filter((n) => n === 2)).toEqual([2]);
    expect(app.api.session.status()).toBe(statusAfterQuit);
  });

  test("(a2) & (c): a Run loses its connection, reopen is held on a gate, connect() to another Connection happens, then gate is released: reopened Driver is closed once, never stored, and status is the one of the held Session", async () => {
    let openCountA = 0;
    let releaseReopenA!: () => void;
    const gateReopenA = new Promise<void>((resolve) => {
      releaseReopenA = resolve;
    });
    const closedA: number[] = [];
    let closedB = 0;
    let reopenedDriverA: Driver | null = null;
    let driverB: Driver | null = null;

    app = await mount({
      connection: "postgres://localhost/dba",
      deps: {
        openSession: async (connection: Connection): Promise<Driver> => {
          if (connection.id.includes("dba")) {
            openCountA++;
            const driverNo = openCountA;
            if (driverNo === 2) {
              await gateReopenA;
            }
            const drv: Driver = {
              connection,
              run: async () => {
                if (driverNo === 1) {
                  throw new QueryError("read ECONNRESET", { code: "ECONNRESET" });
                }
                return emptyResult;
              },
              schema: async () => ({ dialect: "postgres", namespaces: [] }),
              close: async () => {
                closedA.push(driverNo);
              },
            };
            if (driverNo === 2) {
              reopenedDriverA = drv;
            }
            return drv;
          }
          const drvB: Driver = {
            connection,
            run: async () => emptyResult,
            schema: async () => ({ dialect: "postgres", namespaces: [] }),
            close: async () => {
              closedB++;
            },
          };
          driverB = drvB;
          return drvB;
        },
      },
    });
    await connected();
    expect(openCountA).toBe(1);

    const runPromise = app.api.session.run({ statements: ["select 1"] });
    await app.waitFor(() => openCountA === 2);

    const connRes = await app.api.session.connect("postgres://localhost/dbb");
    expect(connRes).toEqual({ ok: true });
    expect(app.api.session.driver()).toBe(driverB);
    expect(app.api.session.status()).toBe("connected");

    releaseReopenA();
    const outcomes = await runPromise;
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]!.ok).toBe(false);

    expect(reopenedDriverA).not.toBeNull();
    expect(app.api.session.driver()).toBe(driverB);
    expect(app.api.session.connection()?.id).toContain("dbb");
    expect(closedA.filter((n) => n === 2)).toEqual([2]);
    expect(closedB).toBe(0);
    expect(app.api.session.status()).toBe("connected");
  });

  test("(b): a Schema refresh started on Connection A that resolves, and one that fails, after the switch to B: nothing of A is stored and no failure is reported", async () => {
    let schemaCallA = 0;
    let resolveSchemaA!: (snap: { dialect: "postgres"; namespaces: { name: string; relations: [] }[] }) => void;
    let rejectSchemaA!: (err: unknown) => void;
    let releaseSchemaB!: () => void;
    const gateSchemaB = new Promise<void>((resolve) => {
      releaseSchemaB = resolve;
    });

    app = await mount({
      connection: "postgres://localhost/dba",
      deps: {
        openSession: async (connection: Connection): Promise<Driver> => {
          if (connection.id.includes("dba")) {
            return {
              connection,
              run: async () => emptyResult,
              schema: async () => {
                schemaCallA++;
                const callNo = schemaCallA;
                if (callNo === 1) {
                  return { dialect: "postgres", namespaces: [{ name: "initial_a", relations: [] }] };
                }
                if (callNo === 2) {
                  return new Promise((resolve) => {
                    resolveSchemaA = resolve;
                  });
                }
                return new Promise((_resolve, reject) => {
                  rejectSchemaA = reject;
                });
              },
              close: async () => {},
            };
          }
          return {
            connection,
            run: async () => emptyResult,
            schema: async () => {
              await gateSchemaB;
              return { dialect: "postgres", namespaces: [{ name: "schema_b", relations: [] }] };
            },
            close: async () => {},
          };
        },
      },
    });
    await connected();
    expect(app.api.session.schema()?.namespaces[0]?.name).toBe("initial_a");

    // Start two refreshes on A (one that will resolve, one that will fail)
    const rResolveA = app.api.session.refreshSchema();
    const rFailA = app.api.session.refreshSchema();

    // Switch to B while B's own schema refresh is held on gateSchemaB (so schema() is currently null)
    const connB = await app.api.session.connect("postgres://localhost/dbb");
    expect(connB).toEqual({ ok: true });
    expect(app.api.session.schema()).toBeNull();

    // Resolve and reject A's pending refreshes after switching to B
    resolveSchemaA({ dialect: "postgres", namespaces: [{ name: "late_a", relations: [] }] });
    rejectSchemaA(new Error("a schema failed after switch"));
    await Promise.all([rResolveA, rFailA]);

    // Nothing of A was stored and no failure toast/status was reported
    expect(app.api.session.schema()).toBeNull();
    expect(app.api.toast.items().some((t) => t.message.includes("a schema failed after switch"))).toBe(false);

    // Release B's schema refresh and confirm B's schema loads
    releaseSchemaB();
    await app.waitFor(() => app.api.session.schema() !== null);
    expect(app.api.session.schema()?.namespaces[0]?.name).toBe("schema_b");
  });

  test("(c): a Run loses its connection, reopen is held on a gate and then rejects after connect() to B: status stays 'connected' for B and never becomes 'disconnected'", async () => {
    let openCountA = 0;
    let rejectReopenA!: (err: unknown) => void;
    const gateReopenA = new Promise<Driver>((_resolve, reject) => {
      rejectReopenA = reject;
    });

    app = await mount({
      connection: "postgres://localhost/dba",
      deps: {
        openSession: async (connection: Connection): Promise<Driver> => {
          if (connection.id.includes("dba")) {
            openCountA++;
            if (openCountA === 2) {
              return gateReopenA;
            }
            return {
              connection,
              run: async () => {
                throw new QueryError("read ECONNRESET", { code: "ECONNRESET" });
              },
              schema: async () => ({ dialect: "postgres", namespaces: [] }),
              close: async () => {},
            };
          }
          return {
            connection,
            run: async () => emptyResult,
            schema: async () => ({ dialect: "postgres", namespaces: [] }),
            close: async () => {},
          };
        },
      },
    });
    await connected();

    const runPromise = app.api.session.run({ statements: ["select 1"] });
    await app.waitFor(() => openCountA === 2);

    const connRes = await app.api.session.connect("postgres://localhost/dbb");
    expect(connRes).toEqual({ ok: true });
    expect(app.api.session.status()).toBe("connected");

    rejectReopenA(new QueryError("reopen ECONNREFUSED"));
    const outcomes = await runPromise;
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]!.ok).toBe(false);

    // Status remains "connected" for Session B
    expect(app.api.session.status()).toBe("connected");
    expect(app.api.session.connection()?.id).toContain("dbb");
  });
});

describe("Task 19 Fix 6: schemaError() tracks the failed refresh of the current Driver's Schema", () => {
  test("schemaError() is null without a Session, sets on failure, clears while a refresh runs and after one succeeds, and ignores a late failure after a Connection switch", async () => {
    let callCountA = 0;
    let releaseSecondRefreshA!: () => void;
    const gateSecondRefreshA = new Promise<void>((resolve) => {
      releaseSecondRefreshA = resolve;
    });
    let rejectThirdRefreshA!: (err: unknown) => void;
    let releaseFirstRefreshB!: () => void;
    const gateFirstRefreshB = new Promise<void>((resolve) => {
      releaseFirstRefreshB = resolve;
    });

    app = await mount({
      connection: null,
      deps: {
        openSession: async (connection: Connection): Promise<Driver> => {
          if (connection.id.includes("dba")) {
            return {
              connection,
              run: async () => emptyResult,
              schema: async () => {
                callCountA++;
                if (callCountA === 1) {
                  throw new QueryError("permission denied for schema pg_catalog");
                }
                if (callCountA === 2) {
                  await gateSecondRefreshA;
                  return { dialect: "postgres", namespaces: [{ name: "public", relations: [] }] };
                }
                return new Promise((_resolve, reject) => {
                  rejectThirdRefreshA = reject;
                });
              },
              close: async () => {},
            };
          }
          return {
            connection,
            run: async () => emptyResult,
            schema: async () => {
              await gateFirstRefreshB;
              return { dialect: "postgres", namespaces: [{ name: "public", relations: [] }] };
            },
            close: async () => {},
          };
        },
      },
    });

    // Without a Session: schemaError() is null
    expect(app.api.session.schemaError()).toBeNull();

    // Connect to A -> initial schema refresh fails
    const connA = await app.api.session.connect("postgres://localhost/dba");
    expect(connA).toEqual({ ok: true });
    await app.waitFor(() => app.api.session.schemaError() !== null);
    expect(app.api.session.schemaError()).toBe("permission denied for schema pg_catalog");
    expect(app.api.session.schema()).toBeNull();

    // Start second refresh on A -> schemaError() is null while refresh runs, and null after it succeeds
    const r2 = app.api.session.refreshSchema();
    expect(app.api.session.schemaError()).toBeNull();
    releaseSecondRefreshA();
    await r2;
    expect(app.api.session.schemaError()).toBeNull();
    expect(app.api.session.schema()).not.toBeNull();

    // Start third refresh on A (which will fail), then switch to B before it fails
    const r3 = app.api.session.refreshSchema();
    const connB = await app.api.session.connect("postgres://localhost/dbb");
    expect(connB).toEqual({ ok: true });
    expect(app.api.session.schemaError()).toBeNull();

    // Late failure of A's refresh after switch to B is ignored
    rejectThirdRefreshA(new QueryError("stale driver A schema failure"));
    await r3;
    expect(app.api.session.schemaError()).toBeNull();

    releaseFirstRefreshB();
    await app.waitFor(() => app.api.session.schema() !== null);
    expect(app.api.session.schemaError()).toBeNull();
  });
});















describe("Task 25 review fix 1: a Connection taken from DATABASE_URL is not written to disk", () => {
  const secretUrl = "postgres://app:s3cret-pw@db.example.test/prod";
  const scripted = {
    openSession: async (connection: Connection): Promise<Driver> => ({
      connection,
      run: async () => emptyResult,
      schema: async () => ({ dialect: "postgres", namespaces: [{ name: "public", relations: [] }] }),
      close: async () => {},
    }),
  };
  const stateText = () => Bun.file(app.deps.paths.stateFile).text();
  // Every write of the state file is done once a later write of another field has landed.
  const flushState = async () => {
    await app.api.config.setState({ providerTests: {} });
    await app.settle();
  };

  test("started with only DATABASE_URL: the state file does not contain it and keeps the remembered Connection", async () => {
    app = await mount({
      connection: null,
      state: { lastConnection: "shop" },
      config: { connections: [{ name: "shop", url: "demo" }] },
      deps: { ...scripted, env: { DATABASE_URL: secretUrl } },
    });
    // DATABASE_URL comes before the last Connection at start.
    await connected();
    expect(app.api.session.connection()?.url).toBe(secretUrl);
    await flushState();
    expect(app.api.config.state().lastConnection).toBe("shop");
    const text = await stateText();
    expect(text).not.toContain("s3cret-pw");
    expect(text).not.toContain("db.example.test");
    expect(JSON.parse(text).lastConnection).toBe("shop");
  });

  test("started with only DATABASE_URL and nothing remembered: nothing is remembered", async () => {
    app = await mount({ connection: null, deps: { ...scripted, env: { DATABASE_URL: `  ${secretUrl}\n` } } });
    await connected();
    await flushState();
    expect(app.api.config.state().lastConnection).toBeNull();
    expect(await stateText()).not.toContain("s3cret-pw");
  });

  test("the DATABASE_URL choice of the Connections dialog is not written either", async () => {
    app = await mount({
      connection: "demo",
      deps: { env: { DATABASE_URL: secretUrl }, openSession: async (connection) =>
        connection.id === "demo" ? (await import("../../core/db/connection")).openSession(connection, { env: {} }) : scripted.openSession(connection) },
    });
    await connected();
    await app.waitFor(() => app.api.config.state().lastConnection === "demo");
    await app.press("<Space>c");
    await app.waitFor(() => app.frame().includes("DATABASE_URL"));
    await app.press("DATABASE_URL");
    await app.press("<CR>");
    await app.waitFor(() => app.api.session.connection()?.url === secretUrl);
    await flushState();
    expect(app.api.config.state().lastConnection).toBe("demo");
    expect(await stateText()).not.toContain("s3cret-pw");
  });

  test("a URL given as the start argument is remembered as given", async () => {
    app = await mount({ connection: "postgres://localhost/arg", deps: scripted });
    await connected();
    await app.waitFor(() => app.api.config.state().lastConnection === "postgres://localhost/arg");
    await flushState();
    expect(JSON.parse(await stateText()).lastConnection).toBe("postgres://localhost/arg");
  });

  test("a URL typed with :connect is remembered as given", async () => {
    app = await mount({ connection: "demo", deps: { openSession: async (connection) =>
      connection.id === "demo" ? (await import("../../core/db/connection")).openSession(connection, { env: {} }) : scripted.openSession(connection) } });
    await connected();
    await app.press(":connect postgres://localhost/typed<CR>");
    await app.waitFor(() => app.api.session.connection()?.url === "postgres://localhost/typed");
    await connected();
    await app.waitFor(() => app.api.config.state().lastConnection === "postgres://localhost/typed");
    await flushState();
    expect(JSON.parse(await stateText()).lastConnection).toBe("postgres://localhost/typed");
  });

  test("a saved Connection is remembered by its name, also when DATABASE_URL is set", async () => {
    app = await mount({
      connection: "shop",
      config: { connections: [{ name: "shop", url: "postgres://localhost/shopdb" }] },
      deps: { ...scripted, env: { DATABASE_URL: secretUrl } },
    });
    await connected();
    expect(app.api.session.connection()?.name).toBe("shop");
    await app.waitFor(() => app.api.config.state().lastConnection === "shop");
    await flushState();
    expect(JSON.parse(await stateText()).lastConnection).toBe("shop");
  });

  test("with an argument and DATABASE_URL: the argument is used, and only the argument is remembered", async () => {
    app = await mount({
      connection: "postgres://localhost/arg",
      state: { lastConnection: "older" },
      deps: { ...scripted, env: { DATABASE_URL: secretUrl } },
    });
    await connected();
    expect(app.api.session.connection()?.url).toBe("postgres://localhost/arg");
    await app.waitFor(() => app.api.config.state().lastConnection === "postgres://localhost/arg");
    await flushState();
    const text = await stateText();
    expect(JSON.parse(text).lastConnection).toBe("postgres://localhost/arg");
    expect(text).not.toContain("s3cret-pw");
  });
});

describe("a failed connect never shows a password, whichever Driver failed", () => {
  /** A Session whose Driver fails at once with `message`: nothing is looked up or opened. */
  const failingWith = (message: string) => async (_connection: Connection): Promise<Driver> => {
    throw new Error(message);
  };

  const cases: [string, string, string][] = [
    ["a URL with user:password@", "could not connect to postgres://app:hunter2@db.internal/x: boom", "postgres://app:hunter2@db.internal/x"],
    ["a password= value", "connection string was host=x password=hunter2 user=app", "postgres://app@db.internal/x"],
  ];
  for (const [name, message, input] of cases) {
    test(`${name} in the error is hidden in the returned message and on screen`, async () => {
      app = await mount({ connection: null, deps: { openSession: failingWith(message) } });
      const res = await app.api.session.connect(input);
      expect(res.ok).toBe(false);
      expect(res.ok ? "" : res.message).not.toContain("hunter2");
      expect(res.ok ? "" : res.message).toContain(name === "a password= value" ? "password=" : "postgres://app");

      // Without a Connection the Connections dialog opens at start; close it to use the command line.
      await app.waitFor(() => app.api.dialog.depth() === 1);
      await app.press("<Esc>");
      await app.press(`:connect ${input}<CR>`);
      await app.waitFor(() => app.frame().includes("Could not connect") || app.frame().includes("could not connect"));
      expect(app.frame()).not.toContain("hunter2");
      expect(app.api.toast.items().some((t) => t.message.includes("hunter2"))).toBe(false);
      expect(app.api.status.message()?.text ?? "").not.toContain("hunter2");
    });
  }

  test("a message without a secret is returned unchanged, byte for byte", async () => {
    app = await mount({ connection: null, deps: { openSession: failingWith("unable to open database file") } });
    const res = await app.api.session.connect("missing/dir/app.db");
    expect(res).toEqual({ ok: false, message: "unable to open database file" });
  });
});

describe("final fix 2: a Statement that is not a read is never sent twice by one Run", () => {
  const sentence = "The connection was lost and opened again; the statement was not run again because it may already have been applied.";
  const lost = () => new QueryError("write CONNECTION_CLOSED localhost:5432", { code: "CONNECTION_CLOSED" });

  /** Every Driver opened gets a number; `calls` lists `<number>:<statement>` per call of `run`. */
  function counted(behave: (driverNo: number, statement: string, call: number) => Result | Error) {
    const calls: string[] = [];
    let opened = 0;
    let call = 0;
    return {
      calls,
      opened: () => opened,
      openSession: async (connection: Connection): Promise<Driver> => {
        const driverNo = ++opened;
        const outcome = behave(driverNo, "", 0);
        if (outcome instanceof Error && outcome.message.startsWith("connect ")) throw outcome;
        return {
          connection,
          run: async (statement: string) => {
            calls.push(`${driverNo}:${statement}`);
            const result = behave(driverNo, statement, ++call);
            if (result instanceof Error) throw result;
            return result;
          },
          schema: async () => ({ dialect: "postgres", namespaces: [] }),
          close: async () => {},
        };
      },
    };
  }

  test("a read that loses its connection is run again on the reopened Session and succeeds", async () => {
    const fake = counted((_no, statement, call) => (statement !== "" && call === 1 ? lost() : emptyResult));
    app = await mount({ connection: "postgres://localhost/dev", deps: { openSession: fake.openSession } });
    await connected();
    const [outcome] = await app.api.session.run({ statements: ["select 1"] });
    expect(outcome!.ok).toBe(true);
    expect(fake.calls).toEqual(["1:select 1", "2:select 1"]);
    expect(app.api.session.status()).toBe("connected");
  });

  test("an update that loses its connection is not run again: the Run ends with the original error and the sentence, and the Session is connected", async () => {
    const fake = counted((_no, statement, call) => (statement !== "" && call === 1 ? lost() : emptyResult));
    app = await mount({ connection: "postgres://localhost/dev", deps: { openSession: fake.openSession } });
    await connected();
    const [outcome] = await app.api.session.run({ statements: ["update t set x = 1"] });
    expect(outcome!.ok).toBe(false);
    const error = outcome!.ok === false ? outcome!.error : null;
    expect(error).toBeInstanceOf(QueryError);
    expect(error!.message).toContain("write CONNECTION_CLOSED localhost:5432");
    expect(error!.message).toContain(sentence);
    expect(error!.code).toBe("CONNECTION_CLOSED");
    expect(fake.calls).toEqual(["1:update t set x = 1"]);
    expect(fake.opened()).toBe(2);
    expect(app.api.session.status()).toBe("connected");
    expect(app.api.session.shown()).toBe(outcome!);

    const [next] = await app.api.session.run({ statements: ["select 2"] });
    expect(next!.ok).toBe(true);
    expect(fake.calls).toEqual(["1:update t set x = 1", "2:select 2"]);
  });

  test("a Run that starts while the Session is disconnected opens it first and runs the update exactly once", async () => {
    const fake = counted((no, statement) => {
      if (no === 2) return new QueryError("connect ECONNREFUSED");
      if (statement === "") return emptyResult;
      return no === 1 ? new QueryError("read ECONNRESET", { code: "ECONNRESET" }) : emptyResult;
    });
    app = await mount({ connection: "postgres://localhost/dev", deps: { openSession: fake.openSession } });
    await connected();
    const [first] = await app.api.session.run({ statements: ["select 1"] });
    expect(first!.ok).toBe(false);
    expect(app.api.session.status()).toBe("disconnected");
    expect(fake.opened()).toBe(2);

    const [outcome] = await app.api.session.run({ statements: ["update t set x = 1"] });
    expect(outcome!.ok).toBe(true);
    expect(fake.opened()).toBe(3);
    expect(fake.calls).toEqual(["1:select 1", "3:update t set x = 1"]);
    expect(app.api.session.status()).toBe("connected");
  });

  test("run all stops at a write that loses its connection", async () => {
    const fake = counted((_no, statement) => (statement === "update t set x = 1" ? lost() : emptyResult));
    app = await mount({ connection: "postgres://localhost/dev", deps: { openSession: fake.openSession } });
    await connected();
    const outcomes = await app.api.session.run({ statements: ["select 1", "update t set x = 1", "select 2"] });
    expect(outcomes.map((o) => o.ok)).toEqual([true, false]);
    expect(outcomes[1]!.ok === false && outcomes[1]!.error.message).toContain(sentence);
    expect(fake.calls).toEqual(["1:select 1", "1:update t set x = 1"]);
    expect(app.api.session.status()).toBe("connected");
  });

  const pgUrl = process.env.LOSQL_TEST_PG_URL;
  test.skipIf(!pgUrl)("on Postgres, a terminated backend: a read is run again and returns, an insert is not run again", async () => {
    const { openSession, parseConnection } = await import("../../core/db/connection");
    const schema = `losql_ff2_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`;
    const side = await openSession(parseConnection(pgUrl!), { env: {} });
    // Ends the backend that runs a Statement holding `marker`, from the second connection.
    const terminate = async (marker: string) => {
      for (let i = 0; i < 200; i++) {
        const found = await side.run(
          `select pid from pg_stat_activity where state = 'active' and pid <> pg_backend_pid() and query like '%${marker}%' and query not like '%pg_stat_activity%'`,
        );
        if (found.rows.length === 1) {
          await side.run(`select pg_terminate_backend(${Number(found.rows[0]![0])})`);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`no backend runs ${marker}`);
    };
    try {
      await side.run(`create schema ${schema}`);
      await side.run(`create table ${schema}.w (x int)`);
      app = await mount({ connection: pgUrl! });
      await app.waitFor(() => app.api.session.status() === "connected");

      const read = `select pg_sleep(5), '${schema}_read' as tag`;
      const reading = app.api.session.run({ statements: [read] });
      await terminate(`${schema}_read`);
      const [readOutcome] = await reading;
      expect(readOutcome!.ok).toBe(true);
      expect(readOutcome!.ok && readOutcome!.result.rows[0]![1]).toBe(`${schema}_read`);
      expect(app.api.session.status()).toBe("connected");

      const insert = `insert into ${schema}.w (x) select 1 from pg_sleep(5)`;
      const inserting = app.api.session.run({ statements: [insert] });
      await terminate(`${schema}.w`);
      const [insertOutcome] = await inserting;
      expect(insertOutcome!.ok).toBe(false);
      expect(insertOutcome!.ok === false && insertOutcome!.error.message).toContain(sentence);
      expect(app.api.session.status()).toBe("connected");

      const count = await side.run(`select count(*)::int from ${schema}.w`);
      expect(Number(count.rows[0]![0])).toBeLessThanOrEqual(1);
      const [after] = await app.api.session.run({ statements: ["select 1"] });
      expect(after!.ok).toBe(true);
    } finally {
      await side.run(`drop schema if exists ${schema} cascade`).catch(() => {});
      await side.close();
    }
  }, 30_000);
});

describe("final-c2 fix 2: a Session that was opened again says so", () => {
  const reopened = "The connection was lost and opened again. An open transaction, session settings and temporary tables are gone.";
  const sentence = "The connection was lost and opened again; the statement was not run again because it may already have been applied.";
  const lost = () => new QueryError("write CONNECTION_CLOSED localhost:5432", { code: "CONNECTION_CLOSED" });
  const toasts = () => app.api.toast.items().filter((t) => t.message === reopened);

  /**
   * Every Driver opened gets a number. `lose(statement)` decides whether that call loses its
   * connection; `silent` makes the Driver report a loss the client library repaired by itself.
   */
  function scripted(options: { lose?: (statement: string, call: number) => boolean; silentAfter?: Set<number> }) {
    const calls: string[] = [];
    let opened = 0;
    let call = 0;
    return {
      calls,
      opened: () => opened,
      openSession: async (connection: Connection): Promise<Driver> => {
        const driverNo = ++opened;
        let lostFlag = false;
        return {
          connection,
          run: async (statement: string) => {
            const n = ++call;
            calls.push(`${driverNo}:${statement}`);
            if (options.lose?.(statement, n)) {
              lostFlag = true;
              throw lost();
            }
            if (options.silentAfter?.has(n)) lostFlag = true;
            return emptyResult;
          },
          schema: async () => ({ dialect: "postgres", namespaces: [] }),
          close: async () => {},
          takeLostConnection: () => {
            const was = lostFlag;
            lostFlag = false;
            return was;
          },
        };
      },
    };
  }

  test("a read after a loss: the result is shown and the toast appears once", async () => {
    const fake = scripted({ lose: (_s, call) => call === 1 });
    app = await mount({ connection: "postgres://127.0.0.1:1/dev", deps: { openSession: fake.openSession } });
    await connected();
    const [outcome] = await app.api.session.run({ statements: ["select 1"] });
    expect(outcome!.ok).toBe(true);
    expect(app.api.session.shown()).toBe(outcome!);
    expect(fake.calls).toEqual(["1:select 1", "2:select 1"]);
    await app.settle();
    expect(toasts().length).toBe(1);
    expect(toasts()[0]!.kind).toBe("warning");
    expect(app.frame()).toContain("The connection was lost and opened again.");
  });

  test("a write after a loss: the error with its sentence and the toast once", async () => {
    const fake = scripted({ lose: (_s, call) => call === 1 });
    app = await mount({ connection: "postgres://127.0.0.1:1/dev", deps: { openSession: fake.openSession } });
    await connected();
    const [outcome] = await app.api.session.run({ statements: ["insert into t values (2)"] });
    expect(outcome!.ok).toBe(false);
    expect(outcome!.ok === false && outcome!.error.message).toContain(sentence);
    expect(toasts().length).toBe(1);
  });

  test("two losses: two toasts", async () => {
    const fake = scripted({ lose: (_s, call) => call === 1 || call === 3 });
    app = await mount({ connection: "postgres://127.0.0.1:1/dev", deps: { openSession: fake.openSession } });
    await connected();
    await app.api.session.run({ statements: ["select 1"] });
    await app.api.session.run({ statements: ["select 2"] });
    expect(fake.opened()).toBe(3);
    expect(toasts().length).toBe(2);
  });

  test("no loss: no toast", async () => {
    const fake = scripted({});
    app = await mount({ connection: "postgres://127.0.0.1:1/dev", deps: { openSession: fake.openSession } });
    await connected();
    await app.api.session.run({ statements: ["begin", "insert into t values (1)", "select 1"] });
    await app.api.session.run({ statements: ["commit"] });
    expect(toasts().length).toBe(0);
  });

  test("a loss the client library repaired by itself: the Statement is run as usual and the toast appears with its outcome", async () => {
    // The second call (the insert) runs on a connection the library opened anew after the first was closed.
    const fake = scripted({ silentAfter: new Set([2]) });
    app = await mount({ connection: "postgres://127.0.0.1:1/dev", deps: { openSession: fake.openSession } });
    await connected();
    await app.api.session.run({ statements: ["begin", "insert into t values (2)"] });
    expect(fake.calls).toEqual(["1:begin", "1:insert into t values (2)"]);
    expect(fake.opened()).toBe(1);
    expect(toasts().length).toBe(1);
    await app.api.session.run({ statements: ["rollback"] });
    expect(toasts().length).toBe(1);
  });

  test("a loss noticed before the Run: the Statement is run as usual, whatever its class, and the toast appears once", async () => {
    let flagged = false;
    const calls: string[] = [];
    app = await mount({
      connection: "postgres://127.0.0.1:1/dev",
      deps: {
        openSession: async (connection: Connection): Promise<Driver> => ({
          connection,
          run: async (statement: string) => {
            calls.push(statement);
            return emptyResult;
          },
          schema: async () => ({ dialect: "postgres", namespaces: [] }),
          close: async () => {},
          takeLostConnection: () => {
            const was = flagged;
            flagged = false;
            return was;
          },
        }),
      },
    });
    await connected();
    flagged = true;
    const [outcome] = await app.api.session.run({ statements: ["update t set x = 1"] });
    expect(outcome!.ok).toBe(true);
    expect(calls).toEqual(["update t set x = 1"]);
    expect(toasts().length).toBe(1);
  });

  test("a Session that was disconnected and is opened by the next Run: the toast appears once", async () => {
    let opened = 0;
    let call = 0;
    app = await mount({
      connection: "postgres://127.0.0.1:1/dev",
      deps: {
        openSession: async (connection: Connection): Promise<Driver> => {
          const no = ++opened;
          if (no === 2) throw new QueryError("connect ECONNREFUSED");
          return {
            connection,
            run: async () => {
              if (++call === 1) throw new QueryError("read ECONNRESET", { code: "ECONNRESET" });
              return emptyResult;
            },
            schema: async () => ({ dialect: "postgres", namespaces: [] }),
            close: async () => {},
          };
        },
      },
    });
    await connected();
    await app.api.session.run({ statements: ["select 1"] });
    expect(app.api.session.status()).toBe("disconnected");
    expect(toasts().length).toBe(0);
    const [outcome] = await app.api.session.run({ statements: ["select 2"] });
    expect(outcome!.ok).toBe(true);
    expect(opened).toBe(3);
    expect(toasts().length).toBe(1);
  });

  const pgUrl = process.env.LOSQL_TEST_PG_URL;
  test.skipIf(!pgUrl)("on Postgres, the reviewer's sequence: begin, insert (1), the idle backend ended, insert (2): the toast appears with its outcome", async () => {
    const { openSession, parseConnection } = await import("../../core/db/connection");
    const schema = `losql_c2f2_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`;
    const side = await openSession(parseConnection(pgUrl!), { env: {} });
    try {
      await side.run(`create schema ${schema}`);
      await side.run(`create table ${schema}.w (x int)`);
      app = await mount({ connection: pgUrl! });
      await app.waitFor(() => app.api.session.status() === "connected");

      const [pidOutcome] = await app.api.session.run({ statements: ["select pg_backend_pid()"], record: false, show: false });
      const pid = Number(pidOutcome!.ok && pidOutcome!.result.rows[0]![0]);
      const begun = await app.api.session.run({ statements: ["begin", `insert into ${schema}.w values (1)`] });
      expect(begun.map((o) => o.ok)).toEqual([true, true]);
      expect(toasts().length).toBe(0);

      await side.run(`select pg_terminate_backend(${pid})`);
      const [second] = await app.api.session.run({ statements: [`insert into ${schema}.w values (2)`] });
      await app.settle();
      // Whether the insert ran on a new connection or failed, the user is told once.
      expect(toasts().length).toBe(1);
      if (second!.ok === false) {
        expect(second!.error.message).toContain(sentence);
      }
      await app.api.session.run({ statements: ["rollback"] });
      expect(toasts().length).toBe(1);
    } finally {
      await side.run(`drop schema if exists ${schema} cascade`).catch(() => {});
      await side.close();
    }
  }, 30_000);
});

describe("final-c2 fix 5: a failed connect hides the bare password of the URL that was tried", () => {
  const failingWith = (message: string) => async (_connection: Connection): Promise<Driver> => {
    throw new Error(message);
  };

  const connectAndRead = async (input: string, message: string) => {
    app = await mount({ connection: null, deps: { openSession: failingWith(message) } });
    const res = await app.api.session.connect(input);
    await app.waitFor(() => app.api.dialog.depth() === 1);
    await app.press("<Esc>");
    await app.press(`:connect ${input}<CR>`);
    await app.waitFor(() => app.api.toast.items().some((t) => t.kind === "error"));
    return { message: res.ok ? "" : res.message, frame: app.frame(), toasts: app.api.toast.items().map((t) => t.message).join("\n") };
  };

  test("a raw password repeated by the error is hidden in the message and on screen", async () => {
    const seen = await connectAndRead("postgres://app:Sup3rS3cretPw@127.0.0.1:1/x", "rejected credential Sup3rS3cretPw for app");
    expect(seen.message).toContain("rejected credential");
    for (const text of [seen.message, seen.frame, seen.toasts]) expect(text).not.toContain("Sup3rS3cretPw");
  });

  test("a password percent-encoded in the URL and raw in the error is hidden", async () => {
    const seen = await connectAndRead("postgres://app:Sup3r%40S3cret%2FPw@127.0.0.1:1/x", "rejected credential Sup3r@S3cret/Pw for app");
    expect(seen.message).toContain("rejected credential");
    for (const text of [seen.message, seen.frame, seen.toasts]) {
      expect(text).not.toContain("Sup3r@S3cret/Pw");
      expect(text).not.toContain("S3cret");
    }
  });

  test("a password shorter than 8 characters is hidden only where redactMessage hides it", async () => {
    app = await mount({ connection: null, deps: { openSession: failingWith("rejected credential abc12 for app at app:abc12@db") } });
    const res = await app.api.session.connect("postgres://app:abc12@127.0.0.1:1/x");
    const message = res.ok ? "" : res.message;
    expect(message).toContain("rejected credential abc12 for app");
    expect(message).not.toContain(":abc12@");
  });
});
