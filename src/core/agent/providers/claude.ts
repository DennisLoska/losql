import type {
  ProviderAdapter,
  ProviderCommand,
  ProviderEvent,
  ProviderRequest,
} from "./types";
import { hasCustomModel, isRecord, parseJsonLine } from "./util";

export const claudeAdapter: ProviderAdapter = {
  id: "claude",
  label: "Claude Code",
  binaries: ["claude"],
  installHint: "Install Claude Code: https://claude.com/claude-code",
  staticModels: ["default", "fable", "opus", "sonnet", "haiku"],
  streamingText: true,
  command(request: ProviderRequest): ProviderCommand {
    const args = [
      "-p",
      "--safe-mode",
      "--tools",
      "",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--output-format",
      "stream-json",
      "--verbose",
      "--system-prompt",
      request.system,
    ];
    if (hasCustomModel(request.model)) {
      args.push("--model", request.model);
    }
    return { args, stdin: request.prompt };
  },
  parse(line: string): ProviderEvent | null {
    const obj = parseJsonLine(line);
    if (!obj) return null;

    if (obj.type === "assistant" && isRecord(obj.message) && Array.isArray(obj.message.content)) {
      const texts: string[] = [];
      for (const block of obj.message.content) {
        if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        }
      }
      const joined = texts.join("");
      if (joined.length > 0) {
        return { type: "text", text: joined };
      }
      return null;
    }

    if (obj.type === "result") {
      const subtype = typeof obj.subtype === "string" ? obj.subtype : "";
      if (obj.is_error === true || subtype.startsWith("error")) {
        const errors = Array.isArray(obj.errors)
          ? obj.errors.filter((e): e is string => typeof e === "string" && e.trim().length > 0)
          : [];
        if (errors.length > 0) {
          return { type: "error", message: errors.join("; ") };
        }
        if (typeof obj.result === "string" && obj.result.trim().length > 0) {
          return { type: "error", message: obj.result };
        }
        const fallback = subtype.replaceAll("_", " ").trim();
        return { type: "error", message: fallback.length > 0 ? fallback : "error" };
      }
      if (typeof obj.result === "string") {
        return { type: "final", text: obj.result };
      }
    }

    return null;
  },
};
