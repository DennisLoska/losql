import { expect, test } from "bun:test";
import type { Exec, ExecResult } from "../exec";
import { detectProviders, listModels } from "./detect";
import { PROVIDERS } from "./providers";

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "", timedOut: false, aborted: false });
const failed: ExecResult = { code: 1, stdout: "", stderr: "boom", timedOut: false, aborted: false };

test("detectProviders reports what is installed", async () => {
  const which = (bin: string) => ({ claude: "/bin/claude", agy: "/opt/agy", opencode: "/bin/opencode" } as Record<string, string>)[bin] ?? null;
  const exec: Exec = async ({ cmd }) => {
    if (cmd[0] === "/bin/claude") return ok("2.1.322 (Claude Code)\n");
    if (cmd[0] === "/opt/agy") return ok("1.5.5\n");
    return failed;
  };
  const statuses = await detectProviders({ which, exec });
  expect(statuses.map((s) => [s.id, s.installed, s.path, s.version])).toEqual([
    ["claude", true, "/bin/claude", "2.1.322"],
    ["codex", false, null, null],
    ["opencode", true, "/bin/opencode", null],
    ["antigravity", true, "/opt/agy", "1.5.5"],
  ]);
  expect(statuses[1]!.installHint).toBe(PROVIDERS.codex.installHint);
  expect(statuses[0]!.label).toBe("Claude Code");
});

test("detectProviders survives a version check that throws", async () => {
  const statuses = await detectProviders({
    which: (bin) => (bin === "codex" ? "/bin/codex" : null),
    exec: async () => { throw new Error("spawn failed"); },
  });
  expect(statuses.find((s) => s.id === "codex")).toMatchObject({ installed: true, version: null });
});

test("listModels", async () => {
  const exec: Exec = async ({ cmd }) => {
    if (cmd.join(" ") === "/bin/opencode models") return ok("a/one\nb/two\n\n");
    if (cmd.join(" ") === "/opt/agy models") return ok("m-low\tM (Low)\nm-high\tM (High)\n");
    return failed;
  };
  expect(await listModels(PROVIDERS.claude, "/bin/claude", exec)).toEqual(["default", "fable", "opus", "sonnet", "haiku"]);
  expect(await listModels(PROVIDERS.codex, "/bin/codex", exec)).toEqual(["default"]);
  expect(await listModels(PROVIDERS.opencode, "/bin/opencode", exec)).toEqual(["default", "a/one", "b/two"]);
  expect(await listModels(PROVIDERS.antigravity, "/opt/agy", exec)).toEqual(["default", "m-low", "m-high"]);
  expect(await listModels(PROVIDERS.opencode, "/elsewhere/opencode", exec)).toEqual(["default"]);
});

test("the version call gets the reduced environment of a turn, without database credentials", async () => {
  const envs: (Record<string, string | undefined> | undefined)[] = [];
  await detectProviders({
    which: (bin) => (bin === "claude" ? "/bin/claude" : null),
    exec: async (req) => { envs.push(req.env); return ok("2.1.322\n"); },
    env: { PGPASSWORD: "secret", DATABASE_URL: "postgres://u:secret@h/db", PATH: "/usr/bin:/bin" },
  });
  expect(envs).toHaveLength(1);
  expect(envs[0]).toEqual({ PATH: "/usr/bin:/bin" });
});

test("the models call gets the reduced environment of a turn, without database credentials", async () => {
  const envs: (Record<string, string | undefined> | undefined)[] = [];
  const exec: Exec = async (req) => { envs.push(req.env); return ok("a/one\n"); };
  const env = { PGPASSWORD: "secret", DATABASE_URL: "postgres://u:secret@h/db", PATH: "/usr/bin:/bin" };
  expect(await listModels(PROVIDERS.opencode, "/bin/opencode", exec, env)).toEqual(["default", "a/one"]);
  expect(envs).toEqual([{ PATH: "/usr/bin:/bin" }]);
});

test("without an environment given, detection reduces the environment of losql", async () => {
  const saved = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://u:secret@h/db";
  try {
    const envs: (Record<string, string | undefined> | undefined)[] = [];
    const exec: Exec = async (req) => { envs.push(req.env); return ok("1.0.0\n"); };
    await detectProviders({ which: (bin) => (bin === "codex" ? "/bin/codex" : null), exec });
    await listModels(PROVIDERS.opencode, "/bin/opencode", exec);
    expect(envs).toHaveLength(2);
    for (const env of envs) {
      expect(env).toBeDefined();
      expect(env!.DATABASE_URL).toBeUndefined();
      expect(env!.PATH).toBe(process.env.PATH);
    }
  } finally {
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
  }
});

test("the version and models calls do not get the variables a saved Connection reads its password from", async () => {
  const connections = [{ name: "prod", url: "postgres://u:${DBPW}@db.example/app" }];
  const env = { DBPW: "s3cret", PATH: "/usr/bin:/bin", HOME: "/home/u" };
  const envs: (Record<string, string | undefined> | undefined)[] = [];
  const exec: Exec = async (req) => { envs.push(req.env); return ok("1.0.0\n"); };
  await detectProviders({ which: (bin) => (bin === "claude" ? "/bin/claude" : null), exec, env, connections });
  await listModels(PROVIDERS.opencode, "/bin/opencode", exec, env, connections);
  expect(envs).toEqual([{ PATH: "/usr/bin:/bin", HOME: "/home/u" }, { PATH: "/usr/bin:/bin", HOME: "/home/u" }]);
});
