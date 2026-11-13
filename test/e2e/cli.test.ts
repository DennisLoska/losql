import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { losql } from "./helpers";
import { installStubClaude, stubPath } from "./stub-provider";

let dir: string;
let env: Record<string, string>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "losql-cli-"));
  env = {
    LOSQL_CONFIG_DIR: join(dir, "config"),
    LOSQL_STATE_DIR: join(dir, "state"),
    PATH: stubPath(join(dir, "bin")),
    DATABASE_URL: "",
  };
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("exec", () => {
  test("prints a table by default", async () => {
    const r = await losql(["exec", "-c", "demo", "select count(*) as n from orders"], { env });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(" n  \n----\n 12 \n(1 row)\n");
    expect(r.stderr).toBe("");
  });

  test("json and csv formats", async () => {
    const json = await losql(["exec", "-c", "demo", "--format", "json", "select count(*) as n from orders"], { env });
    expect(JSON.parse(json.stdout)).toEqual([{ n: 12 }]);
    const csv = await losql(["exec", "-c", "demo", "--format", "csv", "select count(*) as n from orders"], { env });
    expect(csv.stdout).toBe("n\n12\n");
  });

  test("runs every statement and prints the last result", async () => {
    const r = await losql(["exec", "-c", "demo", "--format", "csv", "create table t (a); insert into t values (7); select a from t"], { env });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("a\n7\n");
  });

  test("reads SQL from stdin with -", async () => {
    const r = await losql(["exec", "-c", "demo", "--format", "csv", "-"], { env, stdin: "select 1 as x;\n" });
    expect(r.stdout).toBe("x\n1\n");
  });

  test("--max-rows caps the result", async () => {
    const r = await losql(["exec", "-c", "demo", "--format", "csv", "--max-rows", "3", "select id from orders order by id"], { env });
    expect(r.stdout).toBe("id\n1\n2\n3\n");
    expect(r.stderr).toContain("more rows available");
  });

  test("a query error exits with 1", async () => {
    const r = await losql(["exec", "-c", "demo", "select * from nope"], { env });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no such table: nope");
    expect(r.stdout).toBe("");
  });

  test("--read-only refuses a write", async () => {
    const r = await losql(["exec", "-c", "demo", "--read-only", "delete from orders"], { env });
    expect(r.code).toBe(1);
  });

  test("no connection is a usage error", async () => {
    const r = await losql(["exec", "select 1"], { env });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("no connection");
  });

  test("DATABASE_URL and saved connections are used", async () => {
    const fromEnv = await losql(["exec", "--format", "csv", "select 1 as x"], { env: { ...env, DATABASE_URL: "demo" } });
    expect(fromEnv.stdout).toBe("x\n1\n");
    await Bun.write(join(dir, "config", "config.json"), JSON.stringify({ connections: [{ name: "d", url: "demo" }] }));
    const saved = await losql(["exec", "-c", "d", "--format", "csv", "select 2 as x"], { env });
    expect(saved.stdout).toBe("x\n2\n");
  });
});

describe("providers", () => {
  test("lists all four with what was detected", async () => {
    await installStubClaude(join(dir, "bin"), join(dir, "stub"), ["{}"]);
    const r = await losql(["providers", "--json"], { env });
    expect(r.code).toBe(0);
    const list = JSON.parse(r.stdout);
    expect(list.map((p: { id: string }) => p.id)).toEqual(["claude", "codex", "opencode", "antigravity"]);
    expect(list[0]).toMatchObject({ id: "claude", installed: true, version: "9.9.9", path: join(dir, "bin", "claude") });
    expect(list[1]).toMatchObject({ id: "codex", installed: false, path: null });

    const text = await losql(["providers"], { env });
    expect(text.stdout).toContain("Claude Code");
    expect(text.stdout).toContain("9.9.9");
    expect(text.stdout).toContain("not found");
  });

  test("--test runs a round trip", async () => {
    await installStubClaude(join(dir, "bin"), join(dir, "stub"), ["ok"]);
    const r = await losql(["providers", "--test"], { env });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Claude Code.*replied in \d+(\.\d+)?s/);
  });
});

