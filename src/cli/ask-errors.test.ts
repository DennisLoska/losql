import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, ExecResult } from "../core/exec";
import { type CliDeps, runAsk } from "./commands";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "losql-ask-errors-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const base: ExecResult = { code: 0, stdout: "", stderr: "", timedOut: false, aborted: false };

/** A stand-in for the Claude Code CLI whose every Turn ends as `turn` says. */
function stubClaude(turn: Exec): Exec {
  return async (request) => {
    if (request.cmd.includes("--version")) return { ...base, stdout: "9.9.9\n" };
    return turn(request);
  };
}

function failsWith(text: string): Exec {
  return async (request) => {
    request.onStdoutLine?.(JSON.stringify({ type: "result", subtype: "error", is_error: true, result: text }));
    return { ...base, code: 1 };
  };
}

function answers(text: string): Exec {
  return async (request) => {
    request.onStdoutLine?.(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text }));
    return base;
  };
}

async function ask(exec: Exec): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const deps: CliDeps = {
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    stdin: async () => "",
    env: { LOSQL_CONFIG_DIR: join(dir, "config"), LOSQL_STATE_DIR: join(dir, "state") },
    home: dir,
    cwd: dir,
    exec: stubClaude(exec),
    which: (bin) => (bin === "claude" ? "/stub/bin/claude" : null),
  };
  const code = await runAsk({ kind: "ask", connection: "demo", provider: "claude", run: false, question: "q" }, deps);
  return { code, stdout, stderr };
}

describe("ask: a Provider error is reported with its message and, on a second line, what to do", () => {
  const cases: [string, Exec, string][] = [
    [
      "not logged in",
      failsWith("Invalid API key · Please run /login"),
      "losql: Invalid API key · Please run /login\nRun `claude` once in a terminal to log in, then try again.\n",
    ],
    [
      "out of quota",
      failsWith("Claude AI usage limit reached|1794800000"),
      "losql: Claude AI usage limit reached|1794800000\nClaude Code has reached its usage limit. Try again later or switch provider with space p.\n",
    ],
    [
      "timed out",
      async () => ({ ...base, code: null, timedOut: true }),
      "losql: Claude Code did not answer in time\nClaude Code did not answer in time. Try again, or pick a faster model with space m.\n",
    ],
    [
      "not installed (it cannot be started)",
      async () => {
        throw Object.assign(new Error("spawn failed"), { code: "ENOENT" });
      },
      "losql: Claude Code could not be started: not found\nInstall Claude Code: https://claude.com/claude-code\n",
    ],
    [
      "an unusable reply",
      answers('{"action":"dance"}'),
      'losql: the agent sent an invalid reply twice: unknown action "dance"\nThe reply could not be understood. Try again, or pick another model with space m.\n',
    ],
  ];

  test.each(cases)("%s", async (_, exec, expected) => {
    const r = await ask(exec);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(expected);
  });

  test("an error of no known kind has no hint", async () => {
    const r = await ask(failsWith("something else went wrong"));
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("losql: something else went wrong\n");
  });

  test("control characters in the message are escaped, and the hint follows", async () => {
    const r = await ask(failsWith("Invalid API key \u001b[31m· Please run /login\u0007"));
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(
      "losql: Invalid API key \\x1b[31m· Please run /login\\x07\nRun `claude` once in a terminal to log in, then try again.\n",
    );
  });
});
