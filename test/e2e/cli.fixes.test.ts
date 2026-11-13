import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeSync, constants as fsConstants, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedEnv, losql, ROOT } from "./helpers";
import { installSleepingStubClaude, stubPath } from "./stub-provider";

let dir: string;
let env: Record<string, string> & { PATH: string };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "losql-cli-fixes-"));
  env = {
    HOME: join(dir, "home"),
    XDG_CONFIG_HOME: join(dir, "xdg-config"),
    XDG_STATE_HOME: join(dir, "xdg-state"),
    LOSQL_CONFIG_DIR: join(dir, "config"),
    LOSQL_STATE_DIR: join(dir, "state"),
    PATH: stubPath(join(dir, "bin")),
    DATABASE_URL: "",
  };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function createBigSqliteDb(dbPath: string, rowCount = 20000): void {
  const db = new Database(dbPath, { create: true });
  try {
    db.exec("create table big (id integer primary key, label text, amount integer);");
    const insert = db.prepare("insert into big (id, label, amount) values (?, ?, ?)");
    const tx = db.transaction((n: number) => {
      for (let i = 1; i <= n; i++) {
        insert.run(i, `row-label-${i}`, i * 10);
      }
    });
    tx(rowCount);
  } finally {
    db.close();
  }
}

describe("fix 1: output written to a pipe is complete", () => {
  test("20,000 rows arrive complete in table, json, and csv formats, plus --help", async () => {
    const dbPath = join(dir, "big.db");
    createBigSqliteDb(dbPath, 20000);

    const jsonRes = await losql(
      ["exec", "-c", dbPath, "--max-rows", "1000000", "--format", "json", "select * from big order by id"],
      { env },
    );
    expect(jsonRes.code).toBe(0);
    expect(Buffer.byteLength(jsonRes.stdout)).toBe(1546685);
    const parsed = JSON.parse(jsonRes.stdout);
    expect(parsed).toHaveLength(20000);

    const csvRes = await losql(
      ["exec", "-c", dbPath, "--max-rows", "1000000", "--format", "csv", "select * from big order by id"],
      { env },
    );
    expect(csvRes.code).toBe(0);
    expect(Buffer.byteLength(csvRes.stdout)).toBe(546698);
    expect(csvRes.stdout.trimEnd().split("\n")).toHaveLength(20001);

    const tableRes = await losql(
      ["exec", "-c", dbPath, "--max-rows", "1000000", "--format", "table", "select * from big order by id"],
      { env },
    );
    expect(tableRes.code).toBe(0);
    expect(Buffer.byteLength(tableRes.stdout)).toBe(700083);
    expect(tableRes.stdout.endsWith("\n(20000 rows)\n")).toBe(true);

    const helpRes = await losql(["--help"], { env });
    expect(helpRes.code).toBe(0);
    expect(helpRes.stdout.endsWith("losql --help | --version\n")).toBe(true);
  });

  test("closing stdout pipe after first chunk exits within 3s with code 0 and no stack trace", async () => {
    const dbPath = join(dir, "big.db");
    createBigSqliteDb(dbPath, 20000);

    const proc = Bun.spawn(
      [process.execPath, "run", join(ROOT, "src/main.ts"), "exec", "-c", dbPath, "--max-rows", "1000000", "select * from big"],
      {
        cwd: ROOT,
        env: isolatedEnv(env),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const reader = proc.stdout.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await reader.cancel();

    const start = performance.now();
    const [stderr, code] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(3000);
    expect(code).toBe(0);
    expect(stderr).not.toContain("at ");
    expect(stderr).toBe("");
  });
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(filePath: string, timeoutMs = 5000): Promise<string> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf8").trim();
      if (content.length > 0) return content;
    }
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForProcessDead(pid: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await Bun.sleep(25);
  }
  return !isProcessAlive(pid);
}

describe("fix 2: a signal stops the work and the child process", () => {
  test("SIGTERM stops losql ask with 143 and terminates the stub provider process", async () => {
    const pidFile = join(dir, "claude-term.pid");
    await installSleepingStubClaude(join(dir, "bin"), pidFile, 30000);

    const proc = Bun.spawn(
      [process.execPath, "run", join(ROOT, "src/main.ts"), "ask", "-c", "demo", "--provider", "claude", "slow question"],
      {
        cwd: ROOT,
        env: isolatedEnv(env),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const pidText = await waitForFile(pidFile);
    const childPid = Number(pidText);
    expect(Number.isInteger(childPid)).toBe(true);
    expect(isProcessAlive(childPid)).toBe(true);

    const start = performance.now();
    proc.kill("SIGTERM");

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const elapsed = performance.now() - start;

    try {
      expect(elapsed).toBeLessThan(3000);
      expect(code).toBe(143);
      expect(stdout).toBe("");
      expect(stderr).toBe("losql: interrupted\n");
      const dead = await waitForProcessDead(childPid, 2000);
      expect(dead).toBe(true);
    } finally {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        // already dead
      }
    }
  });

  test("SIGINT stops losql ask with 130 and terminates the stub provider process", async () => {
    const pidFile = join(dir, "claude-int.pid");
    await installSleepingStubClaude(join(dir, "bin"), pidFile, 30000);

    const proc = Bun.spawn(
      [process.execPath, "run", join(ROOT, "src/main.ts"), "ask", "-c", "demo", "--provider", "claude", "slow question"],
      {
        cwd: ROOT,
        env: isolatedEnv(env),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const pidText = await waitForFile(pidFile);
    const childPid = Number(pidText);
    expect(Number.isInteger(childPid)).toBe(true);
    expect(isProcessAlive(childPid)).toBe(true);

    const start = performance.now();
    proc.kill("SIGINT");

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const elapsed = performance.now() - start;

    try {
      expect(elapsed).toBeLessThan(3000);
      expect(code).toBe(130);
      expect(stdout).toBe("");
      expect(stderr).toBe("losql: interrupted\n");
      const dead = await waitForProcessDead(childPid, 2000);
      expect(dead).toBe(true);
    } finally {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        // already dead
      }
    }
  });

  test("runProviders --test passes signal to runProvider", async () => {
    const { runProviders } = await import("../../src/cli/commands");
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    await runProviders(
      { kind: "providers", json: false, test: true },
      {
        stdout: () => {},
        stderr: () => {},
        stdin: async () => "",
        env,
        home: join(dir, "home"),
        cwd: dir,
        signal: controller.signal,
        which: (bin) => (bin === "claude" ? "/usr/bin/claude" : null),
        exec: async (req) => {
          if (req.cmd.includes("--version")) {
            return { code: 0, stdout: "9.9.9\n", stderr: "", timedOut: false, aborted: false };
          }
          seenSignal = req.signal;
          const line = JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
            result: "ok",
          });
          req.onStdoutLine?.(line);
          return { code: 0, stdout: `${line}\n`, stderr: "", timedOut: false, aborted: false };
        },
      },
    );
    expect(seenSignal).toBe(controller.signal);
  });
});

describe("fix 3: text from a Provider or the database cannot drive the terminal", () => {
  test("runAsk escapes control sequences on stderr always and on stdout only when tty.stdout is true", async () => {
    const { runAsk } = await import("../../src/cli/commands");
    const malicious = "\u001b]0;pwned\u0007 and \u001b[31mred\u001b[0m";
    const replies = [
      JSON.stringify({
        action: "query",
        sql: `select '${malicious}' as x`,
        why: "check",
      }),
      JSON.stringify({
        action: "answer",
        message: `Result: ${malicious}`,
        sql: `select '${malicious}' as col`,
      }),
    ];

    for (const isTty of [false, true]) {
      let callIdx = 0;
      let stdout = "";
      let stderr = "";
      const code = await runAsk(
        {
          kind: "ask",
          connection: "demo",
          provider: "claude",
          run: false,
          question: "test",
        },
        {
          stdout: (t) => {
            stdout += t;
          },
          stderr: (t) => {
            stderr += t;
          },
          stdin: async () => "",
          env,
          home: join(dir, "home"),
          cwd: dir,
          which: (bin) => (bin === "claude" ? "/usr/bin/claude" : null),
          tty: { stdout: isTty, stderr: isTty },
          exec: async (req) => {
            if (req.cmd.includes("--version")) {
              return { code: 0, stdout: "9.9.9\n", stderr: "", timedOut: false, aborted: false };
            }
            const text = replies[Math.min(callIdx++, replies.length - 1)]!;
            const line = JSON.stringify({
              type: "result",
              subtype: "success",
              is_error: false,
              result: text,
            });
            req.onStdoutLine?.(line);
            return { code: 0, stdout: `${line}\n`, stderr: "", timedOut: false, aborted: false };
          },
        },
      );

      expect(code).toBe(0);
      expect(stderr.includes("\u001b")).toBe(false);
      expect(stderr.includes("\u0007")).toBe(false);
      expect(stderr).toContain("\\x1b]0;pwned\\x07");
      expect(stderr).toContain("\\x1b[31m");

      if (isTty) {
        expect(stdout.includes("\u001b")).toBe(false);
        expect(stdout.includes("\u0007")).toBe(false);
        expect(stdout).toContain("\\x1b]0;pwned\\x07");
        expect(stdout).toContain("\\x1b[31m");
      } else {
        expect(stdout.includes("\u001b")).toBe(true);
        expect(stdout.includes("\u0007")).toBe(true);
        expect(stdout).toBe(`select '${malicious}' as col\n`);
      }
    }
  });

  test("a Provider that fails with control characters in its error text gives an escaped losql: line", async () => {
    const { runAsk } = await import("../../src/cli/commands");
    let stdout = "";
    let stderr = "";
    const code = await runAsk(
      {
        kind: "ask",
        connection: "demo",
        provider: "claude",
        run: false,
        question: "test",
      },
      {
        stdout: (t) => {
          stdout += t;
        },
        stderr: (t) => {
          stderr += t;
        },
        stdin: async () => "",
        env,
        home: join(dir, "home"),
        cwd: dir,
        which: (bin) => (bin === "claude" ? "/usr/bin/claude" : null),
        exec: async (req) => {
          if (req.cmd.includes("--version")) {
            return { code: 0, stdout: "9.9.9\n", stderr: "", timedOut: false, aborted: false };
          }
          return {
            code: 1,
            stdout: "",
            stderr: "fatal: \u001b]0;pwned\u0007 \u001b[31mboom\n",
            timedOut: false,
            aborted: false,
          };
        },
      },
    );

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr.includes("\u001b")).toBe(false);
    expect(stderr.includes("\u0007")).toBe(false);
    expect(stderr).toBe("losql: fatal: \\x1b]0;pwned\\x07 \\x1b[31mboom\n");
  });

  test("exec in csv format with a cell holding ESC[31m is verbatim when piped and escaped when tty.stdout is true", async () => {
    const { runExec } = await import("../../src/cli/commands");
    const sql = "select '\u001b[31m' as c";

    let pipedOut = "";
    const pipedCode = await runExec(
      { kind: "exec", connection: "demo", format: "csv", readOnly: true, sql },
      {
        stdout: (t) => {
          pipedOut += t;
        },
        stderr: () => {},
        stdin: async () => "",
        env,
        home: join(dir, "home"),
        cwd: dir,
        exec: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, aborted: false }),
        which: () => null,
        tty: { stdout: false, stderr: false },
      },
    );
    expect(pipedCode).toBe(0);
    expect(pipedOut).toBe("c\n\u001b[31m\n");

    let ttyOut = "";
    const ttyCode = await runExec(
      { kind: "exec", connection: "demo", format: "csv", readOnly: true, sql },
      {
        stdout: (t) => {
          ttyOut += t;
        },
        stderr: () => {},
        stdin: async () => "",
        env,
        home: join(dir, "home"),
        cwd: dir,
        exec: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, aborted: false }),
        which: () => null,
        tty: { stdout: true, stderr: true },
      },
    );
    expect(ttyCode).toBe(0);
    expect(ttyOut).toBe("c\n\\x1b[31m\n");
  });

  test("providers --test writes a Provider's failure text verbatim when piped and escaped when tty.stdout is true", async () => {
    const { runProviders } = await import("../../src/cli/commands");
    const rawFail = "auth error \u001b]0;pwned\u0007 \u001b[31mred\u001b[0m";

    let pipedOut = "";
    const pipedCode = await runProviders(
      { kind: "providers", json: false, test: true },
      {
        stdout: (t) => {
          pipedOut += t;
        },
        stderr: () => {},
        stdin: async () => "",
        env,
        home: join(dir, "home"),
        cwd: dir,
        tty: { stdout: false, stderr: false },
        which: (bin) => (bin === "claude" ? "/usr/bin/claude" : null),
        exec: async (req) => {
          if (req.cmd.includes("--version")) {
            return { code: 0, stdout: "9.9.9\n", stderr: "", timedOut: false, aborted: false };
          }
          return { code: 1, stdout: "", stderr: rawFail, timedOut: false, aborted: false };
        },
      },
    );
    expect(pipedCode).toBe(0);
    expect(pipedOut).toContain(`failed: ${rawFail}\n`);
    expect(pipedOut.includes("\u001b")).toBe(true);
    expect(pipedOut.includes("\u0007")).toBe(true);

    let ttyOut = "";
    const ttyCode = await runProviders(
      { kind: "providers", json: false, test: true },
      {
        stdout: (t) => {
          ttyOut += t;
        },
        stderr: () => {},
        stdin: async () => "",
        env,
        home: join(dir, "home"),
        cwd: dir,
        tty: { stdout: true, stderr: true },
        which: (bin) => (bin === "claude" ? "/usr/bin/claude" : null),
        exec: async (req) => {
          if (req.cmd.includes("--version")) {
            return { code: 0, stdout: "9.9.9\n", stderr: "", timedOut: false, aborted: false };
          }
          return { code: 1, stdout: "", stderr: rawFail, timedOut: false, aborted: false };
        },
      },
    );
    expect(ttyCode).toBe(0);
    expect(ttyOut.includes("\u001b")).toBe(false);
    expect(ttyOut.includes("\u0007")).toBe(false);
    expect(ttyOut).toContain("failed: auth error \\x1b]0;pwned\\x07 \\x1b[31mred\\x1b[0m\n");

    // Also verify via spawned piped process with a stub provider
    const binDir = join(dir, "bin");
    const { mkdir, writeFile, chmod } = await import("node:fs/promises");
    await mkdir(binDir, { recursive: true });
    const stubBin = join(binDir, "claude");
    await writeFile(
      stubBin,
      [
        `#!${process.execPath}`,
        `if (process.argv.includes("--version")) { process.stdout.write("claude 9.9.9\\n"); process.exit(0); }`,
        `process.stderr.write(${JSON.stringify(`${rawFail}\n`)});`,
        `process.exit(1);`,
      ].join("\n"),
    );
    await chmod(stubBin, 0o755);

    const spawned = await losql(["providers", "--test"], { env });
    expect(spawned.code).toBe(0);
    expect(spawned.stdout).toContain(`failed: ${rawFail}\n`);
    expect(spawned.stdout.includes("\u001b")).toBe(true);
    expect(spawned.stdout.includes("\u0007")).toBe(true);
  });
});


