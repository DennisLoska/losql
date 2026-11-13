import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bunExec, type Exec, type ExecRequest, type ExecResult } from "../exec";
import { PROVIDERS } from "./providers";
import { classifyProviderError, connectionEnvNames, MAX_PROVIDER_OUTPUT_BYTES, ProviderError, runProvider, sanitizeEnv } from "./run";

const FIXTURES = join(import.meta.dir, "..", "..", "..", "test", "fixtures", "providers");
const REPLY = '{"action":"answer","message":"ok"}';

/** An Exec that replays a fixture file line by line. */
function replay(file: string, result: Partial<ExecResult> = {}): { exec: Exec; requests: ExecRequest[]; cwdExisted: boolean[] } {
  const requests: ExecRequest[] = [];
  const cwdExisted: boolean[] = [];
  const exec: Exec = async (request) => {
    requests.push(request);
    cwdExisted.push(request.cwd !== undefined && existsSync(request.cwd));
    const text = await Bun.file(join(FIXTURES, file)).text();
    for (const line of text.split("\n")) if (line) request.onStdoutLine?.(line);
    return { code: 0, stdout: text, stderr: "", timedOut: false, aborted: false, ...result };
  };
  return { exec, requests, cwdExisted };
}

describe("runProvider", () => {
  test.each([
    ["claude", "claude.success.ndjson"],
    ["codex", "codex.success.ndjson"],
    ["opencode", "opencode.success.ndjson"],
    ["antigravity", "antigravity.success.ndjson"],
  ] as const)("%s returns the reply text", async (id, file) => {
    const { exec } = replay(file);
    expect(await runProvider(PROVIDERS[id], { prompt: "P", system: "S" }, { exec, binPath: `/bin/${id}` })).toBe(REPLY);
  });

  test("the process runs in a fresh empty directory that is removed afterwards", async () => {
    const { exec, requests, cwdExisted } = replay("claude.success.ndjson");
    await runProvider(PROVIDERS.claude, { prompt: "P", system: "S", model: "haiku" }, { exec, binPath: "/bin/claude", timeoutMs: 5000 });
    const request = requests[0]!;
    expect(request.cmd[0]).toBe("/bin/claude");
    expect(request.cmd.slice(1)).toEqual(PROVIDERS.claude.command({ prompt: "P", system: "S", model: "haiku" }).args);
    expect(request.stdin).toBe("P");
    expect(request.timeoutMs).toBe(5000);
    expect(cwdExisted).toEqual([true]);
    expect(existsSync(request.cwd!)).toBe(false);
    expect(request.cwd).not.toBe(process.cwd());
  });

  test("text is streamed to onText", async () => {
    const { exec } = replay("antigravity.success.ndjson");
    const seen: string[] = [];
    await runProvider(PROVIDERS.antigravity, { prompt: "P", system: "S" }, { exec, binPath: "/bin/agy", onText: (t) => seen.push(t) });
    expect(seen.join("").trim()).toBe(REPLY);
  });

  test.each([
    ["claude", "claude.error.ndjson", "other", "issue with the selected model"],
    ["codex", "codex.error.ndjson", "quota", "usage limit"],
    ["opencode", "opencode.error.ndjson", "other", "Model unavailable"],
    ["antigravity", "antigravity.error.ndjson", "other", "invalid model selection"],
  ] as const)("%s error output becomes a ProviderError", async (id, file, kind, fragment) => {
    const { exec } = replay(file, { code: 1 });
    const error = await runProvider(PROVIDERS[id], { prompt: "P", system: "S" }, { exec, binPath: `/bin/${id}` }).then(() => null, (e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.kind).toBe(kind);
    expect(error.message).toContain(fragment);
  });

  test("a timeout, an abort, a silent failure and a missing binary are classified", async () => {
    const silent = (result: Partial<ExecResult>): Exec => async () => ({ code: 1, stdout: "", stderr: "", timedOut: false, aborted: false, ...result });
    const kindOf = (exec: Exec) =>
      runProvider(PROVIDERS.codex, { prompt: "P", system: "S" }, { exec, binPath: "/bin/codex" }).then(() => "none", (e: ProviderError) => `${e.kind}: ${e.message}`);

    expect(await kindOf(silent({ timedOut: true, code: null }))).toStartWith("timeout:");
    expect(await kindOf(silent({ aborted: true, code: null }))).toStartWith("cancelled:");
    expect(await kindOf(silent({ stderr: "Error: Not logged in. Run `codex login`.\n" }))).toBe("auth: Error: Not logged in. Run `codex login`.");
    expect(await kindOf(silent({ stderr: "" }))).toBe("other: Codex exited with code 1 and no output");
    expect(await kindOf(async () => { throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }); })).toStartWith("missing:");
  });

  test("a successful exit with no reply text is an error", async () => {
    const exec: Exec = async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, aborted: false });
    await expect(runProvider(PROVIDERS.opencode, { prompt: "P", system: "S" }, { exec, binPath: "/bin/opencode" })).rejects.toThrow("OpenCode returned no text");
  });

  test("exec start failure vs other exec exception", async () => {
    const failWith = (err: unknown) =>
      runProvider(
        PROVIDERS.codex,
        { prompt: "P", system: "S" },
        {
          exec: async () => {
            throw err;
          },
          binPath: "/bin/codex",
        },
      ).then(
        () => null,
        (e: ProviderError) => e,
      );

    const enoent = await failWith(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    expect(enoent).toBeInstanceOf(ProviderError);
    expect(enoent?.kind).toBe("missing");
    expect(enoent?.message).toBe("Codex could not be started: not found");

    const eacces = await failWith(Object.assign(new Error("spawn EACCES"), { code: "EACCES" }));
    expect(eacces).toBeInstanceOf(ProviderError);
    expect(eacces?.kind).toBe("missing");
    expect(eacces?.message).toBe("Codex could not be started: permission denied");

    const badArg = await failWith(new Error("The argument 'args[1]' must be a string … SECRET"));
    expect(badArg).toBeInstanceOf(ProviderError);
    expect(badArg?.kind).toBe("other");
    expect(badArg?.message).toBe("Codex could not be run");
    expect(badArg?.message).not.toContain("SECRET");
  });

  test("an onText listener that throws does not break the run or alter errors", async () => {
    const { exec } = replay("claude.success.ndjson");
    const reply = await runProvider(
      PROVIDERS.claude,
      { prompt: "P", system: "S" },
      {
        exec,
        binPath: "/bin/claude",
        onText: () => {
          throw new Error("listener boom");
        },
      },
    );
    expect(reply).toBe(REPLY);
  });

  test.each([
    ["claude", "claude.success.ndjson"],
    ["codex", "codex.success.ndjson"],
    ["opencode", "opencode.success.ndjson"],
    ["antigravity", "antigravity.success.ndjson"],
  ] as const)("%s replaces NUL characters with U+FFFD without splitting", async (id, file) => {
    const { exec, requests } = replay(file);
    const prompt = '-x\n"q" \'r\'\0tail';
    const system = "sys\0tem";
    const expectedPrompt = '-x\n"q" \'r\'\uFFFDtail';
    const expectedSystem = "sys\uFFFDtem";

    await runProvider(PROVIDERS[id], { prompt, system }, { exec, binPath: `/bin/${id}` });
    const req = requests[0]!;

    for (const arg of req.cmd) {
      expect(arg).not.toContain("\0");
    }
    if (req.stdin !== undefined) {
      expect(req.stdin).not.toContain("\0");
    }

    if (id === "claude") {
      expect(req.stdin).toBe(expectedPrompt);
      expect(req.cmd).toContain(expectedSystem);
    } else if (id === "codex" || id === "opencode") {
      expect(req.stdin).toBe(`${expectedSystem}\n\n${expectedPrompt}`);
    } else if (id === "antigravity") {
      expect(req.cmd[1]).toBe(`--print=${expectedSystem}\n\n${expectedPrompt}`);
    }
  });

  test("the reply is the last complete message for codex and opencode, and blank final does not override text", async () => {
    const fromLines = (lines: string[]): Exec => async (req) => {
      for (const line of lines) req.onStdoutLine?.(line);
      return { code: 0, stdout: lines.join("\n"), stderr: "", timedOut: false, aborted: false };
    };

    const codexSeen: string[] = [];
    const codexReply = await runProvider(
      PROVIDERS.codex,
      { prompt: "P", system: "S" },
      {
        exec: fromLines([
          JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Let me check." } }),
          JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"action":"answer","message":"m"}' } }),
        ]),
        binPath: "/bin/codex",
        onText: (t) => codexSeen.push(t),
      },
    );
    expect(codexReply).toBe('{"action":"answer","message":"m"}');
    expect(codexSeen).toEqual(["Let me check.", '{"action":"answer","message":"m"}']);

    const opencodeSeen: string[] = [];
    const opencodeReply = await runProvider(
      PROVIDERS.opencode,
      { prompt: "P", system: "S" },
      {
        exec: fromLines([
          JSON.stringify({ type: "text", part: { text: "Let me check." } }),
          JSON.stringify({ type: "text", part: { text: '{"action":"answer","message":"m"}' } }),
        ]),
        binPath: "/bin/opencode",
        onText: (t) => opencodeSeen.push(t),
      },
    );
    expect(opencodeReply).toBe('{"action":"answer","message":"m"}');
    expect(opencodeSeen).toEqual(["Let me check.", '{"action":"answer","message":"m"}']);

    // A blank last message does not hide a good reply for whole-message adapters
    const codexBlankTailReply = await runProvider(
      PROVIDERS.codex,
      { prompt: "P", system: "S" },
      {
        exec: fromLines([
          JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"action":"answer","message":"good"}' } }),
          JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "" } }),
          JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "   " } }),
        ]),
        binPath: "/bin/codex",
      },
    );
    expect(codexBlankTailReply).toBe('{"action":"answer","message":"good"}');

    const claudeReply = await runProvider(
      PROVIDERS.claude,
      { prompt: "P", system: "S" },
      {
        exec: fromLines([
          JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } }),
          JSON.stringify({ type: "result", result: "", is_error: false }),
        ]),
        binPath: "/bin/claude",
      },
    );
    expect(claudeReply).toBe("hello");
  });

  test("an error event does not discard a good reply when exit code is 0, but throws when exit code is non-zero", async () => {
    const lines = [
      JSON.stringify({ type: "error", message: "Reconnecting... 1/5" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: REPLY } }),
    ];
    const execWithCode = (code: number): Exec => async (req) => {
      for (const line of lines) req.onStdoutLine?.(line);
      return { code, stdout: lines.join("\n"), stderr: "", timedOut: false, aborted: false };
    };

    const reply = await runProvider(PROVIDERS.codex, { prompt: "P", system: "S" }, { exec: execWithCode(0), binPath: "/bin/codex" });
    expect(reply).toBe(REPLY);

    await expect(
      runProvider(PROVIDERS.codex, { prompt: "P", system: "S" }, { exec: execWithCode(1), binPath: "/bin/codex" }),
    ).rejects.toThrow("Reconnecting... 1/5");
  });

  test("error kind and message from stderr ignore stack frames and derive kind from message then non-stack lines", async () => {
    const failStderr = (stderr: string) =>
      runProvider(
        PROVIDERS.codex,
        { prompt: "P", system: "S" },
        {
          exec: async () => ({ code: 1, stdout: "", stderr, timedOut: false, aborted: false }),
          binPath: "/bin/codex",
        },
      ).then(
        () => null,
        (e: ProviderError) => ({ kind: e.kind, message: e.message }),
      );

    expect(await failStderr("Error: failed\n  at /home/x/401k/file.js:12\nmore")).toEqual({
      kind: "other",
      message: "more",
    });

    expect(await failStderr("Error: 429 rate limit\n    at foo (x.js:1)")).toEqual({
      kind: "quota",
      message: "Error: 429 rate limit",
    });

    expect(await failStderr("Please log in first\nexiting")).toEqual({
      kind: "auth",
      message: "exiting",
    });
  });

  test("the child never receives database credentials from the environment", async () => {
    const { exec, requests } = replay("claude.success.ndjson");
    const inputEnv: Record<string, string | undefined> = {
      PATH: "/bin",
      HOME: "/h",
      DATABASE_URL: "x",
      PGPASSWORD: "p",
      PGHOST: "h",
      LOSQL_TEST_PG_URL: "u",
      PGP_KEY: "k",
      OTHER: "o",
    };

    await runProvider(
      PROVIDERS.claude,
      { prompt: "P", system: "S" },
      { exec, binPath: "/bin/claude", env: inputEnv },
    );

    const passedEnv = requests[0]!.env;
    expect(passedEnv).toEqual({
      PATH: "/bin",
      HOME: "/h",
      PGP_KEY: "k",
      OTHER: "o",
    });
    expect(passedEnv).not.toBe(inputEnv);
  });

  test("the child strips POSTGRES*, MYSQL*, MARIADB*, PG_*, *_DATABASE_URL and case variants while keeping provider keys", async () => {
    const { exec, requests } = replay("claude.success.ndjson");
    const inputEnv: Record<string, string | undefined> = {
      POSTGRES_URL: "postgres://x",
      POSTGRES_PASSWORD: "secret",
      PG_PASSWORD: "secret",
      pgpassword: "secret",
      MYSQL_PWD: "secret",
      MARIADB_HOST: "db.local",
      APP_DATABASE_URL: "postgres://app",
      ANTHROPIC_API_KEY: "sk-ant",
      OPENAI_API_KEY: "sk-oa",
      PATH: "/usr/bin",
      HOME: "/home/u",
      PGP_KEY: "keep-me",
    };

    await runProvider(
      PROVIDERS.claude,
      { prompt: "P", system: "S" },
      { exec, binPath: "/bin/claude", env: inputEnv },
    );

    expect(requests[0]!.env).toEqual({
      ANTHROPIC_API_KEY: "sk-ant",
      OPENAI_API_KEY: "sk-oa",
      PATH: "/usr/bin",
      HOME: "/home/u",
      PGP_KEY: "keep-me",
    });
  });

  test("temporary working directory is removed after runProvider settles on every path, and timeoutMs and signal reach exec", async () => {
    // 1. Success path, verifying timeoutMs and signal reach exec
    const ac1 = new AbortController();
    const s1 = replay("claude.success.ndjson");
    await runProvider(
      PROVIDERS.claude,
      { prompt: "P", system: "S" },
      { exec: s1.exec, binPath: "/bin/claude", timeoutMs: 12345, signal: ac1.signal },
    );
    expect(s1.cwdExisted).toEqual([true]);
    expect(existsSync(s1.requests[0]!.cwd!)).toBe(false);
    expect(s1.requests[0]!.timeoutMs).toBe(12345);
    expect(s1.requests[0]!.signal).toBe(ac1.signal);

    // 2. Error event with non-zero exit
    const s2 = replay("claude.error.ndjson", { code: 1 });
    await expect(
      runProvider(PROVIDERS.claude, { prompt: "P", system: "S" }, { exec: s2.exec, binPath: "/bin/claude" }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(s2.cwdExisted).toEqual([true]);
    expect(existsSync(s2.requests[0]!.cwd!)).toBe(false);

    // 3. Timeout result
    let timeoutCwd: string | undefined;
    let timeoutCwdExisted = false;
    await expect(
      runProvider(
        PROVIDERS.codex,
        { prompt: "P", system: "S" },
        {
          exec: async (req) => {
            timeoutCwd = req.cwd;
            timeoutCwdExisted = req.cwd !== undefined && existsSync(req.cwd);
            return { code: null, stdout: "", stderr: "", timedOut: true, aborted: false };
          },
          binPath: "/bin/codex",
          timeoutMs: 100,
        },
      ),
    ).rejects.toMatchObject({ kind: "timeout" });
    expect(timeoutCwdExisted).toBe(true);
    expect(existsSync(timeoutCwd!)).toBe(false);

    // 4. Thrown exec
    let thrownCwd: string | undefined;
    let thrownCwdExisted = false;
    await expect(
      runProvider(
        PROVIDERS.codex,
        { prompt: "P", system: "S" },
        {
          exec: async (req) => {
            thrownCwd = req.cwd;
            thrownCwdExisted = req.cwd !== undefined && existsSync(req.cwd);
            throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
          },
          binPath: "/bin/codex",
        },
      ),
    ).rejects.toMatchObject({ kind: "missing" });
    expect(thrownCwdExisted).toBe(true);
    expect(existsSync(thrownCwd!)).toBe(false);

    // 5. Aborted signal (including an already-aborted signal)
    const abortedAc = new AbortController();
    abortedAc.abort();
    let abortedCwd: string | undefined;
    let abortedCwdExisted = false;
    let abortedSignalPassed: AbortSignal | undefined;
    const abortedErr = await runProvider(
      PROVIDERS.codex,
      { prompt: "P", system: "S" },
      {
        exec: async (req) => {
          abortedCwd = req.cwd;
          abortedCwdExisted = req.cwd !== undefined && existsSync(req.cwd);
          abortedSignalPassed = req.signal;
          return { code: null, stdout: "", stderr: "", timedOut: false, aborted: Boolean(req.signal?.aborted) };
        },
        binPath: "/bin/codex",
        signal: abortedAc.signal,
      },
    ).then(
      () => null,
      (e: ProviderError) => e,
    );
    expect(abortedErr).toBeInstanceOf(ProviderError);
    expect(abortedErr?.kind).toBe("cancelled");
    expect(abortedSignalPassed).toBe(abortedAc.signal);
    expect(abortedSignalPassed?.aborted).toBe(true);
    expect(abortedCwdExisted).toBe(true);
    expect(existsSync(abortedCwd!)).toBe(false);
  });

  test("cleanup failure in finally never replaces a good reply, and mkdtemp failure becomes ProviderError('other')", async () => {
    let lockedCwd: string | undefined;
    let lockedSubdir: string | undefined;
    try {
      const reply = await runProvider(
        PROVIDERS.codex,
        { prompt: "P", system: "S" },
        {
          exec: async (req) => {
            lockedCwd = req.cwd!;
            lockedSubdir = join(lockedCwd, "sub");
            await mkdir(lockedSubdir);
            await writeFile(join(lockedSubdir, "f.txt"), "x");
            await chmod(lockedSubdir, 0o500);
            req.onStdoutLine?.(
              JSON.stringify({
                type: "item.completed",
                item: { type: "agent_message", text: REPLY },
              }),
            );
            return { code: 0, stdout: "", stderr: "", timedOut: false, aborted: false };
          },
          binPath: "/bin/codex",
        },
      );
      expect(reply).toBe(REPLY);
    } finally {
      if (lockedSubdir !== undefined) {
        await chmod(lockedSubdir, 0o700).catch(() => {});
      }
      if (lockedCwd !== undefined) {
        await rm(lockedCwd, { recursive: true, force: true }).catch(() => {});
      }
    }

    // mkdtemp failure when TMPDIR is not a directory
    const prevTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = "/dev/null/not-a-dir";
    try {
      const err = await runProvider(
        PROVIDERS.codex,
        { prompt: "P", system: "S" },
        {
          exec: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, aborted: false }),
          binPath: "/bin/codex",
        },
      ).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).kind).toBe("other");
      expect((err as ProviderError).message).toBe("Codex could not be run");
      expect((err as ProviderError).message).not.toContain("/dev/null");
    } finally {
      if (prevTmpdir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = prevTmpdir;
      }
    }
  });

  test("a child printing 16 MiB without a newline ends within 2 seconds with 'produced too much output'", async () => {
    expect(MAX_PROVIDER_OUTPUT_BYTES).toBe(8 * 1024 * 1024);

    let capturedMaxBytes: number | undefined;
    const stubExec: Exec = async (req) => {
      capturedMaxBytes = req.maxOutputBytes;
      return bunExec({
        ...req,
        cmd: [
          process.execPath,
          "-e",
          "const buf = Buffer.alloc(65536, 97); for (let i = 0; i < 256; i++) process.stdout.write(buf);",
        ],
      });
    };

    const started = Date.now();
    const err = await runProvider(
      PROVIDERS.codex,
      { prompt: "P", system: "S" },
      { exec: stubExec, binPath: "/bin/codex" },
    ).then(
      () => null,
      (e: unknown) => e,
    );
    const elapsed = Date.now() - started;

    expect(capturedMaxBytes).toBe(MAX_PROVIDER_OUTPUT_BYTES);
    expect(elapsed).toBeLessThan(2000);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("other");
    expect((err as ProviderError).message).toBe("Codex produced too much output");
  });
});

