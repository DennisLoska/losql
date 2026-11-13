import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { splitStatements, statementAt } from "./statements";

describe("splitStatements", () => {
  test("splits on semicolons and drops empty statements", () => {
    expect(splitStatements("select 1; select 2;;  ;select 3").map((s) => s.text)).toEqual(["select 1", "select 2", "select 3"]);
  });

  test("ranges point into the original text", () => {
    const text = "  select 1 ;\nselect 2";
    const [a, b] = splitStatements(text);
    expect(text.slice(a!.start, a!.end)).toBe("select 1");
    expect(text.slice(b!.start, b!.end)).toBe("select 2");
    expect(a).toEqual({ start: 2, end: 10, text: "select 1" });
  });

  test("semicolons inside strings, comments and dollar quotes do not split", () => {
    const text = "select ';' as a; -- no; split\nselect $$x;y$$ /* ; */ as b; select \";\" from t";
    expect(splitStatements(text).map((s) => s.text)).toEqual([
      "select ';' as a",
      "select $$x;y$$ /* ; */ as b",
      'select ";" from t',
    ]);
  });

  test("a statement starts at its first token that is not whitespace or a comment", () => {
    const text = "-- leading note\n  select 1;";
    expect(splitStatements(text)).toEqual([{ start: 18, end: 26, text: "select 1" }]);
  });

  test("text with only comments and whitespace has no statements", () => {
    expect(splitStatements("  -- nothing\n/* here */ ;")).toEqual([]);
    expect(splitStatements("")).toEqual([]);
  });

  test("keeps create trigger and begin atomic routine bodies whole", () => {
    const triggerSql = [
      "create trigger t_ai after insert on t begin",
      "  update t set n = n + 1 where id = new.id;",
      "  insert into log values (new.id);",
      "end",
    ].join("\n");
    expect(splitStatements(`${triggerSql};`).map((s) => s.text)).toEqual([triggerSql]);
    expect(splitStatements(`${triggerSql}; select 1;`).map((s) => s.text)).toEqual([
      triggerSql,
      "select 1",
    ]);

    const fnSql = "create function f(a int) returns int language sql begin atomic select a + 1; end";
    expect(splitStatements(`${fnSql};`).map((s) => s.text)).toEqual([fnSql]);

    const procSql =
      "create procedure p() language sql begin atomic insert into t values (1); insert into t values (2); end";
    expect(splitStatements(`${procSql};`).map((s) => s.text)).toEqual([procSql]);

    const orReplaceFn =
      "create or replace function f2() returns void language sql begin /* c */ atomic delete from t; end";
    expect(splitStatements(`${orReplaceFn}; select 2`).map((s) => s.text)).toEqual([
      orReplaceFn,
      "select 2",
    ]);
  });

  test("trigger body with case ... end and nested case ... end stays whole", () => {
    const withCase = [
      "create trigger tr_case after update on t begin",
      "  update t set flag = case when new.a > 0 then 1 else 0 end where id = new.id;",
      "  insert into log values (new.id);",
      "end",
    ].join("\n");
    expect(splitStatements(`${withCase}; select 1`).map((s) => s.text)).toEqual([
      withCase,
      "select 1",
    ]);

    const withNestedCase = [
      "create trigger tr_nested after update on t begin",
      "  update t set flag = case when new.a > 0 then case when new.b > 0 then 2 else 1 end else 0 end;",
      "  delete from log where id = old.id;",
      "end",
    ].join("\n");
    expect(splitStatements(`${withNestedCase};`).map((s) => s.text)).toEqual([withNestedCase]);
  });

  test("create temp trigger, upper-case CREATE TRIGGER, when (...) and for each row", () => {
    const tempTrigger =
      "create temp trigger tr_temp before delete on t for each row when (old.n > 0) begin insert into archive values (old.id); delete from aux where id = old.id; end";
    expect(splitStatements(`${tempTrigger};`).map((s) => s.text)).toEqual([tempTrigger]);

    const temporaryTrigger =
      "CREATE TEMPORARY TRIGGER TR_UPPER AFTER INSERT ON t FOR EACH ROW WHEN (new.x IS NOT NULL) BEGIN UPDATE t SET c = 1; INSERT INTO log VALUES (1); END";
    expect(splitStatements(`${temporaryTrigger}; SELECT 99`).map((s) => s.text)).toEqual([
      temporaryTrigger,
      "SELECT 99",
    ]);
  });

  test("begin or end inside a string, quoted identifier or comment inside a body does not change depth", () => {
    const sql = [
      "create trigger tr_ignore after insert on t begin",
      "  insert into log(msg, \"end\") values ('end; begin; case', 'end'); -- end; case",
      "  /* end; case; begin */",
      "  update t set a = 1;",
      "end",
    ].join("\n");
    expect(splitStatements(`${sql}; select 1`).map((s) => s.text)).toEqual([sql, "select 1"]);
  });

  test("transaction begin, plain case, table named begin_log, and dollar-quoted function without begin atomic split normally", () => {
    expect(splitStatements("begin; update t set a = 1; commit;").map((s) => s.text)).toEqual([
      "begin",
      "update t set a = 1",
      "commit",
    ]);
    expect(
      splitStatements("begin transaction; update t set a = 1; end;").map((s) => s.text),
    ).toEqual(["begin transaction", "update t set a = 1", "end"]);
    expect(
      splitStatements("select case when a then 1 else 2 end; select 2").map((s) => s.text),
    ).toEqual(["select case when a then 1 else 2 end", "select 2"]);
    expect(
      splitStatements("create table begin_log(a int); select 1").map((s) => s.text),
    ).toEqual(["create table begin_log(a int)", "select 1"]);
    expect(
      splitStatements(
        "create function g() returns int as $$ begin return 1; end $$ language plpgsql; select 1",
      ).map((s) => s.text),
    ).toEqual([
      "create function g() returns int as $$ begin return 1; end $$ language plpgsql",
      "select 1",
    ]);
  });

  test("an unterminated trigger body is one statement up to the end of the text", () => {
    const unterminated =
      "create trigger tr_unterm after insert on t begin update t set a = 1; insert into log values (1);";
    const stmts = splitStatements(unterminated);
    expect(stmts).toEqual([{ start: 0, end: unterminated.length, text: unterminated }]);
  });

  test("random compound inputs never throw and every statement slice matches its range", () => {
    const pieces = [
      "create",
      "or",
      "replace",
      "temp",
      "temporary",
      "trigger",
      "function",
      "procedure",
      "begin",
      "atomic",
      "case",
      "when",
      "then",
      "else",
      "end",
      "select",
      "insert",
      "update",
      "(a)",
      ";",
      "'end;'",
      '"end"',
      "-- end\n",
      "/* case end */",
      "$$begin;end$$",
      " ",
      "\n",
    ];
    let seed = 0x12345678;
    const nextInt = (max: number) => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % max;
    };
    for (let run = 0; run < 2000; run++) {
      const len = nextInt(25);
      let s = "";
      for (let j = 0; j < len; j++) {
        s += pieces[nextInt(pieces.length)]! + (nextInt(2) ? " " : "");
      }
      const stmts = splitStatements(s);
      let prevEnd = 0;
      for (const st of stmts) {
        expect(st.start).toBeGreaterThanOrEqual(prevEnd);
        expect(st.end).toBeGreaterThan(st.start);
        expect(st.text).toBe(s.slice(st.start, st.end));
        prevEnd = st.end;
      }
    }
  });
});