describe("fix 4: a Result without columns is reported the same way in every format", () => {
  test("table format prints command and affected count to stdout, while json and csv print it to stderr and [] / empty to stdout", async () => {
    const sql = "create table w (x integer); insert into w values (3)";

    const tableRes = await losql(["exec", "-c", "demo", "--format", "table", sql], { env });
    expect(tableRes.code).toBe(0);
    expect(tableRes.stdout).toBe("INSERT 1\n");
    expect(tableRes.stderr).toBe("");

    const jsonRes = await losql(["exec", "-c", "demo", "--format", "json", sql], { env });
    expect(jsonRes.code).toBe(0);
    expect(jsonRes.stdout).toBe("[]\n");
    expect(jsonRes.stderr).toBe("INSERT 1\n");

    const csvRes = await losql(["exec", "-c", "demo", "--format", "csv", sql], { env });
    expect(csvRes.code).toBe(0);
    expect(csvRes.stdout).toBe("");
    expect(csvRes.stderr).toBe("INSERT 1\n");
  });
});

describe("fix 5: a failing Statement says which one it was", () => {
  test("with three statements where the second fails, prints statement 2 of 3 failed and does not run the third", async () => {
    const dbPath = join(dir, "s.db");
    const db = new Database(dbPath, { create: true });
    db.exec("create table items (x integer);");
    db.close();

    const r = await losql(
      [
        "exec",
        "-c",
        dbPath,
        "insert into items values (1); select * from missing_table; insert into items values (2)",
      ],
      { env },
    );

    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    const errLines = r.stderr.trimEnd().split("\n");
    expect(errLines[0]).toBe("losql: statement 2 of 3 failed");
    expect(r.stderr).toContain("no such table: missing_table");

    const checkDb = new Database(dbPath, { readonly: true });
    try {
      const rows = checkDb.query("select x from items order by x").all() as { x: number }[];
      expect(rows).toEqual([{ x: 1 }]);
    } finally {
      checkDb.close();
    }
  });
});

