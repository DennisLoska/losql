import { describe, expect, test } from "bun:test";
import { parseArgs, USAGE } from "./args";

describe("parseArgs", () => {
  test("no arguments starts the TUI", () => {
    expect(parseArgs([])).toEqual({ kind: "tui" });
  });

  test("a positional argument is the connection", () => {
    expect(parseArgs(["./app.db"])).toEqual({ kind: "tui", connection: "./app.db" });
  });

  test("tui flags", () => {
    expect(parseArgs(["demo", "--theme", "nord", "--transparent", "--no-animations"])).toEqual({
      kind: "tui", connection: "demo", theme: "nord", transparent: true, animations: false,
    });
    expect(parseArgs(["--no-transparent"])).toEqual({ kind: "tui", transparent: false });
  });

  test("help and version", () => {
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseArgs(["-h"])).toEqual({ kind: "help" });
    expect(parseArgs(["--version"])).toEqual({ kind: "version" });
    expect(parseArgs(["-v"])).toEqual({ kind: "version" });
  });

  test("exec", () => {
    expect(parseArgs(["exec", "-c", "demo", "--format", "json", "--max-rows", "5", "--read-only", "select 1"])).toEqual({
      kind: "exec", connection: "demo", format: "json", maxRows: 5, readOnly: true, sql: "select 1",
    });
    expect(parseArgs(["exec", "select 1"])).toEqual({ kind: "exec", format: "table", readOnly: false, sql: "select 1" });
    expect(parseArgs(["exec", "-"])).toEqual({ kind: "exec", format: "table", readOnly: false, sql: "-" });
  });

  test("ask", () => {
    expect(parseArgs(["ask", "-c", "demo", "--provider", "claude", "--model", "haiku", "--run", "how many orders"])).toEqual({
      kind: "ask", connection: "demo", provider: "claude", model: "haiku", run: true, question: "how many orders",
    });
    expect(parseArgs(["ask", "top", "customers"])).toEqual({ kind: "ask", run: false, question: "top customers" });
  });

  test("providers", () => {
    expect(parseArgs(["providers"])).toEqual({ kind: "providers", json: false, test: false });
    expect(parseArgs(["providers", "--json", "--test"])).toEqual({ kind: "providers", json: true, test: true });
  });

  test("usage errors", () => {
    expect(parseArgs(["exec"])).toEqual({ kind: "error", message: "exec: missing SQL (pass a statement or - for stdin)" });
    expect(parseArgs(["exec", "--format", "xml", "select 1"])).toEqual({ kind: "error", message: "exec: --format must be table, json or csv" });
    expect(parseArgs(["exec", "--max-rows", "x", "select 1"])).toEqual({ kind: "error", message: "exec: --max-rows must be a positive integer" });
    expect(parseArgs(["ask"])).toEqual({ kind: "error", message: "ask: missing question" });
    expect(parseArgs(["--bogus"])).toEqual({ kind: "error", message: "unknown option --bogus" });
    expect(parseArgs(["a", "b"])).toEqual({ kind: "error", message: "unexpected argument b" });
  });

  test("usage text names every command", () => {
    for (const word of ["losql [connection]", "exec", "ask", "providers", "--help", "--version"]) {
      expect(USAGE).toContain(word);
    }
  });
});

describe("parseArgs edge cases", () => {
  test("SQL that starts with a comment is a statement, not an option", () => {
    expect(parseArgs(["exec", "-- top customers\nselect 1"])).toEqual({
      kind: "exec", format: "table", readOnly: false, sql: "-- top customers\nselect 1",
    });
  });

  test("-- ends option parsing", () => {
    expect(parseArgs(["exec", "--read-only", "--", "-1"])).toEqual({
      kind: "exec", format: "table", readOnly: true, sql: "-1",
    });
    expect(parseArgs(["ask", "--", "what", "does", "-v", "do"])).toEqual({
      kind: "ask", run: false, question: "what does -v do",
    });
    expect(parseArgs(["--", "-odd-name.db"])).toEqual({ kind: "tui", connection: "-odd-name.db" });
    expect(parseArgs(["providers", "--", "--json"])).toEqual({ kind: "error", message: "unexpected argument --json" });
  });

  test("an option that needs a value rejects a missing value or another option", () => {
    expect(parseArgs(["exec", "-c"])).toEqual({ kind: "error", message: "exec: -c needs a value" });
    expect(parseArgs(["exec", "-c", "--read-only", "select 1"])).toEqual({ kind: "error", message: "exec: -c needs a value" });
    expect(parseArgs(["exec", "--format"])).toEqual({ kind: "error", message: "exec: --format needs a value" });
    expect(parseArgs(["exec", "--max-rows"])).toEqual({ kind: "error", message: "exec: --max-rows needs a value" });
    expect(parseArgs(["ask", "--provider"])).toEqual({ kind: "error", message: "ask: --provider needs a value" });
    expect(parseArgs(["ask", "--model", "--run", "hi"])).toEqual({ kind: "error", message: "ask: --model needs a value" });
    expect(parseArgs(["--theme"])).toEqual({ kind: "error", message: "--theme needs a value" });
    expect(parseArgs(["--theme", "--transparent"])).toEqual({ kind: "error", message: "--theme needs a value" });
  });

  test("--max-rows rejects an integer outside the safe range", () => {
    expect(parseArgs(["exec", "--max-rows", "99999999999999999999", "select 1"])).toEqual({
      kind: "error", message: "exec: --max-rows must be a positive integer",
    });
  });

  test("the stdin marker cannot be combined with a statement", () => {
    expect(parseArgs(["exec", "-", "select 1"])).toEqual({
      kind: "error", message: "exec: - (stdin) cannot be combined with a statement",
    });
  });
});

