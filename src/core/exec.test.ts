import { expect, test } from "bun:test";
import { bunExec } from "./exec";

test("captures stdout, stderr, the exit code and lines as they arrive", async () => {
  const lines: string[] = [];
  const r = await bunExec({
    cmd: ["sh", "-c", "cat; echo err >&2; exit 3"],
    stdin: "hello\nworld\n",
    onStdoutLine: (line) => lines.push(line),
  });
  expect(r).toEqual({ code: 3, stdout: "hello\nworld\n", stderr: "err\n", timedOut: false, aborted: false });
  expect(lines).toEqual(["hello", "world"]);
});

test("a final line without a newline is still delivered", async () => {
  const lines: string[] = [];
  await bunExec({ cmd: ["printf", "a\\nb"], onStdoutLine: (line) => lines.push(line) });
  expect(lines).toEqual(["a", "b"]);
});

test("cwd and env are passed", async () => {
  const r = await bunExec({ cmd: ["sh", "-c", "pwd; echo $LOSQL_X"], cwd: "/tmp", env: { ...process.env, LOSQL_X: "42" } });
  expect(r.stdout).toBe("/tmp\n42\n");
});

test("a timeout kills the process", async () => {
  const started = Date.now();
  const r = await bunExec({ cmd: ["sleep", "5"], timeoutMs: 100 });
  expect(r.timedOut).toBe(true);
  expect(Date.now() - started).toBeLessThan(2000);
});

test("abort kills the process", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const r = await bunExec({ cmd: ["sleep", "5"], signal: controller.signal });
  expect(r.aborted).toBe(true);
});

test("a missing binary rejects", async () => {
  await expect(bunExec({ cmd: ["/nonexistent/losql-no-such-binary"] })).rejects.toThrow();
});

test("a child that exits before reading a large stdin does not crash the caller", async () => {
  const r = await bunExec({ cmd: ["true"], stdin: "x".repeat(5_000_000) });
  expect(r.code).toBe(0);
  await new Promise((resolve) => setTimeout(resolve, 100)); // an unhandled EPIPE would surface here
});

test("a timeout is enforced even when the child ignores SIGTERM", async () => {
  const started = Date.now();
  const r = await bunExec({ cmd: ["sh", "-c", "trap '' TERM; sleep 6"], timeoutMs: 200 });
  expect(r.timedOut).toBe(true);
  expect(Date.now() - started).toBeLessThan(4000);
});

test("a timeout does not wait for a grandchild that keeps the pipes open", async () => {
  const started = Date.now();
  const r = await bunExec({ cmd: ["sh", "-c", "sleep 6 & wait"], timeoutMs: 200 });
  expect(r.timedOut).toBe(true);
  expect(Date.now() - started).toBeLessThan(4000);
});

test("a throwing line callback stops the child and rejects with that error", async () => {
  const started = Date.now();
  await expect(
    bunExec({
      cmd: ["sh", "-c", "echo one; sleep 6"],
      onStdoutLine: () => {
        throw new Error("bad line");
      },
    }),
  ).rejects.toThrow("bad line");
  expect(Date.now() - started).toBeLessThan(4000);
});

test("an already aborted signal stops the child at once", async () => {
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  const r = await bunExec({ cmd: ["sleep", "5"], signal: controller.signal });
  expect(r.aborted).toBe(true);
  expect(Date.now() - started).toBeLessThan(3000);
});

test("maxOutputBytes stops a runaway child and sets outputLimitHit", async () => {
  const started = Date.now();
  const r = await bunExec({
    cmd: ["sh", "-c", "yes x | tr -d '\\n'"],
    maxOutputBytes: 64 * 1024,
  });
  expect(r.outputLimitHit).toBe(true);
  expect(r.timedOut).toBe(false);
  expect(Date.now() - started).toBeLessThan(2000);
});

test("a 4 MiB single line is handled in linear time", async () => {
  const runSize = async (mib: number): Promise<number> => {
    const lines: string[] = [];
    const t0 = performance.now();
    await bunExec({
      cmd: [
        process.execPath,
        "-e",
        `const chunk = Buffer.alloc(4096, 97); for (let i = 0; i < ${mib * 256}; i++) process.stdout.write(chunk); process.stdout.write("\\ndone\\n");`,
      ],
      onStdoutLine: (l) => lines.push(l),
    });
    const elapsed = performance.now() - t0;
    expect(lines.length).toBe(2);
    expect(lines[0]!.length).toBe(mib * 1024 * 1024);
    expect(lines[1]).toBe("done");
    return elapsed;
  };

  // Warmup
  await runSize(1);
  const t1 = await runSize(1);
  const t4 = await runSize(4);
  expect(t4).toBeLessThan(t1 * 6);
});

test("discardOutput resolves as soon as the child exits even if a background grandchild holds stdout open", async () => {
  const started = Date.now();
  const r = await bunExec({
    cmd: ["sh", "-c", "echo ignored; echo ignored_err >&2; sleep 5 & exit 0"],
    discardOutput: true,
    timeoutMs: 2000,
  });
  const elapsed = Date.now() - started;
  expect(elapsed).toBeLessThan(400);
  expect(r).toEqual({
    code: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    aborted: false,
  });
});