describe("fix 5b: losql: interrupted is said only when something was interrupted", () => {
  test("a signal while the output is still being written prints losql: interrupted and exits 130, like a signal before the command returns", async () => {
    // 1. Deterministic seam test via runHeadlessWithSignals
    const { runHeadlessWithSignals } = await import("../../src/cli/commands");

    // Case A: signal arrives AFTER command has returned, while flushing output
    {
      let stderrOut = "";
      let onSignal!: (sig: "SIGINT" | "SIGTERM") => void;
      let flushCalled = false;

      const exitCode = await runHeadlessWithSignals({
        runCommand: async () => 0,
        rawStdout: () => {},
        rawStderr: (t) => {
          stderrOut += t;
        },
        subscribeSignals: (handler) => {
          onSignal = handler;
          return () => {};
        },
        flush: async () => {
          flushCalled = true;
          // Signal arrives while flushing to a slow reader AFTER runCommand resolved
          onSignal("SIGINT");
        },
      });

      expect(flushCalled).toBe(true);
      // Output still being written when the signal came: incomplete, and the exit code says so.
      expect(exitCode).toBe(130);
      expect(stderrOut).toBe("losql: interrupted\n");
    }

    // Case B: signal arrives BEFORE command has returned
    {
      let stderrOut = "";
      let onSignal!: (sig: "SIGINT" | "SIGTERM") => void;

      const exitCode = await runHeadlessWithSignals({
        runCommand: async (signal) => {
          onSignal("SIGINT");
          expect(signal.aborted).toBe(true);
          return 0;
        },
        rawStdout: () => {},
        rawStderr: (t) => {
          stderrOut += t;
        },
        subscribeSignals: (handler) => {
          onSignal = handler;
          return () => {};
        },
        flush: async () => {},
      });

      expect(exitCode).toBe(130);
      expect(stderrOut).toBe("losql: interrupted\n");
    }
  });

  // 2. Real process with a reader that has stalled: signal arrives while the finished command is
  // still writing its output. A named pipe (not Bun's "pipe", whose parent side drains eagerly)
  // keeps the writer blocked until the test reads.
  test.skipIf(process.platform !== "linux")(
    "a signal while the output is still being written to a reader that has stalled prints losql: interrupted and exits 130",
    async () => {
      const dbPath = join(dir, "slow-reader.db");
      createBigSqliteDb(dbPath, 20000);
      const fifo = join(dir, "slow-reader.fifo");
      expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
      const holdFd = openSync(fifo, fsConstants.O_RDWR);
      const readFd = openSync(fifo, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
      // Reads what is in the pipe; with `once`, a single read (so the writer stays blocked).
      const drain = (once = false): Buffer[] => {
        const out: Buffer[] = [];
        const buf = Buffer.alloc(once ? 4096 : 65536);
        while (out.length === 0 || !once) {
          let n = 0;
          try {
            n = readSync(readFd, buf);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "EAGAIN") break;
            throw err;
          }
          if (n <= 0) break;
          out.push(Buffer.from(buf.subarray(0, n)));
        }
        return out;
      };

      let proc: ReturnType<typeof Bun.spawn> | null = null;
      try {
        proc = Bun.spawn(
          [
            process.execPath,
            "run",
            join(ROOT, "src/main.ts"),
            "exec",
            "-c",
            dbPath,
            "--max-rows",
            "1000000",
            "--format",
            "csv",
            "select * from big order by id",
          ],
          {
            cwd: ROOT,
            env: isolatedEnv(env),
            stdin: "ignore",
            stdout: holdFd,
            stderr: "pipe",
          },
        );

        // Wait for the first chunk: runExec writes its entire output in a single writeStdout call
        // right before returning, so output in the pipe means the command has returned.
        const chunks: Buffer[] = [];
        const deadline = Date.now() + 10000;
        while (chunks.length === 0 && Date.now() < deadline) {
          chunks.push(...drain(true));
          if (chunks.length === 0) await Bun.sleep(10);
        }
        expect(chunks.length).toBeGreaterThan(0);
        // Give the microtask after runExec a moment to cross the command-returned boundary
        await Bun.sleep(50);

        // Send SIGINT while the process is blocked writing the rest to a reader that has stalled
        proc.kill("SIGINT");
        const code = await Promise.race([proc.exited, Bun.sleep(2000).then(() => "still alive" as const)]);
        chunks.push(...drain());
        const stderr = await new Response(proc.stderr as ReadableStream).text();
        const fullStdout = Buffer.concat(chunks).toString("utf8");

        expect(code).toBe(130);
        expect(stderr).toBe("losql: interrupted\n");
        // Writing stopped: the output is incomplete, and the exit code says so.
        expect(fullStdout.trimEnd().split("\n").length).toBeLessThan(20001);
      } finally {
        if (proc && proc.exitCode === null && proc.signalCode === null) {
          proc.kill("SIGKILL");
          await proc.exited;
        }
        closeSync(readFd);
        closeSync(holdFd);
      }
    },
  );
});