describe("ask", () => {
  const replies = [
    '{"action":"query","sql":"select count(*) as n from orders","why":"count"}',
    '{"action":"answer","message":"There are 12 orders.","sql":"select count(*) as orders from orders"}',
  ];

  test("prints the proposal on stdout and the message on stderr", async () => {
    await installStubClaude(join(dir, "bin"), join(dir, "stub"), replies);
    const r = await losql(["ask", "-c", "demo", "--provider", "claude", "how many orders are there"], { env });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("select count(*) as orders from orders\n");
    expect(r.stderr).toContain("There are 12 orders.");
    const firstPrompt = await Bun.file(join(dir, "stub", "prompt-0.txt")).text();
    expect(firstPrompt).toContain("how many orders are there");
    expect(firstPrompt).toContain("orders(id integer pk");
    const secondPrompt = await Bun.file(join(dir, "stub", "prompt-1.txt")).text();
    expect(secondPrompt).toContain('"rows":[[12]]');
    const args = JSON.parse(await Bun.file(join(dir, "stub", "args-0.json")).text());
    expect(args).toContain("--safe-mode");
  });

  test("--run executes the proposal read-only and prints its result", async () => {
    await installStubClaude(join(dir, "bin"), join(dir, "stub"), replies);
    const r = await losql(["ask", "-c", "demo", "--run", "how many orders"], { env });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("select count(*) as orders from orders\n");
    expect(r.stdout).toContain(" 12 ");
  });

  test("the first installed provider is used when none is configured", async () => {
    await installStubClaude(join(dir, "bin"), join(dir, "stub"), ['{"action":"answer","message":"hi"}']);
    const r = await losql(["ask", "-c", "demo", "hello"], { env });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("hi");
    expect(r.stdout).toBe("");
  });

  test("no provider installed is an error that says what to do", async () => {
    const r = await losql(["ask", "-c", "demo", "hello"], { env });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no provider is installed");
  });

  test("an unknown provider is a usage error", async () => {
    const r = await losql(["ask", "-c", "demo", "--provider", "copilot", "hello"], { env });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown provider copilot");
  });

  test("a chosen provider that is not installed exits with 1 and install hint", async () => {
    const r = await losql(["ask", "-c", "demo", "--provider", "codex", "hello"], { env });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Codex is not installed");
  });
});

describe("additional edge cases", () => {
  test("exec with empty or comment-only SQL is a usage error", async () => {
    const r = await losql(["exec", "-c", "demo", "-- only a comment"], { env });
    expect(r.code).toBe(2);
  });

  test("resolveConnection falls back to state.lastConnection and rethrows ConnectionError as UsageError", async () => {
    await Bun.write(join(dir, "state", "state.json"), JSON.stringify({ onboarded: true, lastConnection: "demo" }));
    const ok = await losql(["exec", "--format", "csv", "select 3 as x"], { env });
    expect(ok.code).toBe(0);
    expect(ok.stdout).toBe("x\n3\n");

    const bad = await losql(["exec", "-c", "mysql://localhost/db", "select 1"], { env });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("unsupported connection");
  });

  test("exec remembers the last result with columns when followed by a statement without columns", async () => {
    const r = await losql(
      ["exec", "-c", "demo", "--format", "csv", "create table t (a); select 9 as a; insert into t values (1)"],
      { env },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("a\n9\n");
  });

  test("single failing statement does not print statement index prefix while multi-statement failure does", async () => {
    const single = await losql(["exec", "-c", "demo", "select * from nope"], { env });
    expect(single.code).toBe(1);
    expect(single.stderr).not.toContain("statement 1 of 1 failed");

    const multi = await losql(["exec", "-c", "demo", "select 1; select * from nope"], { env });
    expect(multi.code).toBe(1);
    expect(multi.stderr).toContain("losql: statement 2 of 2 failed\n");
  });
});


