import type {
  ProviderAdapter,
  ProviderCommand,
  ProviderEvent,
  ProviderRequest,
} from "./types";
import { hasCustomModel, isRecord, parseJsonLine } from "./util";

export const codexAdapter: ProviderAdapter = {
  id: "codex",
  label: "Codex",
  binaries: ["codex"],
  installHint: "Install Codex: npm install -g @openai/codex",
  staticModels: ["default"],
  command(request: ProviderRequest): ProviderCommand {
    const args = ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only"];
    if (hasCustomModel(request.model)) {
      args.push("-m", request.model);
    }
    args.push("-");
    return {
      args,
      stdin: `${request.system}\n\n${request.prompt}`,
    };
  },
  parse(line: string): ProviderEvent | null {
    const obj = parseJsonLine(line);
    if (!obj) return null;

    if (
      obj.type === "item.completed" &&
      isRecord(obj.item) &&
      obj.item.type === "agent_message" &&
      typeof obj.item.text === "string"
    ) {
      return { type: "text", text: obj.item.text };
    }

    if (obj.type === "error" && typeof obj.message === "string") {
      return { type: "error", message: obj.message };
    }

    if (obj.type === "turn.failed" && isRecord(obj.error) && typeof obj.error.message === "string") {
      return { type: "error", message: obj.error.message };
    }

    return null;
  },
};