describe("fix 6: a failed write is not a success", () => {
  test.skipIf(!existsSync("/dev/full"))(
    "writing output to /dev/full prints losql: could not write output: <reason> on stderr and exits 1",
    async () => {
      const proc = Bun.spawn(
        [process.execPath, "run", join(ROOT, "src/main.ts"), "exec", "-c", "demo", "select 1 as x"],
        {
          cwd: ROOT,
          env: isolatedEnv(env),
          stdin: "ignore",
          stdout: Bun.file("/dev/full"),
          stderr: "pipe",
        },
      );

      const [stderr, code] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(code).toBe(1);
      expect(stderr).toMatch(/^losql: could not write output: .+\n$/);
    },
  );
});





type Sig = "SIGINT" | "SIGTERM";

function seamHarness() {
  const state = {
    stderr: "",
    forced: [] as number[],
    onSignal: (_sig: Sig) => {},
  };
  const base = {
    rawStdout: () => {},
    rawStderr: (t: string) => {
      state.stderr += t;
    },
    subscribeSignals: (handler: (sig: Sig) => void) => {
      state.onSignal = handler;
      return () => {};
    },
    onForceExit: (code: 130 | 143) => {
      state.forced.push(code);
    },
  };
  return { state, base };
}

describe("fix 1 (round 2): a signal always ends the process promptly", () => {
  test("while the command works: the work is cancelled, the line is printed, exit 130/143; a second signal forces the exit", async () => {
    const { runHeadlessWithSignals } = await import("../../src/cli/commands");
    for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
      const { state, base } = seamHarness();
      let aborted = false;
      const exitCode = await runHeadlessWithSignals({
        ...base,
        runCommand: async (signal) => {
          state.onSignal(sig);
          aborted = signal.aborted;
          return 0;
        },
        flush: async () => {},
      });
      expect(aborted).toBe(true);
      expect(exitCode).toBe(code);
      expect(state.stderr).toBe("losql: interrupted\n");
      expect(state.forced).toEqual([]);
    }

    for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
      const { state, base } = seamHarness();
      const exitCode = await runHeadlessWithSignals({
        ...base,
        runCommand: async () => {
          state.onSignal(sig);
          state.onSignal(sig);
          return 0;
        },
        flush: async () => {},
      });
      expect(state.forced).toEqual([code]);
      expect(state.stderr).toBe("losql: interrupted\n");
      expect(exitCode).toBe(code);
    }
  });

  test("while the output is still being written: writing stops at once, the line is printed, exit 130/143", async () => {
    const { runHeadlessWithSignals } = await import("../../src/cli/commands");
    for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
      const { state, base } = seamHarness();
      let flushStarted = false;
      const run = runHeadlessWithSignals({
        ...base,
        runCommand: async () => 0,
        // A reader that never reads: the flush never completes.
        flush: () => {
          flushStarted = true;
          setTimeout(() => state.onSignal(sig), 5);
          return new Promise<void>(() => {});
        },
      });
      const exitCode = await Promise.race([run, Bun.sleep(1000).then(() => "hung" as const)]);
      expect(flushStarted).toBe(true);
      expect(exitCode).toBe(code);
      expect(state.stderr).toBe("losql: interrupted\n");
      expect(state.forced).toEqual([]);
    }
  });

  test("while the output is still being written: a second signal forces the exit at once", async () => {
    const { runHeadlessWithSignals } = await import("../../src/cli/commands");
    for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
      const { state, base } = seamHarness();
      const run = runHeadlessWithSignals({
        ...base,
        runCommand: async () => 0,
        flush: () => {
          state.onSignal(sig);
          state.onSignal(sig);
          return new Promise<void>(() => {});
        },
      });
      const exitCode = await Promise.race([run, Bun.sleep(1000).then(() => "hung" as const)]);
      expect(state.forced).toEqual([code]);
      expect(exitCode).toBe(code);
      expect(state.stderr).toBe("losql: interrupted\n");
    }
  });

  test("after everything was written: exit with the command's own code, nothing more is printed; a second signal forces the exit", async () => {
    const { runHeadlessWithSignals } = await import("../../src/cli/commands");
    for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
      const { state, base } = seamHarness();
      const exitCode = await runHeadlessWithSignals({
        ...base,
        runCommand: async () => 3,
        flush: async () => {},
      });
      expect(exitCode).toBe(3);
      // A signal that arrives while the process is exiting anyway.
      state.onSignal(sig);
      expect(state.stderr).toBe("");
      expect(state.forced).toEqual([]);
      state.onSignal(sig);
      expect(state.forced).toEqual([code]);
      expect(state.stderr).toBe("");
    }
  });
});

