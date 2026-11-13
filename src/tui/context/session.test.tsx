import { afterEach, describe, expect, test } from "bun:test";
import { openSession } from "../../core/db/connection";
import { QueryError, type Connection, type Driver, type Result } from "../../core/db/types";
import { readHistory } from "../../core/state";
import { mount, type TestApp } from "../testing";
import type { RunOutcome } from "./session";

let app: TestApp;
afterEach(async () => { await app?.dispose(); });

const connected = () => app.waitFor(() => app.api.session.status() === "connected" && app.api.session.schema() !== null);
const emptyResult: Result = { columns: [{ name: "x", type: "integer" }], rows: [[1]], truncated: false, affected: null, command: "SELECT", durationMs: 1 };

describe("connecting", () => {
  test("the Connection from the arguments is opened at start", async () => {
    app = await mount();
    await connected();
    expect(app.api.session.connection()?.name).toBe("demo");
    expect(app.api.session.schema()!.namespaces[0]!.relations.map((r) => r.name)).toEqual(["customers", "order_items", "orders", "products"]);
    expect(app.frame()).toContain("demo · sqlite");
    expect(app.api.config.state().lastConnection).toBe("demo");
  });

  test("without a Connection the statusline says so", async () => {
    app = await mount({ connection: null });
    expect(app.api.session.status()).toBe("none");
    expect(app.frame()).toContain("no connection");
  });

  test("DATABASE_URL and the last Connection are used when no argument is given", async () => {
    app = await mount({ connection: null, deps: { env: { DATABASE_URL: "demo" } } });
    await connected();
    await app.dispose();
    app = await mount({ connection: null, state: { lastConnection: "demo" } });
    await connected();
    expect(app.api.session.connection()?.id).toBe("demo");
  });

  test("a saved Connection is opened by name", async () => {
    app = await mount({ connection: "shop", config: { connections: [{ name: "shop", url: "demo" }] } });
    await connected();
    expect(app.api.session.connection()?.name).toBe("shop");
    expect(app.api.config.state().lastConnection).toBe("shop");
  });

  test("a failed connect reports the message and keeps the current Session", async () => {
    app = await mount();
    await connected();
    const outcome = await app.api.session.connect("/nonexistent/dir/x.db");
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.message).toContain("no such file");
    expect(app.api.session.connection()?.name).toBe("demo");
    expect(app.api.session.status()).toBe("connected");
    expect((await app.api.session.connect("ftp://nope")).ok).toBe(false);
  });

  test("a failed Connection at start leaves the application usable", async () => {
    app = await mount({ connection: "/nonexistent/dir/x.db" });
    await app.waitFor(() => app.api.toast.items().length > 0);
    expect(app.api.session.status()).toBe("none");
    expect(app.api.toast.items()[0]!.kind).toBe("error");
  });

  test("connecting again closes the previous Driver", async () => {
    const closed: string[] = [];
    app = await mount({
      deps: {
        openSession: async (connection: Connection) => {
          const driver = await openSession(connection);
          return { ...driver, connection: driver.connection, run: driver.run.bind(driver), schema: driver.schema.bind(driver), close: async () => { closed.push(connection.id); await driver.close(); } };
        },
      },
    });
    await connected();
    expect((await app.api.session.connect(":memory:")).ok).toBe(true);
    expect(closed).toEqual(["demo"]);
    expect(app.api.session.connection()?.id).toBe("memory");
    await app.api.quit();
    expect(closed).toEqual(["demo", "memory"]);
  });
});

describe("running", () => {
  test("a Run returns its Result, is shown and is recorded", async () => {
    app = await mount();
    await connected();
    const outcomes = await app.api.session.run({ statements: ["select count(*) as n from orders"] });
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]!.ok && outcomes[0]!.result.rows).toEqual([[12]]);
    expect(app.api.session.shown()).toBe(outcomes[0]!);
    expect(app.api.session.running()).toBeNull();
    const history = await readHistory(app.deps.paths);
    expect(history.length).toBe(1);
    expect(history[0]).toMatchObject({ connection: "demo", sql: "select count(*) as n from orders", ok: true, rows: 1 });
  });

  test("a batch stops at the first error", async () => {
    app = await mount();
    await connected();
    const outcomes = await app.api.session.run({ statements: ["select 1", "select * from nope", "select 2"] });
    expect(outcomes.map((o) => o.ok)).toEqual([true, false]);
    expect(outcomes[1]!.ok === false && outcomes[1]!.error.message).toContain("no such table: nope");
    expect(app.api.session.shown()).toBe(outcomes[1]!);
    expect<RunOutcome | null>(app.api.session.lastError()).toBe(outcomes[1]!);
    await app.api.session.run({ statements: ["select 1"] });
    expect(app.api.session.lastError()).toBeNull();
    expect((await readHistory(app.deps.paths)).map((h) => h.ok)).toEqual([true, false, true]);
  });

  test("a batch shows its last Result that has columns, and DDL refreshes the schema", async () => {
    app = await mount();
    await connected();
    const outcomes = await app.api.session.run({ statements: ["select 7 as seven", "create table extra (x integer)"] });
    expect(outcomes.length).toBe(2);
    expect(app.api.session.shown()).toBe(outcomes[0]!);
    await app.waitFor(() => app.api.session.schema()!.namespaces[0]!.relations.some((r) => r.name === "extra"));
  });

  test("the row cap comes from the config and can be overridden", async () => {
    app = await mount({ config: { results: { maxRows: 5 } } });
    await connected();
    const [capped] = await app.api.session.run({ statements: ["select * from orders"] });
    expect(capped!.ok && [capped!.result.rows.length, capped!.result.truncated]).toEqual([5, true]);
    const [more] = await app.api.session.run({ statements: ["select * from orders"], maxRows: 100 });
    expect(more!.ok && more!.result.rows.length).toBe(12);
  });

  test("read-only, unrecorded and unshown Runs", async () => {
    app = await mount();
    await connected();
    const [shownFirst] = await app.api.session.run({ statements: ["select 1 as one"] });
    const [refused] = await app.api.session.run({ statements: ["delete from orders"], readOnly: true, record: false, show: false });
    expect(refused!.ok).toBe(false);
    expect(app.api.session.shown()).toBe(shownFirst!);
    expect((await readHistory(app.deps.paths)).length).toBe(1);
    const [count] = await app.api.session.run({ statements: ["select count(*) from orders"], record: false });
    expect(count!.ok && count!.result.rows).toEqual([[12]]);
  });

  test("running without a Session is refused with a message", async () => {
    app = await mount({ connection: null });
    expect(await app.api.session.run({ statements: ["select 1"] })).toEqual([]);
    expect(app.api.status.message()).toEqual({ text: "Not connected (use :connect)", kind: "error" });
  });

  test("explain shows the plan", async () => {
    app = await mount();
    await connected();
    const [plan] = await app.api.session.explain("select * from orders where id = 1");
    expect(plan!.ok && plan!.result.columns.map((c) => c.name)).toContain("detail");
    expect(app.api.session.shown()).toBe(plan!);
    expect((await readHistory(app.deps.paths)).length).toBe(0);
  });
});