describe("statementAt", () => {
  const text = "select 1;\n\nselect 2;\n  ";
  //            0123456789 0 1234567890

  test("inside a statement", () => {
    expect(statementAt(text, 3)?.text).toBe("select 1");
    expect(statementAt(text, 14)?.text).toBe("select 2");
  });

  test("on the terminating semicolon belongs to the statement before it", () => {
    expect(statementAt(text, 8)?.text).toBe("select 1");
  });

  test("in the gap between statements returns the preceding one", () => {
    expect(statementAt(text, 10)?.text).toBe("select 1");
  });

  test("after the last statement returns the last one", () => {
    expect(statementAt(text, text.length)?.text).toBe("select 2");
  });

  test("before the first statement returns the first one", () => {
    expect(statementAt("   select 1; select 2", 0)?.text).toBe("select 1");
  });

  test("no statements", () => {
    expect(statementAt("  -- only a comment", 3)).toBeNull();
  });
});

describe("end as a name inside a trigger body", () => {
  const texts = (sql: string) => splitStatements(sql).map((s) => s.text);

  test("a column named end after set does not end the body", () => {
    const trigger = "create trigger t after insert on e begin update e set end = 1; delete from log; end";
    expect(texts(`${trigger}; delete from y`)).toEqual([trigger, "delete from y"]);
  });

  test("new.end and old.end in a when clause and in the body", () => {
    const trigger = [
      "create trigger t2 after update on e when new.end > old.end begin",
      "  update e set start = new.end where id = old.end;",
      "  insert into log values (new.end, old.end);",
      "  delete from log where e.end = 1;",
      "end",
    ].join("\n");
    expect(texts(`${trigger}; delete from y`)).toEqual([trigger, "delete from y"]);
  });

  test("end after a comma or before a closing parenthesis, and [end]", () => {
    const set = "create trigger t3 after insert on e begin update e set start = 1, end = 2; delete from log; end";
    expect(texts(`${set}; delete from y`)).toEqual([set, "delete from y"]);
    const insert = "create trigger t4 after insert on e begin insert into e (start, end) values (1, 2); delete from log; end";
    expect(texts(`${insert}; delete from y`)).toEqual([insert, "delete from y"]);
    const bracket = "create trigger t5 after insert on e begin update e set [end] = 1; select [end] from e; select [my end] from e; end";
    expect(texts(`${bracket}; delete from y`)).toEqual([bracket, "delete from y"]);
  });

  test("end as a name next to a real case ... end", () => {
    const trigger = [
      "create trigger t6 after insert on e begin",
      "  update e set end = case when new.end > 0 then end else 0 end, start = case when end = 1 then 2 end;",
      "  insert into e (end) values (case when new.a then 1 else coalesce(end, 0) end);",
      "  delete from log where case when a then 1 else 0 end = 1;",
      "end",
    ].join("\n");
    expect(texts(`${trigger}; delete from y`)).toEqual([trigger, "delete from y"]);
  });

  test("property: generated triggers that use end as a column next to case ... end are one Statement", () => {
    let seed = 0x5eed2026;
    const nextInt = (max: number) => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % max;
    };
    const pick = <T>(xs: readonly T[]): T => xs[nextInt(xs.length)]!;
    const names = ["end", "new.end", "old.end", "e.end", "[end]", "x"] as const;
    const expr = (depth: number): string => {
      const choice = nextInt(depth > 2 ? 3 : 6);
      switch (choice) {
        case 0:
          return String(nextInt(9));
        case 1:
        case 2:
          return pick(names);
        case 3:
          return `case when ${pick(names)} = ${expr(depth + 1)} then ${expr(depth + 1)} else ${expr(depth + 1)} end`;
        case 4:
          return `coalesce(${expr(depth + 1)}, ${expr(depth + 1)})`;
        default:
          return `(${expr(depth + 1)})`;
      }
    };
    const statement = (): string => {
      switch (nextInt(5)) {
        case 0:
          return `update e set end = ${expr(0)}`;
        case 1:
          return `update e set start = ${expr(0)}, end = ${expr(0)} where ${pick(names)} = ${expr(0)}`;
        case 2:
          return `insert into e (start, end) values (${expr(0)}, ${expr(0)})`;
        case 3:
          return `delete from log where ${expr(0)} = ${pick(names)}`;
        default:
          return `select ${expr(0)}, ${pick(names)} from e`;
      }
    };
    for (let run = 0; run < 500; run++) {
      const body = Array.from({ length: 1 + nextInt(4) }, statement).join("; ");
      const trigger = `create trigger g${run} after insert on e begin ${body}; end`;
      expect(texts(`${trigger}; delete from y`)).toEqual([trigger, "delete from y"]);
    }
  });
});

