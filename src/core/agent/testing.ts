import type { Exec, ExecRequest } from "../exec";

// A test helper: imported by tests only, so it never ends up in the built binary. It imports nothing from
// src/tui or @opentui, so that tests of src/cli and src/core can use it.

export type FakeReply = string | { error: string } | { hold: Promise<void>; reply: string };

/**
 * A stand-in for the Claude Code CLI: `which("claude")` finds it, `--version` answers 9.9.9, and every
 * other call answers with the next reply in the stream-json shape of the real CLI. The last reply repeats.
 */
export function fakeClaude(replies: FakeReply[]): {
  which: (bin: string) => string | null;
  exec: Exec;
  prompts: string[];
  requests: ExecRequest[];
} {
  const prompts: string[] = [];
  const requests: ExecRequest[] = [];
  let next = 0;
  const which = (bin: string) => (bin === "claude" ? "/fake/bin/claude" : null);
  const exec: Exec = async (request) => {
    const base = { code: 0, stdout: "", stderr: "", timedOut: false, aborted: false };
    if (request.cmd[0] !== "/fake/bin/claude") return { ...base, code: 127, stderr: "not found" };
    if (request.cmd.includes("--version")) return { ...base, stdout: "9.9.9 (fake)\n" };
    requests.push(request);
    prompts.push(request.stdin ?? "");
    const reply = replies[Math.min(next++, replies.length - 1)]!;
    if (typeof reply === "object" && "hold" in reply) {
      const aborted = await new Promise<boolean>((resolve) => {
        request.signal?.addEventListener("abort", () => resolve(true));
        void reply.hold.then(() => resolve(false));
      });
      if (aborted) return { ...base, code: null, aborted: true };
    }
    const failed = typeof reply === "object" && "error" in reply;
    const text = typeof reply === "string" ? reply : "error" in reply ? reply.error : reply.reply;
    if (!failed) request.onStdoutLine?.(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }));
    request.onStdoutLine?.(JSON.stringify({ type: "result", subtype: failed ? "error" : "success", is_error: failed, result: text }));
    return { ...base, code: failed ? 1 : 0 };
  };
  return { which, exec, prompts, requests };
}