test.each([
  ["You’ve hit your usage limit. Upgrade to Pro", "quota"],
  ["rate limit exceeded (429)", "quota"],
  ["Quota exhausted for this period", "quota"],
  ["Not logged in. Run claude login", "auth"],
  ["Invalid API key", "auth"],
  ["401 Unauthorized", "auth"],
  ["Please authenticate first", "auth"],
  ["boom", "other"],
] as const)("classifyProviderError(%p) is %p", (message, kind) => {
  expect(classifyProviderError(message)).toBe(kind);
});

describe("the variables a saved Connection reads its password from", () => {
  const connections = [
    { name: "one", url: "postgres://u:${DBPW}@db.example:5432/app" },
    { name: "two", url: "postgres://${DBUSER}:${DBPW}@db2.example/app?sslpassword=${SSLPW}" },
    { name: "three", url: "postgres://u:${BROKEN@db3.example/app ${} ${1X} $NOBRACE" },
  ];
  const source = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/u",
    DBPW: "s3cret",
    DBUSER: "admin",
    SSLPW: "sslsecret",
    BROKEN: "kept",
    "1X": "kept",
    NOBRACE: "kept",
    dbpw: "other case is another name",
  };

  test("are named by connectionEnvNames: each once, also inside a query parameter; a malformed ${ names nothing", () => {
    expect([...connectionEnvNames(connections)].sort()).toEqual(["DBPW", "DBUSER", "SSLPW"]);
    expect([...connectionEnvNames([])]).toEqual([]);
  });

  test("sanitizeEnv removes them, also a name in two Connections, and keeps the rest", () => {
    expect(sanitizeEnv(source, connections)).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/home/u",
      BROKEN: "kept",
      "1X": "kept",
      NOBRACE: "kept",
      dbpw: "other case is another name",
    });
  });

  test("without saved Connections sanitizeEnv keeps them as before", () => {
    expect(sanitizeEnv(source)).toEqual(source);
    expect(sanitizeEnv(source, [])).toEqual(source);
  });

  test("a Turn's process does not get them", async () => {
    const { exec, requests } = replay("claude.success.ndjson");
    await runProvider(PROVIDERS.claude, { prompt: "P", system: "S" }, { exec, binPath: "/bin/claude", env: source, connections });
    expect(requests[0]!.env!.DBPW).toBeUndefined();
    expect(requests[0]!.env!.DBUSER).toBeUndefined();
    expect(requests[0]!.env!.SSLPW).toBeUndefined();
    expect(requests[0]!.env!.PATH).toBe("/usr/bin:/bin");
    expect(requests[0]!.env!.HOME).toBe("/home/u");
  });
});

describe("an aborted Turn", () => {
  test("its directory is removed synchronously at the abort, before the Provider process has ended", async () => {
    const controller = new AbortController();
    let cwd = "";
    let release!: () => void;
    const ended = new Promise<void>((resolve) => {
      release = resolve;
    });
    const exec: Exec = async (request) => {
      cwd = request.cwd!;
      // The process takes its time to end after the abort.
      await ended;
      return { code: null, stdout: "", stderr: "", timedOut: false, aborted: true };
    };
    const running = runProvider(PROVIDERS.claude, { prompt: "P", system: "S" }, { exec, binPath: "/bin/claude", signal: controller.signal });
    await Bun.sleep(10);
    expect(existsSync(cwd)).toBe(true);
    controller.abort();
    expect(existsSync(cwd)).toBe(false);
    release();
    await expect(running).rejects.toMatchObject({ kind: "cancelled" });
  });
});
