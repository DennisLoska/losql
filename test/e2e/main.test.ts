import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installLoggingProviderClis, losql } from "./helpers";

test("--version prints the version", async () => {
  const r = await losql(["--version"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toMatch(/^losql \d+\.\d+\.\d+\n$/);
});

test("--help prints usage", async () => {
  const r = await losql(["--help"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("losql [connection]");
});

test("a usage error exits with 2", async () => {
  const r = await losql(["--bogus"]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("unknown option --bogus");
});

test("losql run by a test finds no Provider CLI of the machine and no DATABASE_URL of the developer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "losql-main-"));
  const log = join(dir, "started.log");
  const saved = { PATH: process.env.PATH, DATABASE_URL: process.env.DATABASE_URL };
  try {
    await installLoggingProviderClis(join(dir, "bin"), log);
    process.env.PATH = `${join(dir, "bin")}:${saved.PATH ?? ""}`;
    process.env.DATABASE_URL = "demo";
    const providers = await losql(["providers", "--json"]);
    expect(providers.code).toBe(0);
    expect(JSON.parse(providers.stdout).map((p: { id: string; installed: boolean }) => [p.id, p.installed])).toEqual([
      ["claude", false], ["codex", false], ["opencode", false], ["antigravity", false],
    ]);
    const exec = await losql(["exec", "select 1"]);
    expect(exec.code).toBe(2);
    expect(exec.stderr).toContain("no connection");
    expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe("");
  } finally {
    if (saved.PATH === undefined) delete process.env.PATH;
    else process.env.PATH = saved.PATH;
    if (saved.DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved.DATABASE_URL;
    await rm(dir, { recursive: true, force: true });
  }
});
