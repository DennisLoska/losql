import { ProviderError } from "../errors";
import type {
  ProviderAdapter,
  ProviderCommand,
  ProviderEvent,
  ProviderRequest,
} from "./types";
import { hasCustomModel, isRecord, parseJsonLine } from "./util";

const MAX_PRINT_BYTES = 120_000;

export const antigravityAdapter: ProviderAdapter = {
  id: "antigravity",
  label: "Antigravity",
  binaries: ["antigravity", "agy"],
  installHint: "Install Antigravity: https://antigravity.google",
  staticModels: ["default"],
  streamingText: true,
  modelsArgs: ["models"],
  parseModels(stdout: string): string[] {
    const models: string[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const tabIndex = line.indexOf("\t");
      if (tabIndex > 0) {
        const model = line.slice(0, tabIndex).trim();
        if (model.length > 0) {
          models.push(model);
        }
      }
    }
    return models;
  },
  command(request: ProviderRequest): ProviderCommand {
    const fullPrompt = `${request.system}\n\n${request.prompt}`;
    const bytes = Buffer.byteLength(fullPrompt, "utf8");
    if (bytes > MAX_PRINT_BYTES) {
      throw new ProviderError("other", `the prompt is too large for Antigravity (${bytes} bytes)`);
    }
    const args = [`--print=${fullPrompt}`, "--mode", "plan", "--output-format", "stream-json"];
    if (hasCustomModel(request.model)) {
      args.push("--model", request.model);
    }
    return { args };
  },
  parse(line: string): ProviderEvent | null {
    const obj = parseJsonLine(line);
    if (!obj) return null;

    if (
      obj.event === "step_update" &&
      isRecord(obj.step_update) &&
      obj.step_update.step_type === "agent_response" &&
      typeof obj.step_update.text_delta === "string"
    ) {
      return { type: "text", text: obj.step_update.text_delta };
    }

    if (obj.event === "result" && isRecord(obj.result) && typeof obj.result.status === "string") {
      if (obj.result.status === "SUCCESS") {
        if (typeof obj.result.response === "string") {
          return { type: "final", text: obj.result.response };
        }
        return null;
      }
      const rawError = typeof obj.result.error === "string" ? obj.result.error : "";
      const firstLine = rawError.split(/\r?\n/)[0]?.trim() ?? "";
      return {
        type: "error",
        message: firstLine.length > 0 ? firstLine : "Antigravity failed",
      };
    }

    return null;
  },
};
