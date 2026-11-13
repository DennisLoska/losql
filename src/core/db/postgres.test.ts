import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openSession, parseConnection } from "./connection";
import { openPostgres, resolvePostgresTarget } from "./postgres";
import { QueryError, type Driver } from "./types";

const url = process.env.LOSQL_TEST_PG_URL;
const suite = url ? describe : describe.skip;

let canCreateRole = false;
if (url) {
  try {
    const probe = await openSession(parseConnection(url));
    try {
      const privRes = await probe.run(
        "select (rolcreaterole or rolsuper) as can_create from pg_roles where rolname = current_user",
      );
      canCreateRole = Boolean(privRes.rows[0]?.[0]);
    } finally {
      await probe.close();
    }
  } catch {
    canCreateRole = false;
  }
}

suite("postgres driver", () => {
  let driver: Driver;
  const schema = `losql_t_${Date.now().toString(36)}`;

  beforeAll(async () => {
    driver = await openSession(parseConnection(url!));
    await driver.run(`create schema ${schema}`);
    await driver.run(`set search_path = ${schema}`);
    await driver.run("create table teams (id int primary key, title text)");
    await driver.run("create table people (id int primary key, name text not null, age int, team_id int references teams(id))");
    await driver.run("insert into teams values (1, 'core')");
    await driver.run("insert into people values (1, 'Ada', 36, 1), (2, 'Linus', null, 1)");
  });
  afterAll(async () => {
    await driver.run(`drop schema ${schema} cascade`);
    await driver.close();
  });

  test("a query returns columns with type names and rows as arrays", async () => {
    const r = await driver.run("select id, name, age from people order by id");
    expect(r.columns).toEqual([{ name: "id", type: "int4" }, { name: "name", type: "text" }, { name: "age", type: "int4" }]);
    expect(r.rows).toEqual([[1, "Ada", 36], [2, "Linus", null]]);
    expect(r.command).toBe("SELECT");
    expect(r.affected).toBeNull();
    expect(r.truncated).toBe(false);
  });

  test("an empty result keeps its columns, and duplicate names are preserved", async () => {
    const r = await driver.run("select 1 as a, 2 as a, 'x'::text as b where false");
    expect(r.columns).toEqual([{ name: "a", type: "int4" }, { name: "a", type: "int4" }, { name: "b", type: "text" }]);
    expect(r.rows).toEqual([]);
    const dup = await driver.run("select 1 as a, 2 as a");
    expect(dup.rows).toEqual([[1, 2]]);
  });

  test("maxRows caps the rows without reading everything", async () => {
    const r = await driver.run("select generate_series(1, 1000000) as n", { maxRows: 10 });
    expect(r.rows.length).toBe(10);
    expect(r.truncated).toBe(true);
    expect(r.durationMs).toBeLessThan(2000);
  });

  test("a statement without rows reports the affected count", async () => {
    const r = await driver.run("update people set age = 40 where id = 1");
    expect(r.columns).toEqual([]);
    expect(r.affected).toBe(1);
    expect(r.command).toBe("UPDATE");
  });

  test("values are normalized", async () => {
    const r = await driver.run(
      `select 9007199254740993::int8 as big, 12345.6789::numeric as num, '{"k":[1,2]}'::jsonb as j,
              true as b, '\\x00ff10'::bytea as bin, '2026-01-02T03:04:05Z'::timestamptz as ts, 1.5::float8 as f`,
    );
    expect(r.rows).toEqual([[
      "9007199254740993", "12345.6789", { k: [1, 2] }, true, "\\x00ff10", "2026-01-02T03:04:05.000Z", 1.5,
    ]]);
    expect(r.columns.map((c) => c.type)).toEqual(["int8", "numeric", "jsonb", "bool", "bytea", "timestamptz", "float8"]);
  });

  test("an error becomes a QueryError with code and position", async () => {
    const error = await driver.run("select * frm people").then(() => null, (e) => e);
    expect(error).toBeInstanceOf(QueryError);
    expect(error.code).toBe("42601");
    expect(error.position).toBe(10);
    expect(error.message).toContain("syntax error");
  });

  test("session state persists between runs", async () => {
    await driver.run("begin");
    await driver.run("create table temp_in_txn (a int)");
    await driver.run("rollback");
    await expect(driver.run("select * from temp_in_txn")).rejects.toThrow(QueryError);
    expect((await driver.run("show search_path")).rows).toEqual([[schema]]);
  });

  test("readOnly is enforced by the database and leaves data alone", async () => {
    const q = `delete from ${schema}.people`;
    const error = await driver.run(q, { readOnly: true }).then(() => null, (e) => e);
    expect(error).toBeInstanceOf(QueryError);
    expect(error.code).toBe("25006");
    expect((await driver.run("select count(*)::int from people")).rows).toEqual([[2]]);
    expect((await driver.run(`select count(*)::int from ${schema}.people`, { readOnly: true })).rows).toEqual([[2]]);
  });

  test("readOnly gate blocks non-read statements before reaching server, and server blocks write in read statement", async () => {
    const blocked = [
      "copy (select 1) to program 'true'",
      "copy (select 1) to '/tmp/losql-should-not-exist'",
      "create table x(a int)",
      "set search_path = public",
      "select 1; drop table if exists x",
      "do $$ begin null; end $$",
    ];
    for (const stmt of blocked) {
      const err = await driver.run(stmt, { readOnly: true }).then(() => null, (e) => e);
      expect(err).toBeInstanceOf(QueryError);
      expect(err.message).toBe("attempt to write a readonly database");
      expect(err.code).toBe("25006");
    }
    expect((await driver.run("select 1", { readOnly: true })).rows).toEqual([[1]]);

    await driver.run(`create sequence ${schema}.ro_seq start 10`);
    const seqErr = await driver.run(`select nextval('${schema}.ro_seq')`, { readOnly: true }).then(() => null, (e) => e);
    expect(seqErr).toBeInstanceOf(QueryError);
    expect(seqErr.code).toBe("25006");
    expect((await driver.run(`select last_value, is_called from ${schema}.ro_seq`)).rows).toEqual([["10", false]]);
  });

  test("a read-only run does not disturb an open transaction", async () => {
    await driver.run("begin");
    await driver.run("insert into teams values (2, 'tmp')");
    const outside = await driver.run(`select count(*)::int from ${schema}.teams`, { readOnly: true });
    expect(outside.rows).toEqual([[1]]);
    await driver.run("rollback");
  });

  test("a read-only run resets session settings and releases advisory locks afterwards", async () => {
    await driver.run("select pg_advisory_lock(42)", { readOnly: true });
    const tryLock = await driver.run("select pg_try_advisory_lock(42)");
    expect(tryLock.rows).toEqual([[true]]);
    await driver.run("select pg_advisory_unlock(42)");

    const defaultPath = (await driver.run("show search_path", { readOnly: true })).rows;
    await driver.run("select set_config('search_path', 'pg_catalog', false)", { readOnly: true });
    const nextPath = (await driver.run("show search_path", { readOnly: true })).rows;
    expect(nextPath).toEqual(defaultPath);
  });

  test("timeoutMs and abort cancel a slow run", async () => {
    const started = Date.now();
    await expect(driver.run("select pg_sleep(10)", { readOnly: true, timeoutMs: 300 })).rejects.toThrow(QueryError);
    expect(Date.now() - started).toBeLessThan(3000);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const t0 = Date.now();
    await expect(driver.run("select pg_sleep(10)", { signal: controller.signal })).rejects.toThrow(QueryError);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect((await driver.run("select 1 as ok")).rows).toEqual([[1]]);
  });

  test("schema lists relations with keys and references, without system schemas", async () => {
    await driver.run("create view adults as select name from people where age >= 18");
    const s = await driver.schema();
    expect(s.dialect).toBe("postgres");
    expect(s.namespaces.some((n) => n.name === "pg_catalog" || n.name === "information_schema")).toBe(false);
    const ns = s.namespaces.find((n) => n.name === schema)!;
    expect(ns.relations.map((r) => r.name)).toEqual(["adults", "people", "teams"]);
    expect(ns.relations.find((r) => r.name === "adults")!.kind).toBe("view");
    expect(ns.relations.find((r) => r.name === "people")).toEqual({
      name: "people", kind: "table",
      columns: [
        { name: "id", type: "int4", nullable: false, primaryKey: true },
        { name: "name", type: "text", nullable: false, primaryKey: false },
        { name: "age", type: "int4", nullable: true, primaryKey: false },
        { name: "team_id", type: "int4", nullable: true, primaryKey: false, references: { relation: `${schema}.teams`, column: "id" } },
      ],
    });
  });

  test("unseeded OIDs are resolved from pg_type and readOnly cannot be escaped", async () => {
    const inetRes = await driver.run("select '127.0.0.1'::inet as ip");
    expect(inetRes.columns).toEqual([{ name: "ip", type: "inet" }]);
    expect(inetRes.rows).toEqual([["127.0.0.1"]]);

    await expect(
      driver.run(`do $$ begin set transaction read write; delete from ${schema}.people; end $$`, { readOnly: true }),
    ).rejects.toThrow(QueryError);
    await expect(
      driver.run(`commit; delete from ${schema}.people`, { readOnly: true }),
    ).rejects.toThrow(QueryError);
    expect((await driver.run("select count(*)::int from people")).rows).toEqual([[2]]);
  });

  test("close() cancels an in-flight Run, is idempotent, and rejects subsequent Runs", async () => {
    const tempSession = await openSession(parseConnection(url!));
    const t0 = Date.now();
    const sleepPromise = tempSession.run("select pg_sleep(30)").then(
      () => null,
      (e) => e,
    );
    await new Promise((r) => setTimeout(r, 150));
    const closePromise = tempSession.close();
    const [err] = await Promise.all([sleepPromise, closePromise]);
    expect(Date.now() - t0).toBeLessThan(800);
    expect(err).toBeInstanceOf(QueryError);
    expect(err.code).toBe("57014");

    await tempSession.close();
    const afterErr = await tempSession.run("select 1").then(
      () => null,
      (e) => e,
    );
    expect(afterErr).toBeInstanceOf(QueryError);
    expect(afterErr.message.toLowerCase()).toContain("closed");
  });

  test("date, timestamp, time, timetz and interval are returned as server text while timestamptz is UTC ISO 8601", async () => {
    const query =
      "select date '2024-02-29' as d, timestamp '2024-02-29 13:45:00.123456' as ts, timestamptz '2024-02-29 13:45:00+02' as tstz, time '13:45:00.123456' as t, timetz '13:45:00+02' as ttz, interval '1 day 2 hours' as iv";

    await driver.run("set time zone 'America/Los_Angeles'");
    const la = await driver.run(query);
    expect(la.rows[0]?.slice(0, 3)).toEqual([
      "2024-02-29",
      "2024-02-29 13:45:00.123456",
      "2024-02-29T11:45:00.000Z",
    ]);
    expect(la.rows[0]?.[3]).toBe("13:45:00.123456");
    expect(typeof la.rows[0]?.[4]).toBe("string");
    expect(typeof la.rows[0]?.[5]).toBe("string");

    await driver.run("set time zone 'UTC'");
    const utc = await driver.run(query);
    expect(utc.rows[0]?.slice(0, 3)).toEqual([
      "2024-02-29",
      "2024-02-29 13:45:00.123456",
      "2024-02-29T11:45:00.000Z",
    ]);
    expect(utc.rows[0]?.[3]).toBe("13:45:00.123456");
  });

  test("columns named __proto__, constructor, and toString are preserved", async () => {
    const r = await driver.run('select 1 as "__proto__", 2 as "constructor", 3 as "toString"');
    expect(r.columns.map((c) => c.name)).toEqual(["__proto__", "constructor", "toString"]);
    expect(r.rows).toEqual([[1, 2, 3]]);
  });

  test("empty or comment-only text rejects with 'nothing to run'", async () => {
    for (const emptyText of ["", "   \n\t  ", "-- just a comment", "/* block */", ";", " ; -- c "]) {
      await expect(driver.run(emptyText)).rejects.toThrow("nothing to run");
      await expect(driver.run(emptyText, { readOnly: true })).rejects.toThrow("nothing to run");
    }
  });

  test.skipIf(!canCreateRole)(
    "a read-only Run without timeoutMs preserves the server's statement_timeout",
    async () => {
      const roleName = `losql_role_${Date.now().toString(36)}`;
      try {
        await driver.run(`create role ${roleName} login`);
        await driver.run(`alter role ${roleName} in database postgres set statement_timeout = '7s'`);
        const roleUrl = url!.replace("losql@", `${roleName}@`);
        const roleSession = await openSession(parseConnection(roleUrl));
        try {
          const res = await roleSession.run("show statement_timeout", { readOnly: true });
          expect(res.rows).toEqual([["7s"]]);
        } finally {
          await roleSession.close();
        }
      } finally {
        await driver.run(`alter role ${roleName} in database postgres reset all`).catch(() => {});
        await driver.run(`drop role if exists ${roleName}`).catch(() => {});
      }
    },
  );

  test("environment variables substituted in userinfo are percent-encoded and never leaked", async () => {
    const parsedOrig = new URL(url!);
    const hostPort = parsedOrig.port ? `${parsedOrig.hostname}:${parsedOrig.port}` : parsedOrig.hostname;
    const dbPath = parsedOrig.pathname;

    for (const pw of ["p/w", "p?w", "p@w", "p:w"]) {
      const conn = parseConnection(`postgres://losql:\${PW}@${hostPort}${dbPath}`);
      expect(conn.display).not.toContain(pw);
      const sess = await openSession(conn, { env: { PW: pw } });
      try {
        expect((await sess.run("select 1")).rows).toEqual([[1]]);
      } finally {
        await sess.close();
      }

      const badConn = parseConnection("postgres://u:${PW}@127.0.0.1:1/db");
      const err = await openSession(badConn, { env: { PW: pw } }).then(
        () => null,
        (e) => e,
      );
      expect(err).toBeInstanceOf(QueryError);
      expect(String(err.message)).not.toContain(pw);
      expect(String(err.message)).not.toContain(encodeURIComponent(pw));
    }
  });

  test("valid Postgres URLs with @ in query/path or encoded password connect to the right target", async () => {
    const parsedOrig = new URL(url!);
    const hostPort = parsedOrig.port ? `${parsedOrig.hostname}:${parsedOrig.port}` : parsedOrig.hostname;
    const dbName = parsedOrig.pathname.replace(/^\/+/, "") || "postgres";

    await driver.run('drop database if exists "a@b"');
    await driver.run('create database "a@b"');
    try {
      const liveShapes = [
        {
          raw: `postgres://losql:pw@${hostPort}/${dbName}?application_name=me@x`,
          expectedDb: dbName,
          secrets: ["pw"],
        },
        {
          raw: `postgres://losql:pw@${hostPort}/a@b`,
          expectedDb: "a@b",
          secrets: ["pw"],
        },
        {
          raw: `postgres://losql:p%40w@${hostPort}/${dbName}?application_name=a@b`,
          expectedDb: dbName,
          secrets: ["p@w", "p%40w"],
        },
        {
          raw: `postgres://losql@${hostPort}/${dbName}?password=sec%20ret&application_name=x1`,
          expectedDb: dbName,
          secrets: ["sec"],
        },
      ];

      for (const { raw, expectedDb, secrets } of liveShapes) {
        const conn = parseConnection(raw);
        expect(conn.name).toBe(expectedDb);
        for (const s of secrets) {
          expect(conn.display).not.toContain(s);
          expect(conn.name).not.toContain(s);
          expect(conn.id).not.toContain(s);
        }
        const sess = await openSession(conn);
        try {
          const res = await sess.run("select current_database(), current_user");
          expect(res.rows).toEqual([[expectedDb, "losql"]]);
        } finally {
          await sess.close();
        }
      }
    } finally {
      await driver.run('drop database if exists "a@b"').catch(() => {});
    }
  });

  test("close() does not keep the process alive", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = await mkdtemp(join(tmpdir(), "losql-pg-exit-"));
    try {
      const scriptPath = join(dir, "exit-check.ts");
      const connModPath = join(import.meta.dir, "connection.ts");
      const script = [
        `import { openSession, parseConnection } from ${JSON.stringify(connModPath)};`,
        `const session = await openSession(parseConnection(${JSON.stringify(url!)}));`,
        `await session.run("select 1");`,
        `await session.close();`,
      ].join("\n");
      await writeFile(scriptPath, script, "utf8");

      const t0 = performance.now();
      const proc = Bun.spawn([process.execPath, scriptPath], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      const elapsedMs = performance.now() - t0;

      expect(exitCode).toBe(0);
      expect(elapsedMs).toBeLessThan(1000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("concurrent read-only Runs do not overlap, clean up before the next starts, and honor signal, timeoutMs, and close()", async () => {
    const defaultPathRes = await driver.run("show search_path", { readOnly: true });
    const defaultPath = defaultPathRes.rows[0]?.[0];

    const [r1, r2] = await Promise.all([
      driver.run(
        "select pg_advisory_lock(55), set_config('search_path', 'pg_catalog', false), pg_sleep(0.05)",
        { readOnly: true },
      ),
      driver.run(
        "select count(*)::int from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and objid = 55 union all select (current_setting('search_path') = $q$" +
          String(defaultPath) +
          "$q$)::int",
        { readOnly: true },
      ),
    ]);

    expect(r1.rows.length).toBe(1);
    expect(r2.rows).toEqual([[0], [1]]);

    // Waiting read-only Run honors timeoutMs counted from when it was asked for
    const t0 = performance.now();
    const slowFirst = driver.run("select pg_sleep(0.4)", { readOnly: true });
    const timedOutWaiter = driver
      .run("select 1", { readOnly: true, timeoutMs: 120 })
      .then(
        () => null,
        (e) => e,
      );
    const [waiterErr] = await Promise.all([timedOutWaiter, slowFirst]);
    const elapsedWaiter = performance.now() - t0;
    expect(waiterErr).toBeInstanceOf(QueryError);
    expect(elapsedWaiter).toBeLessThan(1000);

    // Waiting read-only Run honors signal abort while queued
    const ac = new AbortController();
    const slowFirst2 = driver.run("select pg_sleep(0.3)", { readOnly: true });
    const abortedWaiter = driver
      .run("select 1", { readOnly: true, signal: ac.signal })
      .then(
        () => null,
        (e) => e,
      );
    setTimeout(() => ac.abort(), 60);
    const [abortErr] = await Promise.all([abortedWaiter, slowFirst2]);
    expect(abortErr).toBeInstanceOf(QueryError);

    // close() rejects waiting read-only Runs
    const sClose = await openSession(parseConnection(url!));
    const firstInFlight = sClose.run("select pg_sleep(10)", { readOnly: true }).then(
      () => null,
      (e) => e,
    );
    const waitingOnSide = sClose.run("select 1", { readOnly: true }).then(
      () => null,
      (e) => e,
    );
    await new Promise((r) => setTimeout(r, 80));
    await sClose.close();
    const [err1, err2] = await Promise.all([firstInFlight, waitingOnSide]);
    expect(err1).toBeInstanceOf(QueryError);
    expect(err2).toBeInstanceOf(QueryError);
  });

  test("close() during schema() rejects with QueryError('the Session is closed')", async () => {
    const sSchema = await openSession(parseConnection(url!));
    const schemaPromise = sSchema.schema().then(
      () => null,
      (e) => e,
    );
    await sSchema.close();
    const err = await schemaPromise;
    expect(err).toBeInstanceOf(QueryError);
    expect(err.message).toBe("the Session is closed");
  });

  test("a waiting read-only Run that gives up (abort or timeoutMs) does not let the next one overtake", async () => {
    // 1. Abort on middle Run B
    {
      const events: string[] = [];
      const ac = new AbortController();
      const t0 = performance.now();

      const runA = driver
        .run("select pg_advisory_lock(77), pg_sleep(1)", { readOnly: true })
        .then((res) => {
          events.push("A");
          return res;
        });

      setTimeout(() => ac.abort(), 250);
      let bElapsed = 0;
      const runB = driver
        .run("select 1", { readOnly: true, signal: ac.signal })
        .then(
          () => {
            events.push("B-ok");
            return null;
          },
          (e) => {
            bElapsed = performance.now() - t0;
            events.push("B-err");
            return e;
          },
        );

      const runC = driver
        .run(
          "select count(*)::int from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and objid = 77",
          { readOnly: true },
        )
        .then((res) => {
          events.push("C");
          return res;
        });

      const [resA, errB, resC] = await Promise.all([runA, runB, runC]);
      expect(resA.rows.length).toBe(1);
      expect(errB).toBeInstanceOf(QueryError);
      expect(errB.code).toBe("57014");
      expect(bElapsed).toBeLessThan(400);
      expect(resC.rows).toEqual([[0]]);
      expect(events).toEqual(["B-err", "A", "C"]);
    }

    // 2. timeoutMs: 250 on middle Run B
    {
      const events: string[] = [];
      const t0 = performance.now();

      const runA = driver
        .run("select pg_advisory_lock(77), pg_sleep(1)", { readOnly: true })
        .then((res) => {
          events.push("A");
          return res;
        });

      let bElapsed = 0;
      const runB = driver
        .run("select 1", { readOnly: true, timeoutMs: 250 })
        .then(
          () => {
            events.push("B-ok");
            return null;
          },
          (e) => {
            bElapsed = performance.now() - t0;
            events.push("B-err");
            return e;
          },
        );

      const runC = driver
        .run(
          "select count(*)::int from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and objid = 77",
          { readOnly: true },
        )
        .then((res) => {
          events.push("C");
          return res;
        });

      const [resA, errB, resC] = await Promise.all([runA, runB, runC]);
      expect(resA.rows.length).toBe(1);
      expect(errB).toBeInstanceOf(QueryError);
      expect(errB.code).toBe("57014");
      expect(errB.message).toContain("statement timeout");
      expect(bElapsed).toBeLessThan(400);
      expect(resC.rows).toEqual([[0]]);
      expect(events).toEqual(["B-err", "A", "C"]);
    }

    // 3. close() with multiple queued Runs rejects all of them
    {
      const sClose = await openSession(parseConnection(url!));
      const p1 = sClose.run("select pg_sleep(10)", { readOnly: true }).then(() => null, (e) => e);
      const p2 = sClose.run("select 1", { readOnly: true }).then(() => null, (e) => e);
      const p3 = sClose.run("select 2", { readOnly: true }).then(() => null, (e) => e);
      await new Promise((r) => setTimeout(r, 80));
      await sClose.close();
      const [e1, e2, e3] = await Promise.all([p1, p2, p3]);
      expect(e1).toBeInstanceOf(QueryError);
      expect(e2).toBeInstanceOf(QueryError);
      expect(e3).toBeInstanceOf(QueryError);
    }
  });

  test("query parameters (?port=, ?user=, ?database=, ?host=) override authority in both display and actual server connection", async () => {
    const parsedOrig = new URL(url!);
    const realHost = parsedOrig.hostname;
    const realPort = Number(parsedOrig.port || "5432");
    const realUser = decodeURIComponent(parsedOrig.username || "losql");
    const realDb = decodeURIComponent(parsedOrig.pathname.replace(/^\/+/, "") || "postgres");

    const cases = [
      // Wrong port in authority, right ?port=
      `postgres://${realUser}@${realHost}:59999/${realDb}?port=${realPort}`,
      // Wrong user in authority, right ?user=
      `postgres://wrong_authority_user@${realHost}:${realPort}/${realDb}?user=${realUser}`,
      // Wrong database in authority, right ?database=
      `postgres://${realUser}@${realHost}:${realPort}/wrong_authority_db?database=${realDb}`,
      // Wrong database in authority, right ?db=
      `postgres://${realUser}@${realHost}:${realPort}/wrong_authority_db?db=${realDb}`,
      // Wrong host, port, user, database in authority, all right in query params
      `postgres://wrong_u:s3cr+et@wrong.invalid:59999/wrong_db?host=${realHost}&port=${realPort}&user=${realUser}&database=${realDb}`,
    ];

    for (const rawUrl of cases) {
      const conn = parseConnection(rawUrl);
      expect(conn.display).toBe(`postgres://${realUser}@${realHost}:${realPort}/${realDb}`);
      expect(conn.name).toBe(realDb);
      expect(conn.display).not.toContain("s3cr");

      const sess = await openSession(conn);
      try {
        const res = await sess.run("select current_user, current_database(), inet_server_port()::int");
        expect(res.rows).toEqual([[realUser, realDb, realPort]]);
      } finally {
        await sess.close();
      }
    }
  });
});

test("an unreachable server is a QueryError that does not leak the password", async () => {
  const error = await openSession(parseConnection("postgres://u:hunter2@127.0.0.1:1/db")).then(() => null, (e) => e);
  expect(error).toBeInstanceOf(QueryError);
  expect(String(error.message)).not.toContain("hunter2");
});

test("query parameters (?password=, ?user=, ?database=, ?host=) are percent-decoded only so '+' stays '+' in values handed to the client", async () => {
  const { buildPostgresClientArgs, resolvePostgresTarget } = await import("./postgres");

  // ?password=a+b -> a+b, a%2Bb -> a+b, a%20b -> a b
  expect(
    buildPostgresClientArgs(resolvePostgresTarget("postgres://u@h/db?password=a+b")).options.password,
  ).toBe("a+b");
  expect(
    buildPostgresClientArgs(resolvePostgresTarget("postgres://u@h/db?password=a%2Bb")).options.password,
  ).toBe("a+b");
  expect(
    buildPostgresClientArgs(resolvePostgresTarget("postgres://u@h/db?password=a%20b")).options.password,
  ).toBe("a b");
  expect(
    buildPostgresClientArgs(resolvePostgresTarget("postgres://u@h/db?pass=a+b")).options.password,
  ).toBe("a+b");

  // Same rule for user, database, host, port
  const argsPlus = buildPostgresClientArgs(
    resolvePostgresTarget("postgres://u@h/db?user=u+1&database=d+1&host=h+1&port=5433"),
  );
  expect(argsPlus.options).toEqual({
    host: "h+1",
    port: 5433,
    user: "u+1",
    database: "d+1",
  });

  const argsPctPlus = buildPostgresClientArgs(
    resolvePostgresTarget("postgres://u@h/db?user=u%2B1&database=d%2B1&host=h%2B1"),
  );
  expect(argsPctPlus.options).toEqual({
    host: "h+1",
    port: 5432,
    user: "u+1",
    database: "d+1",
  });

  const argsSpace = buildPostgresClientArgs(
    resolvePostgresTarget("postgres://u@h/db?user=u%201&database=d%201&host=h%201"),
  );
  expect(argsSpace.options).toEqual({
    host: "h 1",
    port: 5432,
    user: "u 1",
    database: "d 1",
  });


  // Unreachable server with ?password=secret+plus123 never leaks password in error text
  const err = await openSession(
    parseConnection("postgres://u@127.0.0.1:1/db?password=secret+plus123"),
  ).then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(QueryError);
  expect(String(err.message)).not.toContain("secret+plus123");
  expect(String(err.message)).not.toContain("secret");
});

describe("pass= is a password in the messages of openPostgres's rejections", () => {
  const spellings = (secret: string) => [
    (base: string) => base.replace("://u@", `://u:${secret}@`),
    (base: string) => `${base}&password=${secret}`,
    (base: string) => `${base}&pass=${secret}`,
    (base: string) => `${base}&%70ass=${secret}`,
    (base: string) => `${base}&pass%77ord=${secret}`,
    (base: string) => `${base}&PASS=${secret}`,
  ];
  // Every way openPostgres rejects a URL before talking to a server, plus a server that is not there
  // (port 1 on the loopback interface).
  const bases = [
    "postgres://u@127.0.0.1:5432/db?port=x",
    "postgres://u@127.0.0.1:5432/db?port=70000",
    "postgres://u@127.0.0.1:5432/db?host=a,b",
    "postgres://u@a,b:5432/db?sslmode=require",
    "postgres://u@127.0.0.1:5432/db?x=%zz",
    "postgres://u@127.0.0.1:99999/db?sslmode=require",
    "postgres://u@[::1/db?sslmode=require",
    "postgres://u@127.0.0.1:1/db?sslmode=disable",
  ];

  test("SECRET never appears, for the password in the authority, in password= and in pass= (each spelling)", async () => {
    for (const base of bases) {
      for (const put of spellings("SECRET")) {
        const rawUrl = put(base);
        const conn = { id: "x", name: "x", dialect: "postgres" as const, url: rawUrl, display: "x" };
        const err = await openPostgres(conn, { env: {} }).then(
          async (d) => {
            await d.close();
            return null;
          },
          (e) => e,
        );
        expect(err).toBeInstanceOf(QueryError);
        expect(String(err.message)).not.toContain("SECRET");
        expect(String(err.detail ?? "")).not.toContain("SECRET");
        expect(String(err.hint ?? "")).not.toContain("SECRET");
      }
    }
  });

  test.skipIf(!url)("a server's rejection (unknown role, unknown database) never shows SECRET", async () => {
    const real = new URL(url!);
    const hostPort = `${real.hostname}:${real.port || "5432"}`;
    const rejected = [
      `postgres://u@${hostPort}/postgres?user=losql_no_such_role_x`,
      `postgres://u@${hostPort}/postgres?user=${decodeURIComponent(real.username || "losql")}&database=losql_no_such_db_x`,
    ];
    for (const base of rejected) {
      for (const put of spellings("SECRET")) {
        const conn = { id: "x", name: "x", dialect: "postgres" as const, url: put(base), display: "x" };
        const err = await openPostgres(conn, { env: {} }).then(
          async (d) => {
            await d.close();
            return null;
          },
          (e) => e,
        );
        expect(err).toBeInstanceOf(QueryError);
        expect(String(err.message)).not.toContain("SECRET");
        expect(String(err.detail ?? "")).not.toContain("SECRET");
      }
    }
  });
});

describe("an empty query value is an absent one", () => {
  test("resolvePostgresTarget takes the authority's host and port for ?port=, ?host= and ?host=&port=", () => {
    expect(resolvePostgresTarget("postgres://u@h.example:6000/db?port=")).toMatchObject({ host: "h.example", port: 6000 });
    expect(resolvePostgresTarget("postgres://u@h.example:6000/db?host=")).toMatchObject({ host: "h.example", port: 6000 });
    expect(resolvePostgresTarget("postgres://u@h.example:6000/db?host=&port=7000")).toMatchObject({
      host: "h.example",
      port: 7000,
    });
    expect(resolvePostgresTarget("postgres://u:pw@h/db?user=&database=&password=&pass=")).toMatchObject({
      user: "u",
      database: "db",
      password: "pw",
    });
  });

  test.skipIf(!url)("?port=, ?host= and ?host=&port=<port> connect to the live server and display the authority's target", async () => {
    const real = new URL(url!);
    const host = real.hostname;
    const port = Number(real.port || "5432");
    const user = decodeURIComponent(real.username || "losql");
    const db = decodeURIComponent(real.pathname.replace(/^\/+/, "") || "postgres");
    const cases = [
      `postgres://${user}@${host}:${port}/${db}?port=`,
      `postgres://${user}@${host}:${port}/${db}?host=`,
      `postgres://${user}@${host}:${port}/${db}?host=&port=${port}`,
    ];
    for (const rawUrl of cases) {
      const conn = parseConnection(rawUrl);
      expect(conn.display).toBe(`postgres://${user}@${host}:${port}/${db}`);
      const sess = await openSession(conn);
      try {
        const res = await sess.run("select current_user, current_database(), inet_server_port()::int");
        expect(res.rows).toEqual([[user, db, port]]);
      } finally {
        await sess.close();
      }
    }
  });
});

suite("a Statement with a NUL character (U+0000) is never run on postgres", () => {
  const NUL_MESSAGE = "the statement contains a NUL character (U+0000) and was not run";
  const NUL = "\u0000";
  const schema = `losql_nul_${Date.now().toString(36)}`;
  const t = `${schema}.orders`;
  let driver: Driver;
  let before: Awaited<ReturnType<Driver["run"]>>["rows"];

  beforeAll(async () => {
    driver = await openSession(parseConnection(url!));
    await driver.run(`create schema ${schema}`);
    await driver.run(`create table ${t} (id int primary key, n int, note text)`);
    await driver.run(`insert into ${t} values (1, 10, 'a'), (2, 20, 'b'), (3, 30, 'c'), (4, 40, 'd'), (5, 50, 'e')`);
    before = (await driver.run(`select id, n, note from ${t} order by id`)).rows;
  });
  afterAll(async () => {
    await driver.run(`drop schema ${schema} cascade`);
    await driver.close();
  });

  async function expectUnchanged() {
    expect((await driver.run(`select count(*)::int from ${t}`)).rows).toEqual([[5]]);
    expect((await driver.run(`select id, n, note from ${t} order by id`)).rows).toEqual(before);
  }

  const cases: [string, string][] = [
    ["a NUL before a where clause", `delete from ${t}${NUL} where id = 1`],
    ["a NUL before an or", `update ${t} set n = 0 where id = 1${NUL} or true`],
    ["a NUL at the start", `${NUL}delete from ${t} where id = 1`],
    ["a NUL at the end", `delete from ${t} where id = 1${NUL}`],
    ["a NUL inside a string literal", `update ${t} set note = 'a${NUL}b' where id = 1`],
    ["a NUL inside a comment", `delete from ${t} /* ${NUL} */ where id = 1`],
    ["a NUL after the terminating semicolon", `delete from ${t} where id = 1;${NUL}`],
    ["a read with a NUL before a where clause", `select * from ${t}${NUL} where id = 1`],
    ["a read with a NUL inside a string literal", `select 'a${NUL}b' from ${t}`],
    ["a read with a NUL after the terminating semicolon", `select count(*) from ${t};${NUL}`],
  ];

  for (const [name, sql] of cases) {
    test(`${name} is refused, also read-only, and the table is unchanged`, async () => {
      for (const opts of [undefined, { readOnly: true }]) {
        const err = await driver.run(sql, opts).then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(QueryError);
        expect((err as QueryError).message).toBe(NUL_MESSAGE);
      }
      await expectUnchanged();
      // The Driver still works afterwards, on both connections.
      expect((await driver.run(`update ${t} set n = n where id = 1`)).affected).toBe(1);
      expect((await driver.run(`select count(*)::int from ${t}`, { readOnly: true })).rows).toEqual([[5]]);
    }, 10000);
  }

  test("a text without a NUL runs as before", async () => {
    expect((await driver.run(`select note from ${t} where id = 2`, { readOnly: true })).rows).toEqual([["b"]]);
    expect((await driver.run(`update ${t} set note = 'b' where id = 2`)).affected).toBe(1);
  }, 10000);
});

describe("final-c2 fix 2: the Driver reports a main connection that was closed under it", () => {
  test.skipIf(!url)("after the backend was ended while idle, the Driver reports the loss exactly once", async () => {
    const driver = await openSession(parseConnection(url!));
    const other = await openSession(parseConnection(url!));
    try {
      expect(typeof driver.takeLostConnection).toBe("function");
      const firstPid = Number((await driver.run("select pg_backend_pid()")).rows[0]![0]);
      expect(driver.takeLostConnection!()).toBe(false);

      await other.run(`select pg_terminate_backend(${firstPid})`);
      let reports = 0;
      // The loss is reported by the time the next Run has its outcome at the latest.
      const deadline = Date.now() + 2000;
      while (reports === 0 && Date.now() < deadline) {
        if (driver.takeLostConnection!()) reports++;
        else await new Promise((resolve) => setTimeout(resolve, 10));
      }
      let pid: number | null = null;
      try {
        pid = Number((await driver.run("select pg_backend_pid()")).rows[0]![0]);
      } catch {
        // A Run sent before the library saw the close fails; the next one opens a new connection.
      }
      if (driver.takeLostConnection!()) reports++;
      pid ??= Number((await driver.run("select pg_backend_pid()")).rows[0]![0]);
      if (driver.takeLostConnection!()) reports++;
      expect(pid).not.toBe(firstPid);
      await driver.run("select 1");
      if (driver.takeLostConnection!()) reports++;
      expect(reports).toBe(1);
    } finally {
      await driver.close();
      await other.close();
    }
    // Closing the Driver is not a loss.
    expect(driver.takeLostConnection!()).toBe(false);
  });
});