const BIG_SQLITE_QUERY =
  "with recursive n(i) as (select 1 union all select i+1 from n where i < 60000) select i, printf('%040d', i) as pad from n";
const BIG_PG_QUERY = "select i, lpad(i::text, 40, '0') as pad from generate_series(1, 60000) as i";

function bigTarget(kind: "sqlite" | "postgres"): { conn: string; query: string } {
  if (kind === "postgres") {
    return { conn: process.env.LOSQL_TEST_PG_URL!, query: BIG_PG_QUERY };
  }
  const dbPath = join(dir, "big-output.db");
  new Database(dbPath, { create: true }).close();
  return { conn: dbPath, query: BIG_SQLITE_QUERY };
}

const targets = [
  { kind: "sqlite" as const, skip: false },
  { kind: "postgres" as const, skip: !process.env.LOSQL_TEST_PG_URL },
];

describe("fix 1 (round 2): a real process writing into a pipe nobody reads", () => {
  for (const { kind, skip } of targets) {
    for (const [sig, code] of [["SIGTERM", 143], ["SIGINT", 130]] as const) {
      test.skipIf(skip || process.platform !== "linux")(
        `${kind}: one ${sig} ends the process within a second with ${code} and the line`,
        async () => {
          const { conn, query } = bigTarget(kind);
          const fifo = join(dir, "never-read.fifo");
          expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
          // O_RDWR keeps a reader end open (Linux) that the test never reads from.
          const fd = openSync(fifo, fsConstants.O_RDWR);
          let proc: ReturnType<typeof Bun.spawn> | null = null;
          try {
            proc = Bun.spawn(
              [
                process.execPath,
                "run",
                join(ROOT, "src/main.ts"),
                "exec",
                "-c",
                conn,
                "--format",
                "csv",
                "--max-rows",
                "100000",
                query,
              ],
              { cwd: ROOT, env: isolatedEnv(env), stdin: "ignore", stdout: fd, stderr: "pipe" },
            );
            // Generous: the query takes well under a second; after this the command has returned and
            // its output (about 3 MB) sits stalled in front of a full pipe.
            await Bun.sleep(2500);
            expect(proc.exitCode).toBeNull();
            const sentAt = performance.now();
            proc.kill(sig);
            const outcome = await Promise.race([
              proc.exited,
              Bun.sleep(1000).then(() => "still alive" as const),
            ]);
            expect(performance.now() - sentAt).toBeLessThan(1000);
            expect(outcome).toBe(code);
            expect(await new Response(proc.stderr as ReadableStream).text()).toBe("losql: interrupted\n");
          } finally {
            if (proc && proc.exitCode === null && proc.signalCode === null) {
              proc.kill("SIGKILL");
              await proc.exited;
            }
            closeSync(fd);
          }
        },
        15000,
      );
    }

    test.skipIf(skip)(
      `${kind}: a reader that reads everything and no signal: exit 0, complete output, no line`,
      async () => {
        const { conn, query } = bigTarget(kind);
        const r = await losql(["exec", "-c", conn, "--format", "csv", "--max-rows", "100000", query], { env });
        expect(r.code).toBe(0);
        expect(r.stderr).toBe("");
        const lines = r.stdout.trimEnd().split("\n");
        expect(lines).toHaveLength(60001);
        expect(lines[60000]).toBe(`60000,${"60000".padStart(40, "0")}`);
      },
      15000,
    );
  }
});

describe("fix 5 (round 3): a signal while the command is still working ends the process also when the reader has stalled", () => {
  test("at the seam: a command still working, a flush that never resolves, one signal: 130/143 and the line once", async () => {
    const { runHeadlessWithSignals } = await import("../../src/cli/commands");
    for (const [sig, code] of [["SIGTERM", 143], ["SIGINT", 130]] as const) {
      const { state, base } = seamHarness();
      let flushCalls = 0;
      const run = runHeadlessWithSignals({
        ...base,
        runCommand: async (signal) => {
          // Still working when the signal comes; the work stops at the abort.
          setTimeout(() => state.onSignal(sig), 5);
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          return 0;
        },
        // A reader that never reads: the flush never completes.
        flush: () => {
          flushCalls++;
          return new Promise<void>(() => {});
        },
      });
      const exitCode = await Promise.race([run, Bun.sleep(1000).then(() => "hung" as const)]);
      expect(exitCode).toBe(code);
      expect(state.stderr).toBe("losql: interrupted\n");
      expect(state.forced).toEqual([]);
      expect(flushCalls).toBeLessThanOrEqual(1);
    }
  });

  // `losql exec` writes its output only after its last Statement, so no exec (SQLite or Postgres) has
  // output waiting while it still works. The real process here runs the real signal handling, flush
  // and writes of the headless commands (runHeadlessWithSignals, flushCliStreams, realCliDeps) around a
  // SQLite command that has written its first Statement's output (larger than a pipe's buffer) into
  // a named pipe nobody reads and then works on a further Statement until the abort stops it.
  test.skipIf(process.platform !== "linux")(
    "a real process on SQLite: one SIGTERM while it still works ends it within a second with 143 and the line once",
    async () => {
      const ready = join(dir, "working.ready");
      const script = join(dir, "working-command.ts");
      await Bun.write(
        script,
        `import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { flushCliStreams, realCliDeps, runHeadlessWithSignals } from ${JSON.stringify(join(ROOT, "src/cli/commands.ts"))};
const deps = realCliDeps();
const db = new Database(":memory:");
const code = await runHeadlessWithSignals({
  rawStdout: deps.stdout,
  rawStderr: deps.stderr,
  onForceExit: (c) => process.exit(c),
  flush: () => flushCliStreams(),
  runCommand: async (signal) => {
    const rows = db.query(${JSON.stringify(BIG_SQLITE_QUERY)}).all() as { i: number; pad: string }[];
    deps.stdout(rows.map((r) => r.i + "," + r.pad + "\\n").join(""));
    writeFileSync(${JSON.stringify(ready)}, "1");
    const deadline = Date.now() + 30000;
    while (!signal.aborted && Date.now() < deadline) {
      db.query("with recursive n(i) as (select 1 union all select i+1 from n where i < 2000) select count(*) from n").get();
      await new Promise((r) => setTimeout(r, 1));
    }
    return 0;
  },
});
process.exit(code);
`,
      );
      const fifo = join(dir, "never-read-working.fifo");
      expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
      // O_RDWR keeps a reader end open (Linux) that the test never reads from.
      const fd = openSync(fifo, fsConstants.O_RDWR);
      let proc: ReturnType<typeof Bun.spawn> | null = null;
      try {
        proc = Bun.spawn([process.execPath, "run", script], {
          cwd: ROOT,
          env: isolatedEnv(env),
          stdin: "ignore",
          stdout: fd,
          stderr: "pipe",
        });
        const deadline = Date.now() + 10000;
        while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(20);
        expect(existsSync(ready)).toBe(true);
        await Bun.sleep(200);
        expect(proc.exitCode).toBeNull();
        const sentAt = performance.now();
        proc.kill("SIGTERM");
        const outcome = await Promise.race([proc.exited, Bun.sleep(1000).then(() => "still alive" as const)]);
        const elapsed = performance.now() - sentAt;
        expect(outcome).toBe(143);
        expect(elapsed).toBeLessThan(1000);
        expect(await new Response(proc.stderr as ReadableStream).text()).toBe("losql: interrupted\n");
      } finally {
        if (proc && proc.exitCode === null && proc.signalCode === null) {
          proc.kill("SIGKILL");
          await proc.exited;
        }
        closeSync(fd);
      }
    },
    15000,
  );
});

