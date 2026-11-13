import { describe, expect, test } from "bun:test";
import { tokenize } from "./lexer";

const kinds = (sql: string) =>
  tokenize(sql).filter((t) => t.kind !== "whitespace").map((t) => [t.kind, sql.slice(t.start, t.end)]);

describe("tokenize", () => {
  test("a simple query", () => {
    expect(kinds("select count(*) from users u where u.name = 'O''Brien' -- hi")).toEqual([
      ["keyword", "select"], ["function", "count"], ["punctuation", "("], ["operator", "*"], ["punctuation", ")"],
      ["keyword", "from"], ["identifier", "users"], ["identifier", "u"], ["keyword", "where"],
      ["identifier", "u"], ["punctuation", "."], ["identifier", "name"], ["operator", "="],
      ["string", "'O''Brien'"], ["comment", "-- hi"],
    ]);
  });

  test("keywords are case-insensitive", () => {
    expect(kinds("SeLeCt 1 FROM t")).toEqual([
      ["keyword", "SeLeCt"], ["number", "1"], ["keyword", "FROM"], ["identifier", "t"],
    ]);
  });

  test("types and casts", () => {
    expect(kinds("create table t (id integer, at timestamptz, v jsonb); select a::int")).toEqual([
      ["keyword", "create"], ["keyword", "table"], ["identifier", "t"], ["punctuation", "("],
      ["identifier", "id"], ["type", "integer"], ["punctuation", ","],
      ["identifier", "at"], ["type", "timestamptz"], ["punctuation", ","],
      ["identifier", "v"], ["type", "jsonb"], ["punctuation", ")"], ["punctuation", ";"],
      ["keyword", "select"], ["identifier", "a"], ["operator", "::"], ["type", "int"],
    ]);
  });

  test("numbers", () => {
    expect(kinds("1 3.14 1e10 2.5E-3 0x1F .5")).toEqual([
      ["number", "1"], ["number", "3.14"], ["number", "1e10"], ["number", "2.5E-3"], ["number", "0x1F"], ["number", ".5"],
    ]);
  });

  test("quoted identifiers", () => {
    expect(kinds('select "My Col", `tick` from "a""b"')).toEqual([
      ["keyword", "select"], ["quotedIdentifier", '"My Col"'], ["punctuation", ","], ["quotedIdentifier", "`tick`"],
      ["keyword", "from"], ["quotedIdentifier", '"a""b"'],
    ]);
  });

  test("strings: escape prefix and dollar quoting", () => {
    expect(kinds("select E'a\\'b', $$x;y$$, $tag$ it's $tag$")).toEqual([
      ["keyword", "select"], ["string", "E'a\\'b'"], ["punctuation", ","],
      ["string", "$$x;y$$"], ["punctuation", ","], ["string", "$tag$ it's $tag$"],
    ]);
  });

  test("parameters", () => {
    expect(kinds("where a = $1 and b = ? and c = :name")).toEqual([
      ["keyword", "where"], ["identifier", "a"], ["operator", "="], ["parameter", "$1"], ["keyword", "and"],
      ["identifier", "b"], ["operator", "="], ["parameter", "?"], ["keyword", "and"],
      ["identifier", "c"], ["operator", "="], ["parameter", ":name"],
    ]);
  });

  test("comments, including nested block comments", () => {
    expect(kinds("/* a /* b */ c */ select 1 -- tail")).toEqual([
      ["comment", "/* a /* b */ c */"], ["keyword", "select"], ["number", "1"], ["comment", "-- tail"],
    ]);
  });

  test("multi-character operators", () => {
    expect(kinds("a <> b <= c >= d != e || f -> g ->> h")).toEqual([
      ["identifier", "a"], ["operator", "<>"], ["identifier", "b"], ["operator", "<="], ["identifier", "c"],
      ["operator", ">="], ["identifier", "d"], ["operator", "!="], ["identifier", "e"], ["operator", "||"],
      ["identifier", "f"], ["operator", "->"], ["identifier", "g"], ["operator", "->>"], ["identifier", "h"],
    ]);
  });

  test("a word followed by an opening parenthesis is a function unless it is a keyword", () => {
    expect(kinds("coalesce(a, b) in (1)")).toEqual([
      ["function", "coalesce"], ["punctuation", "("], ["identifier", "a"], ["punctuation", ","], ["identifier", "b"],
      ["punctuation", ")"], ["keyword", "in"], ["punctuation", "("], ["number", "1"], ["punctuation", ")"],
    ]);
  });

  test("unterminated constructs run to the end of the text", () => {
    expect(kinds("select 'abc")).toEqual([["keyword", "select"], ["string", "'abc"]]);
    expect(kinds("select /* abc")).toEqual([["keyword", "select"], ["comment", "/* abc"]]);
    expect(kinds('select "abc')).toEqual([["keyword", "select"], ["quotedIdentifier", '"abc']]);
    expect(kinds("select $$abc")).toEqual([["keyword", "select"], ["string", "$$abc"]]);
  });

  test("tokens cover the text exactly, for any input", () => {
    const samples = ["", "   ", "select 1;\n\n-- x\n", "éè = 'café' 😀", "@@#~^&|", "a.b.c(d)[1]::text"];
    for (const text of samples) {
      const tokens = tokenize(text);
      let at = 0;
      for (const t of tokens) {
        expect(t.start).toBe(at);
        expect(t.end).toBeGreaterThan(t.start);
        at = t.end;
      }
      expect(at).toBe(text.length);
    }
  });
});

describe("tokenize: names and keywords", () => {
  const kindOf = (sql: string, word: string) =>
    tokenize(sql).find((t) => sql.slice(t.start, t.end) === word)?.kind;

  test("a relation name before a column list is an identifier, not a function", () => {
    expect(kindOf("create table t(a int)", "t")).toBe("identifier");
    expect(kindOf("insert into t(a) values (1)", "t")).toBe("identifier");
    expect(kindOf("create view t(a) as select 1", "t")).toBe("identifier");
    expect(kindOf("create index t(a)", "t")).toBe("identifier");
    expect(kindOf("create table if not exists t(id int)", "t")).toBe("identifier");
    expect(kindOf("create view v (a) as select 1", "v")).toBe("identifier");
    expect(kindOf("create table c (p int references t(id))", "t")).toBe("identifier");
    expect(kindOf("create index i on t (a)", "t")).toBe("identifier");
    expect(kindOf("on t (a)", "t")).toBe("identifier");
  });

  test("a call is still a function", () => {
    expect(kindOf("on t(a)", "t")).toBe("function");
    expect(kindOf("select count(*)", "count")).toBe("function");
    expect(kindOf("select * from a join b on lower(a.x) = b.x", "lower")).toBe("function");
    expect(kindOf("select * from generate_series(1, 3)", "generate_series")).toBe("function");
  });

  test("common function and column names are not keywords", () => {
    for (const word of ["replace", "trim", "substring", "extract", "position", "nullif", "version", "first", "last"]) {
      expect(kindOf(`select ${word}(a) from t`, word)).toBe("function");
    }
    for (const word of ["value", "type", "level", "role", "owner", "action", "user", "row", "rows", "comment"]) {
      expect(kindOf(`select ${word} from t`, word)).toBe("identifier");
    }
  });
});