describe("a Postgres trigger has no body", () => {
  const texts = (sql: string) => splitStatements(sql).map((s) => s.text);

  test("execute function: begin as a table name does not start a body", () => {
    expect(
      texts("create trigger tg after insert on begin for each row execute function tf(); delete from y; insert into y values (1)"),
    ).toEqual([
      "create trigger tg after insert on begin for each row execute function tf()",
      "delete from y",
      "insert into y values (1)",
    ]);
  });

  test("execute procedure: begin as a column name does not start a body", () => {
    expect(texts("create trigger tg3 after update of begin on t for each row execute procedure tf(); select 1")).toEqual([
      "create trigger tg3 after update of begin on t for each row execute procedure tf()",
      "select 1",
    ]);
  });

  test("a trigger function named begin does not start a body", () => {
    expect(texts("create trigger tg4 after insert on t for each row execute function begin(); delete from y")).toEqual([
      "create trigger tg4 after insert on t for each row execute function begin()",
      "delete from y",
    ]);
  });

  test("a SQLite trigger whose body uses a column named execute keeps its body", () => {
    const trigger = "create trigger t7 after insert on e begin update e set execute = 1; delete from log; end";
    expect(texts(`${trigger}; delete from y`)).toEqual([trigger, "delete from y"]);
  });
});