describe("fix 6: a Statement with a NUL character (U+0000) is never run headless", () => {
  const NUL_MESSAGE = "the statement contains a NUL character (U+0000) and was not run";

  async function execWithStdin(dbPath: string, script: string): Promise<{ stdout: string; stderr: string; code: number }> {
    const proc = Bun.spawn([process.execPath, "run", join(ROOT, "src/main.ts"), "exec", "-c", dbPath, "-"], {
      cwd: ROOT,
      env: isolatedEnv(env),
      stdin: new Blob([script]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 15000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, code };
    } finally {
      clearTimeout(timer);
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      await proc.exited;
    }
  }

  function createOrders(dbPath: string): void {
    const db = new Database(dbPath, { create: true });
    try {
      db.prepare("create table orders (id integer primary key, n integer)").run();
      db.prepare("insert into orders values (1, 10), (2, 20), (3, 30), (4, 40), (5, 50)").run();
    } finally {
      db.close();
    }
  }

  function readOrders(dbPath: string): { id: number; n: number }[] {
    const db = new Database(dbPath, { readonly: true });
    try {
      return db.query("select id, n from orders order by id").all() as { id: number; n: number }[];
    } finally {
      db.close();
    }
  }

  const original = [
    { id: 1, n: 10 },
    { id: 2, n: 20 },
    { id: 3, n: 30 },
    { id: 4, n: 40 },
    { id: 5, n: 50 },
  ];

  test("a piped delete with a NUL before its where clause exits 1, says why on stderr and deletes nothing", async () => {
    const dbPath = join(dir, "nul.db");
    createOrders(dbPath);

    const r = await execWithStdin(dbPath, "delete from orders\u0000 where id = 1\n");

    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(NUL_MESSAGE);
    expect(readOrders(dbPath)).toEqual(original);
  }, 30000);

  test("with two Statements where the second holds the NUL, the first runs and the report names the second", async () => {
    const dbPath = join(dir, "nul2.db");
    createOrders(dbPath);

    const r = await execWithStdin(dbPath, "update orders set n = 99 where id = 2;\ndelete from orders\u0000 where id = 1;\n");

    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    const errLines = r.stderr.trimEnd().split("\n");
    expect(errLines[0]).toBe("losql: statement 2 of 2 failed");
    expect(r.stderr).toContain(NUL_MESSAGE);
    expect(readOrders(dbPath)).toEqual(original.map((row) => (row.id === 2 ? { id: 2, n: 99 } : row)));
  }, 30000);
});

describe("fix 7: a headless command ends at the first signal, whatever it is doing", () => {
  // About 2.5 s of SQLite work in one Statement that cannot be interrupted while it runs.
  const LONG_SQLITE =
    "with recursive c(x) as (select 1 union all select x+1 from c where x < 30000000) select count(*) as n from c";

  function spawnLosql(args: string[], stdin: "ignore" | "pipe" = "ignore") {
    return Bun.spawn([process.execPath, "run", join(ROOT, "src/main.ts"), ...args], {
      cwd: ROOT,
      env: isolatedEnv(env),
      stdin,
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  type Spawned = ReturnType<typeof spawnLosql>;
  type Finishable = { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number> };
  type Endable = Pick<Spawned, "exitCode" | "signalCode" | "kill" | "exited">;

  async function finish(proc: Finishable): Promise<{ stdout: string; stderr: string; code: number }> {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  }

  async function endProcess(proc: Endable | null): Promise<void> {
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGKILL");
      await proc.exited;
    }
  }

  function sqliteTableExists(dbPath: string, name: string): boolean {
    const db = new Database(dbPath, { readonly: true });
    try {
      return db.query("select 1 from sqlite_master where type = 'table' and name = ?").get(name) !== null;
    } finally {
      db.close();
    }
  }

  for (const [sig, code] of [["SIGTERM", 143], ["SIGINT", 130]] as const) {
    test(
      `SQLite, two Statements, one ${sig} while the first runs: ${code}, the line once, no output, the second never runs`,
      async () => {
        const dbPath = join(dir, `two-${sig}.db`);
        new Database(dbPath, { create: true }).close();
        let proc: Spawned | null = null;
        try {
          proc = spawnLosql(["exec", "-c", dbPath, `${LONG_SQLITE}; create table marker(x)`]);
          // Before or during the first Statement (a slow machine may still be connecting): the outcome is the same.
          await Bun.sleep(1000);
          expect(proc.exitCode).toBeNull();
          proc.kill(sig);
          const r = await finish(proc);
          expect(r.code).toBe(code);
          expect(r.stderr).toBe("losql: interrupted\n");
          expect(r.stdout).toBe("");
          expect(sqliteTableExists(dbPath, "marker")).toBe(false);
        } finally {
          await endProcess(proc);
        }
      },
      20000,
    );
  }

  test(
    "SQLite, a single long Statement and one SIGINT while it runs: when it ends, 130 with the line and no output",
    async () => {
      const dbPath = join(dir, "one.db");
      new Database(dbPath, { create: true }).close();
      let proc: Spawned | null = null;
      try {
        proc = spawnLosql(["exec", "-c", dbPath, LONG_SQLITE]);
        await Bun.sleep(1000);
        expect(proc.exitCode).toBeNull();
        proc.kill("SIGINT");
        const r = await finish(proc);
        expect(r.code).toBe(130);
        expect(r.stderr).toBe("losql: interrupted\n");
        expect(r.stdout).toBe("");
      } finally {
        await endProcess(proc);
      }
    },
    20000,
  );

  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    test(
      `standard input held open and never closed: one ${sig} ends the process within 3 seconds with ${code}`,
      async () => {
        let proc: ReturnType<typeof Bun.spawn> | null = null;
        try {
          proc = Bun.spawn([process.execPath, "run", join(ROOT, "src/main.ts"), "exec", "-c", "demo", "-"], {
            cwd: ROOT,
            env: isolatedEnv(env),
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
          });
          await Bun.sleep(1000);
          expect(proc.exitCode).toBeNull();
          const sentAt = performance.now();
          proc.kill(sig);
          const outcome = await Promise.race([proc.exited, Bun.sleep(3000).then(() => "still alive" as const)]);
          const elapsed = performance.now() - sentAt;
          expect(outcome).toBe(code);
          expect(elapsed).toBeLessThan(3000);
          expect(await new Response(proc.stderr as ReadableStream).text()).toBe("losql: interrupted\n");
          expect(await new Response(proc.stdout as ReadableStream).text()).toBe("");
        } finally {
          try {
            (proc?.stdin as import("bun").FileSink | undefined)?.end();
          } catch {
            // already closed
          }
          if (proc && proc.exitCode === null && proc.signalCode === null) {
            proc.kill("SIGKILL");
            await proc.exited;
          }
        }
      },
      15000,
    );
  }

  test(
    "Postgres connect to a server that never answers: one SIGTERM ends the process within 3 seconds with 143",
    async () => {
      // A listener of the test's own on a port the system assigns: it accepts and never answers.
      const sockets = new Set<import("bun").Socket<undefined>>();
      const server = Bun.listen<undefined>({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
          open: (s) => {
            sockets.add(s);
          },
          data: () => {},
          close: (s) => {
            sockets.delete(s);
          },
        },
      });
      let proc: Spawned | null = null;
      try {
        proc = spawnLosql(["exec", "-c", `postgres://u@127.0.0.1:${server.port}/db`, "select 1"]);
        const deadline = performance.now() + 5000;
        while (sockets.size === 0 && performance.now() < deadline) await Bun.sleep(20);
        expect(sockets.size).toBeGreaterThan(0);
        await Bun.sleep(200);
        expect(proc.exitCode).toBeNull();
        const sentAt = performance.now();
        proc.kill("SIGTERM");
        const outcome = await Promise.race([proc.exited, Bun.sleep(3000).then(() => "still alive" as const)]);
        const elapsed = performance.now() - sentAt;
        expect(outcome).toBe(143);
        expect(elapsed).toBeLessThan(3000);
        expect(await new Response(proc.stderr).text()).toBe("losql: interrupted\n");
        expect(await new Response(proc.stdout).text()).toBe("");
      } finally {
        await endProcess(proc);
        for (const s of sockets) s.end();
        server.stop(true);
      }
    },
    15000,
  );

  test.skipIf(!process.env.LOSQL_TEST_PG_URL)(
    "Postgres, select pg_sleep(30) and one SIGINT: gone within a second, the query cancelled on the server",
    async () => {
      const { default: postgres } = await import("postgres");
      const tag = `losql-signal-${process.pid}-${Date.now()}`;
      const watcher = postgres(process.env.LOSQL_TEST_PG_URL!, { max: 1, onnotice: () => {} });
      const running = async () => {
        const rows = await watcher.unsafe(
          "select count(*)::int as n from pg_stat_activity where state = 'active' and pid <> pg_backend_pid() and query like $1",
          [`%${tag}%`],
        );
        return (rows[0] as unknown as { n: number }).n;
      };
      let proc: Spawned | null = null;
      try {
        proc = spawnLosql(["exec", "-c", process.env.LOSQL_TEST_PG_URL!, `select pg_sleep(30) as slept, '${tag}' as tag`]);
        const deadline = performance.now() + 8000;
        while ((await running()) === 0 && performance.now() < deadline) await Bun.sleep(50);
        expect(await running()).toBe(1);
        const sentAt = performance.now();
        proc.kill("SIGINT");
        const outcome = await Promise.race([proc.exited, Bun.sleep(1000).then(() => "still alive" as const)]);
        const elapsed = performance.now() - sentAt;
        expect(outcome).toBe(130);
        expect(elapsed).toBeLessThan(1000);
        expect(await new Response(proc.stderr).text()).toBe("losql: interrupted\n");
        expect(await new Response(proc.stdout).text()).toBe("");
        const gone = performance.now() + 2000;
        while ((await running()) > 0 && performance.now() < gone) await Bun.sleep(50);
        expect(await running()).toBe(0);
      } finally {
        await endProcess(proc);
        await watcher.end({ timeout: 1 });
      }
    },
    20000,
  );

  test(
    "a script of 10,000 short SQLite Statements runs in about the time it took before",
    async () => {
      const dbPath = join(dir, "many.db");
      new Database(dbPath, { create: true }).close();
      const script = `${Array.from({ length: 10000 }, (_, i) => `select ${i} as n`).join(";\n")};\n`;
      const proc = Bun.spawn([process.execPath, "run", join(ROOT, "src/main.ts"), "exec", "-c", dbPath, "--format", "csv", "-"], {
        cwd: ROOT,
        env: isolatedEnv(env),
        stdin: new Blob([script]),
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        const start = performance.now();
        const r = await finish(proc);
        const elapsed = performance.now() - start;
        expect(r.code).toBe(0);
        expect(r.stderr).toBe("");
        expect(r.stdout).toBe("n\n9999\n");
        // Measured about 0.35 s for the whole process on the development machine; the bound is generous.
        expect(elapsed).toBeLessThan(5000);
      } finally {
        await endProcess(proc);
      }
    },
    20000,
  );
});

/**
 * Installs a fake `claude` into `binDir` that answers `--version` with 9.9.9 and runs `body` (the
 * text of a script) for every other call. Its shebang names the test's own bun, so PATH may hold
 * nothing else.
 */
async function installScriptClaude(binDir: string, body: string, onVersion = ""): Promise<void> {
  const { chmod, mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(binDir, { recursive: true });
  const path = join(binDir, "claude");
  await writeFile(
    path,
    [
      `#!${process.execPath}`,
      `if (process.argv.includes("--version")) { ${onVersion} console.log("9.9.9 (stub)"); process.exit(0); }`,
      body,
    ].join("\n"),
  );
  await chmod(path, 0o755);
}

/** A script line that prints `text` the way the Claude Code CLI prints a failed result, and exits 1. */
function claudeFails(text: string): string {
  const line = JSON.stringify({ type: "result", subtype: "error", is_error: true, result: text });
  return `console.log(${JSON.stringify(line)}); process.exit(1);`;
}

/** A script line that answers `reply` the way the Claude Code CLI prints a successful result. */
function claudeAnswers(reply: string): string {
  const assistant = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: reply }] } });
  const result = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: reply });
  return `console.log(${JSON.stringify(assistant)}); console.log(${JSON.stringify(result)});`;
}

