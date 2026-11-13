import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession, parseConnection } from "./connection";
import { QueryError, type Driver } from "./types";

let dir: string;
let driver: Driver;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "losql-sqlite-"));
  driver = await openSession(parseConnection(join(dir, "t.db")), { create: true });
  await driver.run("create table people (id integer primary key, name text not null, age integer, team_id integer references teams(id))");
  await driver.run("create table teams (id integer primary key, title text)");
  await driver.run("insert into teams values (1, 'core')");
  await driver.run("insert into people values (1, 'Ada', 36, 1), (2, 'Linus', null, 1)");
});
afterEach(async () => {
  await driver.close();
  await rm(dir, { recursive: true, force: true });
});

describe("run", () => {
  test("a query returns columns and rows as arrays", async () => {
    const r = await driver.run("select id, name, age from people order by id");
    expect(r.columns).toEqual([{ name: "id", type: "integer" }, { name: "name", type: "text" }, { name: "age", type: "integer" }]);
    expect(r.rows).toEqual([[1, "Ada", 36], [2, "Linus", null]]);
    expect(r.truncated).toBe(false);
    expect(r.affected).toBeNull();
    expect(r.command).toBe("SELECT");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("an expression column gets a type from its first value", async () => {
    const r = await driver.run("select 1 + 1 as n, 'a' || 'b' as s, 1.5 as f, null as z");
    expect(r.columns).toEqual([{ name: "n", type: "integer" }, { name: "s", type: "text" }, { name: "f", type: "real" }, { name: "z", type: "" }]);
  });

  test("an empty result still has its columns", async () => {
    const r = await driver.run("select id, name from people where 1 = 0");
    expect(r.columns.map((c) => c.name)).toEqual(["id", "name"]);
    expect(r.rows).toEqual([]);
  });

  test("maxRows caps the rows and reports truncation", async () => {
    const sql = "with recursive c(x) as (select 1 union all select x + 1 from c where x < 5000) select x from c";
    const r = await driver.run(sql, { maxRows: 10 });
    expect(r.rows.length).toBe(10);
    expect(r.truncated).toBe(true);
    const exact = await driver.run("select id from people", { maxRows: 2 });
    expect(exact.rows.length).toBe(2);
    expect(exact.truncated).toBe(false);
  });

  test("a statement without rows reports the affected count", async () => {
    const r = await driver.run("update people set age = 40");
    expect(r.columns).toEqual([]);
    expect(r.rows).toEqual([]);
    expect(r.affected).toBe(2);
    expect(r.command).toBe("UPDATE");
  });

  test("values are normalized", async () => {
    const r = await driver.run("select 9007199254740993 as big, x'00ff10' as bin, 1 as small, 'x' as s");
    expect(r.rows).toEqual([["9007199254740993", "\\x00ff10", 1, "x"]]);
  });

  test("non-finite numbers are returned as text", async () => {
    const r = await driver.run("select 9e999 as pos_inf, -9e999 as neg_inf");
    expect(r.rows).toEqual([["Infinity", "-Infinity"]]);
  });

  test("columns named __proto__, constructor, and toString are preserved", async () => {
    const r = await driver.run('select 1 as "__proto__", 2 as "constructor", 3 as "toString"');
    expect(r.columns.map((c) => c.name)).toEqual(["__proto__", "constructor", "toString"]);
    expect(r.rows).toEqual([[1, 2, 3]]);
  });

  test("an error becomes a QueryError", async () => {
    await expect(driver.run("select nope from people")).rejects.toThrow(QueryError);
    await expect(driver.run("select nope from people")).rejects.toThrow("no such column: nope");
  });

  test("readOnly is enforced by the database", async () => {
    await expect(driver.run("delete from people", { readOnly: true })).rejects.toThrow(QueryError);
    await expect(driver.run("create table x (a)", { readOnly: true })).rejects.toThrow(QueryError);
    expect((await driver.run("select count(*) from people")).rows).toEqual([[2]]);
    expect((await driver.run("select count(*) from people", { readOnly: true })).rows).toEqual([[2]]);
    await driver.run("insert into people values (3, 'Grace', 45, null)");
    expect((await driver.run("select count(*) from people", { readOnly: true })).rows).toEqual([[3]]);
  });

  test("readOnly gate blocks non-read statements before SQLite engine executes them", async () => {
    await expect(driver.run("pragma user_version = 5", { readOnly: true })).rejects.toThrow("attempt to write a readonly database");
    await expect(driver.run("attach database ':memory:' as x", { readOnly: true })).rejects.toThrow("attempt to write a readonly database");
  });

  test("refuses text with more than one Statement and allows trailing semicolon and comments", async () => {
    await expect(driver.run("create table t1(id); create table t2(id)")).rejects.toThrow(
      "more than one Statement: run them one at a time",
    );
    const s = await driver.schema();
    expect(s.namespaces[0]!.relations.map((r) => r.name)).not.toContain("t1");

    await expect(
      driver.run("insert into teams values (9, 'a'); insert into teams values (10, 'b')"),
    ).rejects.toThrow("more than one Statement: run them one at a time");
    expect((await driver.run("select count(*) from teams")).rows).toEqual([[1]]);

    await expect(driver.run("select 1; select 2", { readOnly: true })).rejects.toThrow(
      "more than one Statement: run them one at a time",
    );

    expect((await driver.run("select 1;")).rows).toEqual([[1]]);
    expect((await driver.run("select 1; -- done")).rows).toEqual([[1]]);
  });

  test("empty or comment-only text rejects with 'nothing to run'", async () => {
    for (const emptyText of ["", "   \n\t  ", "-- just a comment", "/* block */", ";", " ; -- c "]) {
      await expect(driver.run(emptyText)).rejects.toThrow("nothing to run");
      await expect(driver.run(emptyText, { readOnly: true })).rejects.toThrow("nothing to run");
    }
  });
});

describe("schema", () => {
  test("lists relations with columns, keys and references", async () => {
    await driver.run("create view adults as select name from people where age >= 18");
    const s = await driver.schema();
    expect(s.dialect).toBe("sqlite");
    expect(s.namespaces.map((n) => n.name)).toEqual(["main"]);
    const rel = (name: string) => s.namespaces[0]!.relations.find((r) => r.name === name)!;
    expect(s.namespaces[0]!.relations.map((r) => r.name)).toEqual(["adults", "people", "teams"]);
    expect(rel("adults").kind).toBe("view");
    expect(rel("people")).toEqual({
      name: "people", kind: "table",
      columns: [
        { name: "id", type: "integer", nullable: true, primaryKey: true },
        { name: "name", type: "text", nullable: false, primaryKey: false },
        { name: "age", type: "integer", nullable: true, primaryKey: false },
        { name: "team_id", type: "integer", nullable: true, primaryKey: false, references: { relation: "teams", column: "id" } },
      ],
    });
  });

  test("schema snapshot matches literal sqlite_ prefix and includes generated columns", async () => {
    await driver.run("create table sqliteXdata (id integer primary key autoincrement)");
    await driver.run("insert into sqliteXdata values (null)");
    await driver.run(
      "create table gen_t (a int, b int generated always as (a * 2) virtual, c int generated always as (a * 3) stored)",
    );
    const s = await driver.schema();
    const relNames = s.namespaces[0]!.relations.map((r) => r.name);
    expect(relNames).toContain("sqliteXdata");
    expect(relNames).not.toContain("sqlite_sequence");

    const genRel = s.namespaces[0]!.relations.find((r) => r.name === "gen_t")!;
    expect(genRel.columns.map((c) => c.name)).toEqual(["a", "b", "c"]);
  });
});

describe("opening", () => {
  test("a missing file is an error unless create is set", async () => {
    await expect(openSession(parseConnection(join(dir, "missing.db")))).rejects.toThrow("no such file");
    const created = await openSession(parseConnection(join(dir, "fresh.db")), { create: true });
    await created.run("create table a (x)");
    await created.close();
  });

  test("readOnly works on an in-memory database", async () => {
    const mem = await openSession(parseConnection(":memory:"));
    await mem.run("create table a (x)");
    await mem.run("insert into a values (1)");
    await expect(mem.run("delete from a", { readOnly: true })).rejects.toThrow(QueryError);
    expect((await mem.run("select count(*) from a")).rows).toEqual([[1]]);
    await mem.run("insert into a values (2)");
    await mem.close();
  });

  test("a read-only Run on an in-memory database restores prior query_only state", async () => {
    const mem = await openSession(parseConnection(":memory:"));
    await mem.run("create table a (x)");
    await mem.run("insert into a values (1)");
    await mem.run("pragma query_only = on");
    await mem.run("select count(*) from a", { readOnly: true });
    expect((await mem.run("pragma query_only")).rows).toEqual([[1]]);
    await mem.close();
  });

  test("the demo database is seeded and stable", async () => {
    const demo = await openSession(parseConnection("demo"));
    const count = async (t: string) => (await demo.run(`select count(*) from ${t}`)).rows[0]![0];
    expect(await count("customers")).toBe(8);
    expect(await count("products")).toBe(6);
    expect(await count("orders")).toBe(12);
    expect(await count("order_items")).toBe(24);
    const orphans = await demo.run("select count(*) from order_items i left join orders o on o.id = i.order_id left join products p on p.id = i.product_id where o.id is null or p.id is null");
    expect(orphans.rows).toEqual([[0]]);
    const s = await demo.schema();
    expect(s.namespaces[0]!.relations.map((r) => r.name)).toEqual(["customers", "order_items", "orders", "products"]);
    await demo.close();
  });

  test("a capped Run does not disturb the next Run of the same Statement", async () => {
    const demo = await openSession(parseConnection("demo"));
    const sql = "select id from customers order by id";
    for (let i = 0; i < 3; i++) {
      const r = await demo.run(sql, { maxRows: 2 });
      expect(r.rows).toEqual([[1], [2]]);
      expect(r.truncated).toBe(true);
    }
    const all = await demo.run(sql);
    expect(all.rows).toEqual([[1], [2], [3], [4], [5], [6], [7], [8]]);
    expect(all.truncated).toBe(false);
    await demo.close();
  });

  test("duplicate column names are all kept", async () => {
    const demo = await openSession(parseConnection("demo"));
    const r = await demo.run("select 1 as a, 2 as a");
    expect(r.columns.map((c) => c.name)).toEqual(["a", "a"]);
    expect(r.rows).toEqual([[1, 2]]);

    const cust = await demo.run("select * from customers where id = 1");
    const ord = await demo.run("select * from orders where customer_id = 1 limit 1");
    const joined = await demo.run(
      "select * from customers join orders on customers.id = orders.customer_id where customers.id = 1 limit 1",
    );
    expect(joined.columns.length).toBe(cust.columns.length + ord.columns.length);
    expect(joined.rows[0]!.length).toBe(cust.columns.length + ord.columns.length);
    await demo.close();
  });

  test("only the suffix SQLite added is stripped from a duplicate column name", async () => {
    const demo = await openSession(parseConnection("demo"));
    const colWithColon = await demo.run('select 1 as a, 2 as a, 3 as "a:1"');
    expect(colWithColon.columns.map((c) => c.name)).toEqual(["a", "a", "a:1"]);
    expect(colWithColon.rows).toEqual([[1, 2, 3]]);
    await demo.close();
  });

  test("a foreign key without a target column points at the primary key", async () => {
    const tmp = await openSession(parseConnection(join(dir, "fk-implicit.db")), { create: true });
    await tmp.run("create table a (id integer primary key)");
    await tmp.run("create table b (a_id integer references a)");
    const s = await tmp.schema();
    const b = s.namespaces[0]!.relations.find((r) => r.name === "b")!;
    expect(b.columns[0]!.references).toEqual({ relation: "a", column: "id" });
    await tmp.close();
  });

  test("a composite foreign key without target columns points at the primary key column by column", async () => {
    const tmp = await openSession(parseConnection(join(dir, "fk-composite.db")), { create: true });
    await tmp.run("create table pk2 (k2 text, k1 text, primary key (k1, k2))");
    await tmp.run("create table ref2 (x text, y text, foreign key (x, y) references pk2)");
    const s = await tmp.schema();
    const ref2 = s.namespaces[0]!.relations.find((r) => r.name === "ref2")!;
    expect(ref2.columns.find((c) => c.name === "x")?.references).toEqual({
      relation: "pk2",
      column: "k1",
    });
    expect(ref2.columns.find((c) => c.name === "y")?.references).toEqual({
      relation: "pk2",
      column: "k2",
    });
    await tmp.close();
  });

  test("columns with integer-like names keep their order", async () => {
    const r = await driver.run("select 2, 1");
    expect(r.columns.map((c) => c.name)).toEqual(["2", "1"]);
    expect(r.rows).toEqual([[2, 1]]);
  });

  test("three columns with the same name are all kept", async () => {
    const demo = await openSession(parseConnection("demo"));
    const r = await demo.run(
      "select c.id, o.id, c.id from customers c join orders o on o.customer_id = c.id order by o.id limit 1",
    );
    expect(r.columns.map((c) => c.name)).toEqual(["id", "id", "id"]);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]!.length).toBe(3);
    await demo.close();
  });

  test("a read-only Run with duplicate column names changes nothing", async () => {
    const demo = await openSession(parseConnection("demo"));
    const rDemo = await demo.run("select 1 as a, 2 as a", { readOnly: true });
    expect(rDemo.columns.map((c) => c.name)).toEqual(["a", "a"]);
    expect(rDemo.rows).toEqual([[1, 2]]);
    expect((await demo.run("select count(*) from sqlite_temp_master")).rows).toEqual([[0]]);
    await expect(demo.run("create table zz (id integer)", { readOnly: true })).rejects.toThrow(QueryError);
    await demo.close();

    const rFile = await driver.run("select 1 as a, 2 as a", { readOnly: true });
    expect(rFile.columns.map((c) => c.name)).toEqual(["a", "a"]);
    expect(rFile.rows).toEqual([[1, 2]]);
    expect((await driver.run("select count(*) from sqlite_temp_master")).rows).toEqual([[0]]);
    await expect(driver.run("create table zz (id integer)", { readOnly: true })).rejects.toThrow(QueryError);
  });

  test("a non-query with duplicate returning names gets positional names", async () => {
    await driver.run("create table r (a integer)");
    const res = await driver.run("insert into r (a) values (1) returning a, a");
    expect(res.columns.map((c) => c.name)).toEqual(["column1", "column2"]);
    expect(res.rows).toEqual([[1, 1]]);
  });

  test("a read-only Run that meets a lock gives an actionable message", async () => {
    await driver.run("pragma cache_size = 1");
    await driver.run("begin");
    await driver.run(
      "with recursive c(x) as (select 1 union all select x + 1 from c where x < 2000) insert into teams select x + 100, randomblob(1024) from c",
    );
    await expect(driver.run("select count(*) from teams", { readOnly: true })).rejects.toThrow(
      "the database is locked by an open transaction; commit or roll back, then try again",
    );
    await driver.run("rollback");
  });

  test("a comment after the last semicolon does not break duplicate column names", async () => {
    const r1 = await driver.run("select 1 as a, 2 as a; -- done");
    expect(r1.columns.map((c) => c.name)).toEqual(["a", "a"]);
    expect(r1.rows).toEqual([[1, 2]]);

    const r2 = await driver.run('select 1 as a, 2 as a, 3 as "a:1"; /* x */');
    expect(r2.columns.map((c) => c.name)).toEqual(["a", "a", "a:1"]);
    expect(r2.rows).toEqual([[1, 2, 3]]);
  });
});




