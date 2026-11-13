import { expect, test } from "bun:test";
import type { ExecRequest, ExecResult } from "./exec";
import { copyToClipboard, MAX_OSC52_BASE64, osc52 } from "./clipboard";

const ok: ExecResult = { code: 0, stdout: "", stderr: "", timedOut: false, aborted: false };

test("osc52 encodes UTF-8 as base64", () => {
  expect(osc52("hi")).toBe("\x1b]52;c;aGk=\x07");
  expect(osc52("é")).toBe("\x1b]52;c;w6k=\x07");
});

test("copyToClipboard writes OSC 52 and pipes to the first available tool", async () => {
  const written: string[] = [];
  const calls: ExecRequest[] = [];
  await copyToClipboard("hi", {
    write: (data) => written.push(data),
    which: (bin) => (bin === "xclip" ? "/usr/bin/xclip" : null),
    exec: async (request) => { calls.push(request); return ok; },
  });
  expect(written).toEqual(["\x1b]52;c;aGk=\x07"]);
  expect(calls.length).toBe(1);
  expect(calls[0]!.cmd).toEqual(["/usr/bin/xclip", "-selection", "clipboard"]);
  expect(calls[0]!.stdin).toBe("hi");
});

test("wl-copy is preferred, and a tool failure is not an error", async () => {
  const calls: string[][] = [];
  await copyToClipboard("x", {
    write: () => {},
    which: (bin) => `/usr/bin/${bin}`,
    exec: async (request) => { calls.push(request.cmd); throw new Error("no display"); },
  });
  expect(calls).toEqual([["/usr/bin/wl-copy"], ["/usr/bin/xclip", "-selection", "clipboard"], ["/usr/bin/pbcopy"]]);
});

test("without a tool only OSC 52 is written", async () => {
  const written: string[] = [];
  let ran = 0;
  await copyToClipboard("x", { write: (d) => written.push(d), which: () => null, exec: async () => { ran++; return ok; } });
  expect(written.length).toBe(1);
  expect(ran).toBe(0);
});

test("base64 exceeding MAX_OSC52_BASE64 skips OSC 52 write but still calls external tool", async () => {
  expect(MAX_OSC52_BASE64).toBe(100000);
  const longText = "a".repeat(80000); // base64 is 106,668 chars > 100,000
  const written: string[] = [];
  const calls: ExecRequest[] = [];
  await copyToClipboard(longText, {
    write: (d) => written.push(d),
    which: (bin) => (bin === "wl-copy" ? "/usr/bin/wl-copy" : null),
    exec: async (req) => {
      calls.push(req);
      return ok;
    },
  });
  expect(written).toEqual([]);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.cmd).toEqual(["/usr/bin/wl-copy"]);
});

test("the sequence copyToClipboard writes is osc52 of the value, up to MAX_OSC52_BASE64 characters of base64", async () => {
  const copy = async (text: string) => {
    const written: string[] = [];
    await copyToClipboard(text, { write: (d) => written.push(d), which: () => null, exec: async () => ok });
    return written;
  };
  expect(await copy("é😀\u{d800}")).toEqual([osc52("é😀\u{d800}")]);
  expect(await copy("a".repeat(75000))).toEqual([osc52("a".repeat(75000))]); // base64 is exactly 100,000 chars
  expect(await copy("a".repeat(75001))).toEqual([]); // base64 is 100,004 chars
  expect(await copy("é".repeat(37500))).toEqual([osc52("é".repeat(37500))]); // 75,000 bytes of UTF-8
  expect(await copy("é".repeat(37501))).toEqual([]);
});