async function writeConfig(config: unknown): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(env.LOSQL_CONFIG_DIR!, { recursive: true });
  await writeFile(join(env.LOSQL_CONFIG_DIR!, "config.json"), JSON.stringify(config));
}

describe("final fix 3: a Provider process does not inherit the variables a saved Connection reads its password from", () => {
  test("ask: neither the version call nor the Turn gets them; PATH and HOME are there", async () => {
    const envDir = join(dir, "envs");
    const { mkdir, readdir } = await import("node:fs/promises");
    await mkdir(envDir, { recursive: true });
    const dump = `require("node:fs").writeFileSync(${JSON.stringify(envDir)} + "/" + process.pid + "-" + (process.argv.includes("--version") ? "version" : "turn") + ".json", JSON.stringify(process.env));`;
    await installScriptClaude(
      join(dir, "bin"),
      `${dump}\n${claudeAnswers('{"action":"answer","message":"done"}')}`,
      dump,
    );
    await writeConfig({
      connections: [
        { name: "prod", url: "postgres://u:${FINAL_C1_DBPW}@127.0.0.1:54329/postgres" },
        { name: "replica", url: "postgres://${FINAL_C1_DBUSER}:${FINAL_C1_DBPW}@127.0.0.1:54329/postgres?sslpassword=${FINAL_C1_SSLPW}" },
      ],
    });

    const r = await losql(["ask", "-c", "demo", "--provider", "claude", "hello"], {
      env: { ...env, FINAL_C1_DBPW: "s3cret", FINAL_C1_DBUSER: "admin", FINAL_C1_SSLPW: "sslsecret", FINAL_C1_KEPT: "kept" },
    });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("done\n");

    const files = await readdir(envDir);
    expect(files.filter((f) => f.endsWith("-version.json")).length).toBeGreaterThanOrEqual(1);
    expect(files.filter((f) => f.endsWith("-turn.json"))).toHaveLength(1);
    for (const file of files) {
      const seen = JSON.parse(readFileSync(join(envDir, file), "utf8")) as Record<string, string>;
      expect(seen.FINAL_C1_DBPW).toBeUndefined();
      expect(seen.FINAL_C1_DBUSER).toBeUndefined();
      expect(seen.FINAL_C1_SSLPW).toBeUndefined();
      expect(seen.FINAL_C1_KEPT).toBe("kept");
      expect(seen.PATH).toBe(env.PATH);
      expect(seen.HOME).toBe(env.HOME);
    }
  });
});

