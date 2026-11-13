import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installLoggingProviderClis, isolatedEnv, ROOT } from "./helpers";

const BINARY = join(ROOT, "losql");
let elsewhere: string;

async function run(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn([BINARY, ...args], {
    cwd: elsewhere, // not the repository: the binary must not depend on bunfig.toml or node_modules
    // An empty directory as PATH (the binary needs nothing from it), so no Provider CLI of the machine
    // is found or started, and none of the developer's DATABASE_URL, PG* and LOSQL_* variables.
    env: isolatedEnv({
      PATH: join(elsewhere, "empty-bin"),
      LOSQL_CONFIG_DIR: join(elsewhere, "config"),
      LOSQL_STATE_DIR: join(elsewhere, "state"),
      ...env,
    }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

describe.skipIf(process.env.LOSQL_SKIP_BINARY_TEST === "1")("the compiled binary", () => {
  beforeAll(async () => {
    elsewhere = await mkdtemp(join(tmpdir(), "losql-binary-"));
    await mkdir(join(elsewhere, "empty-bin"));
    const build = Bun.spawn(["bun", "run", "build"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const code = await build.exited;
    if (code !== 0) throw new Error(`build failed:\n${await new Response(build.stderr).text()}`);
  }, 180_000);

  afterAll(async () => {
    if (elsewhere) await rm(elsewhere, { recursive: true, force: true });
  });

  test("exists after the build", () => {
    expect(existsSync(BINARY)).toBe(true);
  });

  test("--version", async () => {
    const r = await run(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^losql \d+\.\d+\.\d+\n$/);
    expect(r.stderr).toBe("");
  });

  test("exec against the demo database", async () => {
    const r = await run(["exec", "-c", "demo", "--format", "json", "select count(*) as n from orders"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([{ n: 12 }]);
  });

  test("exec against a SQLite file it creates data in", async () => {
    const file = join(elsewhere, "t.db");
    const { Database } = await import("bun:sqlite");
    new Database(file).close();
    const r = await run(["exec", "-c", file, "--format", "csv", "create table t (a); insert into t values (41), (1); select sum(a) as total from t"]);
    expect(r.stdout).toBe("total\n42\n");
  });

  test("providers lists the four Providers", async () => {
    const r = await run(["providers", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).map((p: { id: string }) => p.id)).toEqual(["claude", "codex", "opencode", "antigravity"]);
  });

  test("a Provider CLI on the PATH of the test process is not started; each Provider is listed as not installed", async () => {
    const log = join(elsewhere, "started.log");
    await installLoggingProviderClis(join(elsewhere, "logging-bin"), log);
    const saved = process.env.PATH;
    process.env.PATH = `${join(elsewhere, "logging-bin")}:${saved ?? ""}`;
    try {
      const r = await run(["providers", "--json"]);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout).map((p: { id: string; installed: boolean }) => [p.id, p.installed])).toEqual([
        ["claude", false], ["codex", false], ["opencode", false], ["antigravity", false],
      ]);
      expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe("");
    } finally {
      if (saved === undefined) delete process.env.PATH;
      else process.env.PATH = saved;
    }
  });

  test("built-in themes are inside the binary", async () => {
    // No headless command loads a Theme, so the binary itself is read: each built-in Theme's name
    // and a colour value that no other built-in Theme has must be in it.
    const dir = join(ROOT, "src/core/theme/builtin");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
    expect(files.length).toBeGreaterThan(0);
    const colours = new Map<string, Set<string>>();
    for (const file of files) {
      const text = await Bun.file(join(dir, file)).text();
      colours.set(file, new Set(text.match(/#[0-9A-Fa-f]{6}\b/g) ?? []));
    }
    const binary = Buffer.from(await Bun.file(BINARY).arrayBuffer());
    const missing: string[] = [];
    for (const file of files) {
      const name = file.slice(0, -".json".length);
      const others = [...colours].filter(([f]) => f !== file).flatMap(([, set]) => [...set].map((c) => c.toLowerCase()));
      const own = [...colours.get(file)!].find((c) => !others.includes(c.toLowerCase()));
      if (own === undefined) throw new Error(`${file} has no colour of its own to look for`);
      if (!binary.includes(name)) missing.push(`${name}: its name`);
      if (!binary.includes(own)) missing.push(`${name}: its colour ${own}`);
    }
    expect(missing).toEqual([]);
  });

  test.skipIf(!process.env.LOSQL_TEST_PG_URL)("exec against Postgres", async () => {
    const r = await run(["exec", "-c", process.env.LOSQL_TEST_PG_URL!, "--format", "csv", "select 40 + 2 as answer"]);
    expect(r.stdout).toBe("answer\n42\n");
  });
});