describe("with a scripted Driver", () => {
  function scripted(run: Driver["run"]): { openSession: (connection: Connection) => Promise<Driver>; opened: () => number } {
    let opened = 0;
    return {
      opened: () => opened,
      openSession: async (connection) => {
        opened++;
        return { connection, run, schema: async () => ({ dialect: "postgres", namespaces: [] }), close: async () => {} };
      },
    };
  }

  test("the running Run is visible and ctrl+c cancels it", async () => {
    const fake = scripted((_statement, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new QueryError("canceling statement due to user request")));
      }));
    app = await mount({ connection: "postgres://localhost/dev", deps: { openSession: fake.openSession } });
    await connected();
    const pending = app.api.session.run({ statements: ["select pg_sleep(10)"] });
    await app.settle();
    expect(app.api.session.running()?.statement).toBe("select pg_sleep(10)");
    expect(app.frame()).toContain("running");
    expect(await app.api.session.run({ statements: ["select 1"] })).toEqual([]);
    expect(app.api.status.message()?.text).toBe("A Run is already in progress");
    await app.press("<C-c>");
    const outcomes = await pending;
    expect(outcomes[0]!.ok === false && outcomes[0]!.error.message).toContain("canceling");
    expect(app.api.session.running()).toBeNull();
    expect(app.deps.exits).toEqual([]);
  });

  test("a lost connection is reopened once and the Statement retried", async () => {
    let calls = 0;
    const fake = scripted(async () => {
      calls++;
      if (calls === 1) throw new QueryError("write CONNECTION_CLOSED localhost:5432", { code: "CONNECTION_CLOSED" });
      return emptyResult;
    });
    app = await mount({ connection: "postgres://localhost/dev", deps: { openSession: fake.openSession } });
    await connected();
    const [outcome] = await app.api.session.run({ statements: ["select 1"] });
    expect(outcome!.ok).toBe(true);
    expect(fake.opened()).toBe(2);
    expect(app.api.session.status()).toBe("connected");
  });

  test("when reopening fails the Session is marked disconnected", async () => {
    let opened = 0;
    app = await mount({
      connection: "postgres://localhost/dev",
      deps: {
        openSession: async (connection) => {
          opened++;
          if (opened > 1) throw new QueryError("connect ECONNREFUSED");
          return {
            connection,
            run: async () => { throw new QueryError("read ECONNRESET", { code: "ECONNRESET" }); },
            schema: async () => ({ dialect: "postgres", namespaces: [] }),
            close: async () => {},
          };
        },
      },
    });
    await connected();
    const [outcome] = await app.api.session.run({ statements: ["select 1"] });
    expect(outcome!.ok).toBe(false);
    expect(app.api.session.status()).toBe("disconnected");
    await app.settle();
    expect(app.frame()).toContain("disconnected");
  });

  test("explain on Postgres", async () => {
    const seen: [string, boolean | undefined][] = [];
    const fake = scripted(async (statement, options) => {
      seen.push([statement, options?.readOnly]);
      return emptyResult;
    });
    app = await mount({ connection: "postgres://localhost/dev", deps: { openSession: fake.openSession } });
    await connected();
    await app.api.session.explain("select 1");
    await app.api.session.explain("select 1", true);
    expect(seen).toEqual([
      ["explain select 1", true],
      ["explain (analyze, buffers) select 1", true],
    ]);
  });
});

describe("the :connect and :refresh commands", () => {
  test(":connect with an argument switches the Session", async () => {
    app = await mount();
    await connected();
    await app.press(":connect :memory:<CR>");
    await app.waitFor(() => app.api.session.connection()?.id === "memory");
    await app.press(":connect /nonexistent/dir/x.db<CR>");
    await app.waitFor(() => app.api.toast.items().some((t) => t.kind === "error"));
    expect(app.api.session.connection()?.id).toBe("memory");
  });

  test(":refresh reloads the schema", async () => {
    app = await mount();
    await connected();
    await app.api.session.driver()!.run("create table sneaky (x integer)");
    await app.press(":refresh<CR>");
    await app.waitFor(() => app.api.session.schema()!.namespaces[0]!.relations.some((r) => r.name === "sneaky"));
  });
});