describe("final fix 4: losql ask under a signal leaves no temporary directory behind", () => {
  for (const [signal, code, slowToEnd] of [
    ["SIGINT", 130, false],
    ["SIGTERM", 143, false],
    ["SIGINT", 130, true],
    ["SIGTERM", 143, true],
  ] as const) {
    const provider = slowToEnd ? "a Provider that does not end on SIGTERM" : "a Provider that sleeps";
    test(`${signal} during ask with ${provider}: exit ${code}, and no losql-agent-* directory is left in TMPDIR`, async () => {
      const { mkdir, readdir } = await import("node:fs/promises");
      const tmp = join(dir, "tmp");
      await mkdir(tmp, { recursive: true });
      const pidFile = join(dir, `claude-${signal}.pid`);
      if (slowToEnd) {
        await installScriptClaude(
          join(dir, "bin"),
          `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); await Bun.sleep(30000);`,
        );
      } else {
        await installSleepingStubClaude(join(dir, "bin"), pidFile, 30000);
      }

      const proc = Bun.spawn(
        [process.execPath, "run", join(ROOT, "src/main.ts"), "ask", "-c", "demo", "--provider", "claude", "slow question"],
        { cwd: ROOT, env: isolatedEnv({ ...env, TMPDIR: tmp }), stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      const childPid = Number(await waitForFile(pidFile));
      try {
        expect((await readdir(tmp)).filter((f) => f.startsWith("losql-agent-"))).toHaveLength(1);
        proc.kill(signal);
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect(exitCode).toBe(code);
        expect(stdout).toBe("");
        expect(stderr).toBe("losql: interrupted\n");
        expect((await readdir(tmp)).filter((f) => f.startsWith("losql-agent-"))).toEqual([]);
        expect(await waitForProcessDead(childPid, 2000)).toBe(true);
      } finally {
        proc.kill("SIGKILL");
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // already dead
        }
      }
    });
  }
});

describe("final fix 5: losql ask says what to do when a Provider fails", () => {
  const cases: [string, string, Record<string, unknown>, string][] = [
    [
      "not logged in",
      claudeFails("Invalid API key · Please run /login"),
      {},
      "losql: Invalid API key · Please run /login\nRun `claude` once in a terminal to log in, then try again.\n",
    ],
    [
      "out of quota",
      claudeFails("Claude AI usage limit reached|1794800000"),
      {},
      "losql: Claude AI usage limit reached|1794800000\nClaude Code has reached its usage limit. Try again later or switch provider with space p.\n",
    ],
    [
      "timed out",
      "await Bun.sleep(20000);",
      { agent: { stepTimeoutMs: 300 } },
      "losql: Claude Code did not answer in time\nClaude Code did not answer in time. Try again, or pick a faster model with space m.\n",
    ],
    [
      "an unusable reply",
      claudeAnswers('{"action":"dance"}'),
      {},
      "The reply could not be understood. Try again, or pick another model with space m.\n",
    ],
  ];

  test.each(cases)("%s: the message and the hint on standard error, exit code 1", async (_, body, config, expected) => {
    await installScriptClaude(join(dir, "bin"), body);
    await writeConfig(config);
    const r = await losql(["ask", "-c", "demo", "--provider", "claude", "hello"], { env });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    if (expected.startsWith("losql: ")) expect(r.stderr).toBe(expected);
    else {
      expect(r.stderr).toStartWith("losql: the agent sent an invalid reply twice: unknown action");
      expect(r.stderr).toEndWith(`\n${expected}`);
      expect(r.stderr.split("\n")).toHaveLength(3);
    }
  });

  test("not installed (found on PATH but it cannot be started): the message and the install hint", async () => {
    const { chmod, mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(dir, "bin"), { recursive: true });
    await writeFile(join(dir, "bin", "claude"), `#!${join(dir, "no-such-interpreter")}\n`);
    await chmod(join(dir, "bin", "claude"), 0o755);
    const r = await losql(["ask", "-c", "demo", "--provider", "claude", "hello"], { env });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      "losql: Claude Code could not be started: not found\nInstall Claude Code: https://claude.com/claude-code\n",
    );
  });
});
