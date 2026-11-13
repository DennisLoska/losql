import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { PROVIDERS } from "./index";
import type { ProviderAdapter, ProviderEvent } from "./types";

const FIXTURES = join(import.meta.dir, "..", "..", "..", "..", "test", "fixtures", "providers");
const REPLY = '{"action":"answer","message":"ok"}';

async function events(adapter: ProviderAdapter, file: string): Promise<ProviderEvent[]> {
  const text = await Bun.file(join(FIXTURES, file)).text();
  return text.split("\n").map((line) => adapter.parse(line)).filter((e): e is ProviderEvent => e !== null);
}

describe("parse, against captured output", () => {
  test("claude success", async () => {
    expect(await events(PROVIDERS.claude, "claude.success.ndjson")).toEqual([
      { type: "text", text: REPLY },
      { type: "final", text: REPLY },
    ]);
  });

  test("claude error", async () => {
    const all = await events(PROVIDERS.claude, "claude.error.ndjson");
    expect(all[all.length - 1]).toEqual({
      type: "error",
      message: "There's an issue with the selected model (nope-model). It may not exist or you may not have access to it.",
    });
  });

  test("claude error result message sources (errors array, result string, subtype)", () => {
    expect(
      PROVIDERS.claude.parse(
        JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: false,
          errors: ["first error", "second error"],
          result: "ignored result",
        }),
      ),
    ).toEqual({
      type: "error",
      message: "first error; second error",
    });

    expect(
      PROVIDERS.claude.parse(
        JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: false,
          errors: [],
          result: "result message text",
        }),
      ),
    ).toEqual({
      type: "error",
      message: "result message text",
    });

    expect(
      PROVIDERS.claude.parse(
        JSON.stringify({
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          result: "   ",
        }),
      ),
    ).toEqual({
      type: "error",
      message: "error max turns",
    });

    expect(
      PROVIDERS.claude.parse(
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
        }),
      ),
    ).toBeNull();
  });

  test("codex success", async () => {
    expect(await events(PROVIDERS.codex, "codex.success.ndjson")).toEqual([{ type: "text", text: REPLY }]);
  });

  test("codex error", async () => {
    const all = await events(PROVIDERS.codex, "codex.error.ndjson");
    expect(all.length).toBeGreaterThan(0);
    for (const e of all) {
      expect(e.type).toBe("error");
      expect((e as { message: string }).message).toContain("hit your usage limit");
    }
  });

  test("opencode success", async () => {
    expect(await events(PROVIDERS.opencode, "opencode.success.ndjson")).toEqual([{ type: "text", text: REPLY }]);
  });

  test("opencode error", async () => {
    expect(await events(PROVIDERS.opencode, "opencode.error.ndjson")).toEqual([
      { type: "error", message: "Model unavailable: nope/nope" },
    ]);
  });

  test("antigravity success", async () => {
    const all = await events(PROVIDERS.antigravity, "antigravity.success.ndjson");
    const text = all.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");
    expect(text.trim()).toBe(REPLY);
    expect(all[all.length - 1]).toEqual({ type: "final", text: REPLY + "\n" });
  });

  test("antigravity error", async () => {
    const all = await events(PROVIDERS.antigravity, "antigravity.error.ndjson");
    expect(all.length).toBe(1);
    expect(all[0]!.type).toBe("error");
    expect((all[0] as { message: string }).message).toStartWith('invalid model selection (--model "nope-model"');
  });

  test("parse never throws and ignores what it does not know", () => {
    for (const adapter of Object.values(PROVIDERS)) {
      for (const line of ["", "   ", "not json", "{", "[]", "null", '{"type":"unknown"}', '{"event":"unknown"}', '{"type":"text"}', '{"type":"item.completed"}']) {
        expect(adapter.parse(line)).toBeNull();
      }
    }
  });
});

