import type {
  ProviderAdapter,
  ProviderCommand,
  ProviderEvent,
  ProviderRequest,
} from "./types";
import { hasCustomModel, isRecord, parseJsonLine } from "./util";

export const opencodeAdapter: ProviderAdapter = {
  id: "opencode",
  label: "OpenCode",
  binaries: ["opencode"],
  installHint: "Install OpenCode: https://opencode.ai",
  staticModels: ["default"],
  modelsArgs: ["models"],
  parseModels(stdout: string): string[] {
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  },
  command(request: ProviderRequest): ProviderCommand {
    const args = ["run", "--format", "json", "--agent", "plan"];
    if (hasCustomModel(request.model)) {
      args.push("-m", request.model);
    }
    return {
      args,
      stdin: `${request.system}\n\n${request.prompt}`,
    };
  },
  parse(line: string): ProviderEvent | null {
    const obj = parseJsonLine(line);
    if (!obj) return null;

    if (obj.type === "text" && isRecord(obj.part) && typeof obj.part.text === "string") {
      return { type: "text", text: obj.part.text };
    }

    if (obj.type === "error" && isRecord(obj.error) && typeof obj.error.message === "string") {
      return { type: "error", message: obj.error.message };
    }

    return null;
  },
};