test("falls through to the next installed tool on non-zero exit or timeout, and stops once one succeeds", async () => {
  const calls1: ExecRequest[] = [];
  await copyToClipboard("é😀", {
    write: () => {},
    which: (bin) => (bin === "wl-copy" || bin === "xclip" ? `/usr/bin/${bin}` : null),
    exec: async (req) => {
      calls1.push(req);
      if (req.cmd[0] === "/usr/bin/wl-copy") {
        return { ...ok, code: 1 };
      }
      return ok;
    },
  });
  expect(calls1.map((c) => c.cmd)).toEqual([
    ["/usr/bin/wl-copy"],
    ["/usr/bin/xclip", "-selection", "clipboard"],
  ]);
  for (const call of calls1) {
    expect(call.timeoutMs).toBe(2000);
    expect(call.stdin).toBe("é😀");
  }

  const calls2: ExecRequest[] = [];
  await copyToClipboard("é😀", {
    write: () => {},
    which: (bin) => `/usr/bin/${bin}`,
    exec: async (req) => {
      calls2.push(req);
      return ok;
    },
  });
  expect(calls2.map((c) => c.cmd)).toEqual([["/usr/bin/wl-copy"]]);
  expect(calls2[0]!.timeoutMs).toBe(2000);
  expect(calls2[0]!.stdin).toBe("é😀");

  const calls3: ExecRequest[] = [];
  await copyToClipboard("é😀", {
    write: () => {},
    which: (bin) => (bin === "wl-copy" || bin === "xclip" ? `/usr/bin/${bin}` : null),
    exec: async (req) => {
      calls3.push(req);
      if (req.cmd[0] === "/usr/bin/wl-copy") {
        return { ...ok, timedOut: true };
      }
      return ok;
    },
  });
  expect(calls3.map((c) => c.cmd)).toEqual([
    ["/usr/bin/wl-copy"],
    ["/usr/bin/xclip", "-selection", "clipboard"],
  ]);
});

test("copyToClipboard swallows exceptions from write and which", async () => {
  const calls: ExecRequest[] = [];
  await expect(
    copyToClipboard("hi", {
      write: () => {
        throw new Error("write failed");
      },
      which: (bin) => {
        if (bin === "wl-copy") throw new Error("which failed");
        if (bin === "xclip") return "/usr/bin/xclip";
        return null;
      },
      exec: async (req) => {
        calls.push(req);
        return ok;
      },
    }),
  ).resolves.toEqual({ ok: true });
  expect(calls.map((c) => c.cmd)).toEqual([["/usr/bin/xclip", "-selection", "clipboard"]]);
});

test("every clipboard tool call carries discardOutput: true", async () => {
  const calls: ExecRequest[] = [];
  await copyToClipboard("hello", {
    write: () => {},
    which: (bin) => `/usr/bin/${bin}`,
    exec: async (req) => {
      calls.push(req);
      return { ...ok, code: 1 };
    },
  });
  expect(calls.length).toBe(3);
  for (const call of calls) {
    expect(call.discardOutput).toBe(true);
  }
});

test("copyToClipboard resolves to { ok: true } when OSC 52 sequence is written", async () => {
  const written: string[] = [];
  const res = await copyToClipboard("hi", {
    write: (d) => written.push(d),
    which: () => null,
    exec: async () => ok,
  });
  expect(res).toEqual({ ok: true });
  expect(written).toEqual([osc52("hi")]);
});

test("copyToClipboard resolves to { ok: true } when value is too large for OSC 52 and a tool accepts", async () => {
  const longText = "a".repeat(80000);
  const res = await copyToClipboard(longText, {
    write: () => {},
    which: (bin) => (bin === "wl-copy" ? "/usr/bin/wl-copy" : null),
    exec: async () => ok,
  });
  expect(res).toEqual({ ok: true });
});

test("copyToClipboard resolves to { ok: false, reason } when value is too large for OSC 52 and no tool is found", async () => {
  const longText = "a".repeat(80000);
  const res = await copyToClipboard(longText, {
    write: () => {},
    which: () => null,
    exec: async () => ok,
  });
  expect(res).toEqual({
    ok: false,
    reason: "the value is too large for the terminal clipboard and no clipboard tool was found",
  });
});

test("copyToClipboard resolves to { ok: false, reason } when tool exits non-zero and OSC 52 was not written", async () => {
  const longText = "a".repeat(80000);
  const res = await copyToClipboard(longText, {
    write: () => {},
    which: (bin) => (bin === "xclip" ? "/usr/bin/xclip" : null),
    exec: async () => ({
      code: 1,
      stdout: "",
      stderr: "Error: Can't open display: (null)\nmore details",
      timedOut: false,
      aborted: false,
    }),
  });
  expect(res).toEqual({
    ok: false,
    reason: "xclip failed: Error: Can't open display: (null)",
  });
});

test("copyToClipboard resolves to { ok: false, reason } when tool times out and OSC 52 was not written", async () => {
  const longText = "a".repeat(80000);
  const res = await copyToClipboard(longText, {
    write: () => {},
    which: (bin) => (bin === "wl-copy" ? "/usr/bin/wl-copy" : null),
    exec: async () => ({
      code: null,
      stdout: "",
      stderr: "",
      timedOut: true,
      aborted: false,
    }),
  });
  expect(res).toEqual({
    ok: false,
    reason: "wl-copy timed out",
  });
});