describe("a Statement with a NUL character (U+0000) is never run", () => {
  const NUL_MESSAGE = "the statement contains a NUL character (U+0000) and was not run";
  const NUL = "\u0000";
  const cases: [string, string][] = [
    ["a NUL before a where clause", `delete from orders${NUL} where id = 1`],
    ["a NUL before an or", `update orders set n = 0 where id = 1${NUL} or true`],
    ["a NUL at the start", `${NUL}delete from orders where id = 1`],
    ["a NUL at the end", `delete from orders where id = 1${NUL}`],
    ["a NUL inside a string literal", `update orders set note = 'a${NUL}b' where id = 1`],
    ["a NUL inside a comment", `delete from orders /* ${NUL} */ where id = 1`],
    ["a NUL after the terminating semicolon", `delete from orders where id = 1;${NUL}`],
  ];
  const reads: [string, string][] = [
    ["a NUL before a where clause", `select * from orders${NUL} where id = 1`],
    ["a NUL at the start", `${NUL}select count(*) from orders`],
    ["a NUL at the end", `select count(*) from orders${NUL}`],
    ["a NUL inside a string literal", `select 'a${NUL}b' from orders`],
    ["a NUL inside a comment", `select count(*) from orders -- ${NUL}`],
    ["a NUL after the terminating semicolon", `select count(*) from orders;${NUL}`],
  ];

  let before: Awaited<ReturnType<Driver["run"]>>["rows"];
  beforeEach(async () => {
    await driver.run("create table orders (id integer primary key, n integer, note text)");
    await driver.run("insert into orders values (1, 10, 'a'), (2, 20, 'b'), (3, 30, 'c'), (4, 40, 'd'), (5, 50, 'e')");
    before = (await driver.run("select id, n, note from orders order by id")).rows;
  });

  async function expectUnchanged(d: Driver = driver) {
    expect((await d.run("select count(*) from orders")).rows).toEqual([[5]]);
    expect((await d.run("select id, n, note from orders order by id")).rows).toEqual(before);
  }

  for (const [name, sql] of cases) {
    test(`${name} is refused and the table is unchanged`, async () => {
      const err = await driver.run(sql).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).message).toBe(NUL_MESSAGE);
      await expectUnchanged();
      // The Driver still works afterwards.
      const ok = await driver.run("update orders set n = n where id = 1");
      expect(ok.affected).toBe(1);
    }, 5000);

    test(`${name} is refused in a read-only Run`, async () => {
      const err = await driver.run(sql, { readOnly: true }).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).message).toBe(NUL_MESSAGE);
      await expectUnchanged();
      expect((await driver.run("select count(*) from orders", { readOnly: true })).rows).toEqual([[5]]);
    }, 5000);
  }

  for (const [name, sql] of reads) {
    test(`a read with ${name} is refused, also read-only`, async () => {
      for (const opts of [undefined, { readOnly: true }]) {
        const err = await driver.run(sql, opts).then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(QueryError);
        expect((err as QueryError).message).toBe(NUL_MESSAGE);
      }
      expect((await driver.run("select count(*) from orders", { readOnly: true })).rows).toEqual([[5]]);
    }, 5000);
  }

  test("an in-memory Driver refuses a NUL as well, also read-only", async () => {
    const mem = await openSession(parseConnection(":memory:"), { create: true });
    try {
      await mem.run("create table orders (id integer primary key, n integer, note text)");
      await mem.run("insert into orders values (1, 10, 'a'), (2, 20, 'b'), (3, 30, 'c'), (4, 40, 'd'), (5, 50, 'e')");
      for (const opts of [undefined, { readOnly: true }]) {
        await expect(mem.run(`delete from orders${NUL} where id = 1`, opts)).rejects.toThrow(NUL_MESSAGE);
        await expect(mem.run(`select * from orders${NUL} where id = 1`, opts)).rejects.toThrow(NUL_MESSAGE);
      }
      await expectUnchanged(mem);
    } finally {
      await mem.close();
    }
  }, 5000);

  test("a text without a NUL runs as before", async () => {
    const r = await driver.run("delete from orders where id = 1");
    expect(r.affected).toBe(1);
    expect((await driver.run("select count(*) from orders")).rows).toEqual([[4]]);
    expect((await driver.run("select note from orders where id = 2", { readOnly: true })).rows).toEqual([["b"]]);
  });
});