describe("command", () => {
  test("claude", () => {
    expect(PROVIDERS.claude.command({ prompt: "P", system: "S", model: "haiku" })).toEqual({
      args: [
        "-p", "--safe-mode", "--tools", "", "--disable-slash-commands", "--no-session-persistence",
        "--output-format", "stream-json", "--verbose", "--system-prompt", "S", "--model", "haiku",
      ],
      stdin: "P",
    });
    expect(PROVIDERS.claude.command({ prompt: "P", system: "S" }).args).not.toContain("--model");
    expect(PROVIDERS.claude.command({ prompt: "P", system: "S", model: "default" }).args).not.toContain("--model");
    expect(PROVIDERS.claude.command({ prompt: "P", system: "S", model: null }).args).not.toContain("--model");
  });

  test("codex", () => {
    expect(PROVIDERS.codex.command({ prompt: "P", system: "S" })).toEqual({
      args: ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "-"],
      stdin: "S\n\nP",
    });
    expect(PROVIDERS.codex.command({ prompt: "P", system: "S", model: "gpt-x" }).args).toEqual([
      "exec", "--json", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "-m", "gpt-x", "-",
    ]);
  });

  test("opencode", () => {
    expect(PROVIDERS.opencode.command({ prompt: "P", system: "S", model: "github-copilot/claude-haiku-5.5" })).toEqual({
      args: ["run", "--format", "json", "--agent", "plan", "-m", "github-copilot/claude-haiku-5.5"],
      stdin: "S\n\nP",
    });
  });

  test("antigravity passes the prompt as an argument", () => {
    expect(PROVIDERS.antigravity.command({ prompt: "P", system: "S", model: "gemini-3.8-flash-low" })).toEqual({
      args: ["--print=S\n\nP", "--mode", "plan", "--output-format", "stream-json", "--model", "gemini-3.8-flash-low"],
    });
  });

  test("antigravity refuses a prompt too large for an argument", () => {
    expect(() => PROVIDERS.antigravity.command({ prompt: "x".repeat(130_000), system: "S" })).toThrow("too large");
  });
});

describe("adapter metadata", () => {
  test("ids, labels and binaries", () => {
    expect(Object.keys(PROVIDERS)).toEqual(["claude", "codex", "opencode", "antigravity"]);
    expect(Object.values(PROVIDERS).map((p) => [p.id, p.label, p.binaries])).toEqual([
      ["claude", "Claude Code", ["claude"]],
      ["codex", "Codex", ["codex"]],
      ["opencode", "OpenCode", ["opencode"]],
      ["antigravity", "Antigravity", ["antigravity", "agy"]],
    ]);
    for (const p of Object.values(PROVIDERS)) {
      expect(p.staticModels[0]).toBe("default");
      expect(p.installHint.length).toBeGreaterThan(10);
    }
    expect(PROVIDERS.claude.staticModels).toEqual(["default", "fable", "opus", "sonnet", "haiku"]);
  });

  test("model lists are parsed from captured output", async () => {
    const opencode = await Bun.file(join(FIXTURES, "opencode.models.txt")).text();
    expect(PROVIDERS.opencode.parseModels!(opencode).slice(0, 2)).toEqual(["github-copilot/claude-haiku-4.5", "github-copilot/claude-haiku-5.5"]);
    const agy = await Bun.file(join(FIXTURES, "antigravity.models.txt")).text();
    expect(PROVIDERS.antigravity.parseModels!(agy).slice(0, 2)).toEqual(["gemini-4-carbon-medium", "gemini-4-carbon-high"]);
    expect(PROVIDERS.antigravity.parseModels!("Fetching available models...\n\n")).toEqual([]);
  });

  test("layering: errors.ts and providers/util.ts exports, and providers/index.ts does not re-export runtime helpers", async () => {
    const errorsMod = await import("../errors");
    const runMod = await import("../run");
    const utilMod = await import("./util");
    const indexMod = await import("./index");
    const typesMod = await import("./types");

    expect(errorsMod.ProviderError).toBe(runMod.ProviderError);
    expect(typeof utilMod.hasCustomModel).toBe("function");
    expect(typeof utilMod.isRecord).toBe("function");
    expect(typeof utilMod.parseJsonLine).toBe("function");

    expect("hasCustomModel" in indexMod).toBe(false);
    expect("isRecord" in indexMod).toBe(false);
    expect("parseJsonLine" in indexMod).toBe(false);
    expect("hasCustomModel" in typesMod).toBe(false);
    expect("isRecord" in typesMod).toBe(false);
    expect("parseJsonLine" in typesMod).toBe(false);
  });
});