test("copyToClipboard resolves to { ok: false, reason } when the terminal write failed and no tool is found", async () => {
  const res = await copyToClipboard("hi", {
    write: () => {
      throw new Error("EPIPE");
    },
    which: () => null,
    exec: async () => ok,
  });
  expect(res).toEqual({
    ok: false,
    reason: "the terminal did not accept it and no clipboard tool was found",
  });
});

test("a lookup that throws counts as no tool found", async () => {
  const res = await copyToClipboard("a".repeat(80000), {
    write: () => {},
    which: () => {
      throw new Error("which failed");
    },
    exec: async () => ok,
  });
  expect(res).toEqual({
    ok: false,
    reason: "the value is too large for the terminal clipboard and no clipboard tool was found",
  });
});

test("the sequence written is a copy even when every tool fails", async () => {
  const res = await copyToClipboard("hi", {
    write: () => {},
    which: (bin) => `/usr/bin/${bin}`,
    exec: async () => ({ ...ok, code: 1, stderr: "no display" }),
  });
  expect(res).toEqual({ ok: true });
});

test("the reason names the tool tried last", async () => {
  const res = await copyToClipboard("hi", {
    write: () => {
      throw new Error("closed");
    },
    which: (bin) => (bin === "pbcopy" ? null : `/usr/bin/${bin}`),
    exec: async (req) =>
      req.cmd[0] === "/usr/bin/wl-copy" ? { ...ok, code: 1, stderr: "wl-copy broke" } : { ...ok, code: null, timedOut: true },
  });
  expect(res).toEqual({ ok: false, reason: "xclip timed out" });
});

test("a tool that throws, or exits non-zero without saying why, is reported", async () => {
  const thrown = await copyToClipboard("hi", {
    write: () => {
      throw new Error("closed");
    },
    which: (bin) => (bin === "xclip" ? "/usr/bin/xclip" : null),
    exec: async () => {
      throw new Error("spawn failed: ENOENT\nat spawn");
    },
  });
  expect(thrown).toEqual({ ok: false, reason: "xclip failed: spawn failed: ENOENT" });

  const thrownValue = await copyToClipboard("hi", {
    write: () => {
      throw new Error("closed");
    },
    which: (bin) => (bin === "xclip" ? "/usr/bin/xclip" : null),
    exec: async () => {
      throw "boom";
    },
  });
  expect(thrownValue).toEqual({ ok: false, reason: "xclip failed: boom" });

  const silent = await copyToClipboard("hi", {
    write: () => {
      throw new Error("closed");
    },
    which: (bin) => (bin === "xclip" ? "/usr/bin/xclip" : null),
    exec: async () => ({ ...ok, code: 2 }),
  });
  expect(silent).toEqual({ ok: false, reason: "xclip failed: exit code 2" });
});

test("the reason is at most 200 characters and never contains the copied value", async () => {
  const secret = "s3cr3t-password-value";
  const long = await copyToClipboard(secret, {
    write: () => {
      throw new Error("closed");
    },
    which: (bin) => (bin === "xclip" ? "/usr/bin/xclip" : null),
    exec: async () => ({ ...ok, code: 1, stderr: `${"x".repeat(500)}\nsecond line` }),
  });
  expect(long.ok).toBe(false);
  if (!long.ok) {
    expect(long.reason.length).toBeLessThanOrEqual(200);
    expect(long.reason.startsWith("xclip failed: xxx")).toBe(true);
  }

  const echoed = await copyToClipboard(secret, {
    write: () => {
      throw new Error("closed");
    },
    which: (bin) => (bin === "xclip" ? "/usr/bin/xclip" : null),
    exec: async () => ({ ...ok, code: 1, stderr: `cannot copy ${secret}: no display` }),
  });
  expect(echoed).toEqual({ ok: false, reason: "xclip failed: exit code 1" });

  const thrown = await copyToClipboard(secret, {
    write: () => {
      throw new Error("closed");
    },
    which: (bin) => (bin === "xclip" ? "/usr/bin/xclip" : null),
    exec: async () => {
      throw new Error(`bad input ${secret}`);
    },
  });
  expect(thrown).toEqual({ ok: false, reason: "xclip failed" });
});