describe("end as a name after as, by, having, limit, offset, between, and, or, not, on, returning and a unary operator", () => {
  const texts = (sql: string) => splitStatements(sql).map((s) => s.text);
  // [the word before end, a Statement of the body that uses end as a name there]
  const bodies: [string, string][] = [
    ["as", "select start as end from e"],
    ["by (order by)", "select start from e order by end"],
    ["by (group by) and having", "select start from e group by end having end > 1"],
    ["limit", "select start from e limit end"],
    ["offset", "select start from e limit 1 offset end"],
    ["between", "select start from e where start between end and start"],
    ["and", "select start from e where start > 1 and end > 1"],
    ["or", "select start from e where start > 1 or end > 1"],
    ["not", "select start from e where not end"],
    ["on", "select e.start from e join e as f on end = 1"],
    ["unary ~", "update e set a = ~end"],
    ["unary -", "update e set a = -end"],
    ["unary +", "update e set a = +end"],
    ["unary - after and", "select start from e where a = 1 and - end > 0"],
  ];

  test.each(bodies)("after %s: the trigger and the Statement after it are two Statements, and SQLite prepares the trigger", (_, body) => {
    const trigger = `create trigger t after insert on e begin ${body}; delete from log; end`;
    expect(texts(`${trigger}; delete from y`)).toEqual([trigger, "delete from y"]);
    const db = new Database(":memory:");
    try {
      db.run('create table e (id, start, "end", a)');
      db.run("create table log (x)");
      db.prepare(trigger).run();
      expect(db.query("select count(*) as n from sqlite_master where type = 'trigger'").get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });

  test("after returning (SQLite does not take returning inside a trigger; the split is the same)", () => {
    const trigger = "create trigger t after insert on e begin insert into e (a) values (1) returning end; delete from log; end";
    expect(texts(`${trigger}; delete from y`)).toEqual([trigger, "delete from y"]);
  });

  test("a real case ... end before as, and, or, between and limit still closes the case", () => {
    const trigger = [
      "create trigger t8 after insert on e begin",
      "  select case when a then 1 end as x, start from e where case when a then 1 end between 0 and 2",
      "    and case when a then 1 end > 0 or case when a then 1 end < 0 order by case when a then 1 end limit 1;",
      "end",
    ].join("\n");
    expect(texts(`${trigger}; delete from y`)).toEqual([trigger, "delete from y"]);
  });
});

describe("the header of a trigger is scanned once", () => {
  test("a header with 100,000 execute words is split in under half a second", () => {
    const text = `create trigger t after insert on e ${"execute ".repeat(100_000)}`;
    const t0 = performance.now();
    const statements = splitStatements(text);
    const elapsed = performance.now() - t0;
    expect(statements).toHaveLength(1);
    expect(elapsed).toBeLessThan(500);
  });

  test("execute function after many execute words still makes it a trigger without a body", () => {
    const text = `create trigger tg after insert on begin ${"execute ".repeat(1_000)}for each row execute function tf(); delete from y`;
    expect(splitStatements(text).map((s) => s.text)).toEqual([
      `create trigger tg after insert on begin ${"execute ".repeat(1_000)}for each row execute function tf()`,
      "delete from y",
    ]);
  });
});

describe("end as a name after every word and operator that needs an operand", () => {
  const texts = (sql: string) => splitStatements(sql).map((s) => s.text);
  // [the word or operator before end, a body that uses end as a name there]
  const bodies: [string, string][] = [
    ["is", "select a from e where a is end;"],
    ["like", "select a from e where a like end;"],
    ["glob", "select a from e where a glob end;"],
    ["regexp", "select a from e where a regexp end;"],
    ["match", "select a from e where a match end;"],
    ["->>", "select a ->> end from e;"],
    ["->", "select a -> end from e;"],
    ["distinct (select distinct)", "select distinct end from e;"],
    ["from", "select a from end;"],
    ["update", "update end set a = 1;"],
    ["join", "select e.a from e join end on 1;"],
    ["escape", "select a from e where a like 'x' escape end;"],
    ["from (is distinct from)", "select a from e where a is distinct from end;"],
    ["like (not like)", "select a from e where a not like end;"],
    ["all", "select all end from e;"],
    ["into", "insert into end (a) values (1);"],
    ["in", "select a from e where a in end;"],
    ["||", "select a || end from e;"],
  ];

  test.each(bodies)("after %s: the trigger and the Statement after it are two Statements, and SQLite prepares the trigger", (_, body) => {
    const trigger = `create trigger t1 after insert on e begin ${body} end`;
    expect(texts(`${trigger}; select 99`)).toEqual([trigger, "select 99"]);
    const db = new Database(":memory:");
    try {
      db.run('create table e (id, start, "end", a)');
      db.run('create table "end" (a, x)');
      db.prepare(trigger).run();
      expect(db.query("select count(*) as n from sqlite_master where type = 'trigger'").get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });
});

describe("a word that can be a name, standing where a value is expected, is a name", () => {
  const texts = (sql: string) => splitStatements(sql).map((s) => s.text);
  // The words of the table of words after which a value is expected that SQLite also accepts as names.
  const words = ["like", "glob", "regexp", "match", "offset", "by"] as const;
  const variants = (w: string): [string, string][] => [
    ["then", `select case when a then ${w} end from e;`],
    ["else", `select case when a then 1 else ${w} end from e;`],
    ["when", `select case b when 1 then 2 when ${w} then 3 end from e;`],
    ["an operator", `select case when a then b + ${w} end from e;`],
    ["not", `select case when a then not ${w} end from e;`],
    ["a unary minus", `select case when a then - ${w} end from e;`],
    ["a dot", `select case when a then new.${w} end from e;`],
    ["select", `select ${w} from e; select case when a then ${w} end from e;`],
  ];
  const cases: [string, string, string][] = words.flatMap((w) => variants(w).map(([after, body]): [string, string, string] => [w, after, body]));

  const prepares = (trigger: string, w: string) => {
    const db = new Database(":memory:");
    try {
      db.run(`create table e (a, b, "${w}")`);
      db.prepare(trigger).run();
      return db.query("select count(*) as n from sqlite_master where type = 'trigger'").get();
    } finally {
      db.close();
    }
  };

  test.each(cases)("a column named %s after %s: the trigger and the Statement after it are two Statements, as SQLite prepares them", (w, _, body) => {
    const trigger = `create trigger t after insert on e begin ${body} end`;
    expect(prepares(trigger, w)).toEqual({ n: 1 });
    expect(texts(`${trigger}; select 99`)).toEqual([trigger, "select 99"]);
  });

  test("the reproduction of the review: a column named match after then", () => {
    const trigger = "create trigger t after insert on e begin select case when a then match end from e; end";
    expect(prepares(trigger, "match")).toEqual({ n: 1 });
    expect(texts(`${trigger}; select 99`)).toEqual([trigger, "select 99"]);
  });

  test("the words still take a value after them where they are operators: a like end, limit 1 offset end, order by end", () => {
    const bodies = [
      "select a from e where a like end;",
      "select a from e where a not like end;",
      "select a from e where (a) glob end;",
      "select a from e limit 1 offset end;",
      "select a from e order by end;",
      "select a from e group by end;",
    ];
    for (const body of bodies) {
      const trigger = `create trigger t1 after insert on e begin ${body} end`;
      expect(texts(`${trigger}; select 99`)).toEqual([trigger, "select 99"]);
    }
  });

  test("property: over 5,000 seeded random trigger bodies that SQLite accepts, the pieces are what SQLite takes", () => {
    const db = new Database(":memory:");
    try {
      db.run('create table e (a, b, "end", "like", "glob", "regexp", "match", "offset", "by")');
      const { bodies, differing } = compareGeneratedTriggers(db, 5_000, (sql) => texts(sql).length);
      expect(bodies).toBe(5_000);
      expect(differing).toEqual([]);
    } finally {
      db.close();
    }
  });
});

/**
 * Generates trigger bodies from a small grammar that uses `like`, `glob`,
 * `regexp`, `match`, `offset` and `by` both as operators and as column names
 * next to `case … end`; keeps the first `count` that SQLite accepts and returns
 * those whose number of pieces (followed by `select 99`) is not 2.
 */
function compareGeneratedTriggers(
  db: Database,
  count: number,
  pieces: (sql: string) => number,
): { bodies: number; differing: string[] } {
  let seed = 0x0dd5eed5;
  const nextInt = (max: number) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed >>> 8) % max;
  };
  const pick = <T>(xs: readonly T[]): T => xs[nextInt(xs.length)]!;
  const words = ["like", "glob", "regexp", "match", "offset", "by"] as const;
  const names = [...words, ...words, "a", "b", "end", "new.match", "new.like", "old.by", "e.offset"] as const;
  const operators = ["like", "glob", "match", "regexp", "not like", "not glob", "=", "+", "||", "and", "or", "is", "is not"] as const;
  const expr = (depth: number): string => {
    switch (nextInt(depth > 2 ? 3 : 9)) {
      case 0:
        return String(nextInt(9));
      case 1:
      case 2:
        return pick(names);
      case 3:
        return `${expr(depth + 1)} ${pick(operators)} ${expr(depth + 1)}`;
      case 4:
        return `case when ${expr(depth + 1)} then ${expr(depth + 1)}${nextInt(2) ? ` else ${expr(depth + 1)}` : ""} end`;
      case 5:
        return `case ${expr(depth + 1)} when ${expr(depth + 1)} then ${expr(depth + 1)} end`;
      case 6:
        return `${expr(depth + 1)} like ${expr(depth + 1)} escape ${expr(depth + 1)}`;
      case 7:
        return `${pick(["like", "glob", "coalesce"])}(${expr(depth + 1)}, ${expr(depth + 1)})`;
      default:
        return `(${expr(depth + 1)})`;
    }
  };
  const statement = (): string => {
    switch (nextInt(6)) {
      case 0:
        return `select ${expr(0)}, ${expr(0)} from e where ${expr(0)}`;
      case 1:
        return `select ${expr(0)} from e order by ${expr(0)} limit ${expr(0)} offset ${expr(0)}`;
      case 2:
        return `select ${expr(0)} from e group by ${expr(0)}, ${expr(0)}`;
      case 3:
        return `update e set ${pick(words)} = ${expr(0)} where ${expr(0)}`;
      case 4:
        return `insert into e (${pick(words)}, a) values (${expr(0)}, ${expr(0)})`;
      default:
        return `delete from e where ${expr(0)}`;
    }
  };
  const differing: string[] = [];
  let bodies = 0;
  for (let run = 0; bodies < count && run < count * 20; run++) {
    const body = Array.from({ length: 1 + nextInt(3) }, statement).join("; ");
    const trigger = `create trigger g after insert on e begin ${body}; end`;
    try {
      db.prepare(trigger).run();
    } catch {
      continue;
    }
    db.run("drop trigger g");
    bodies++;
    if (pieces(`${trigger}; select 99`) !== 2) differing.push(body);
  }
  return { bodies, differing };
}
