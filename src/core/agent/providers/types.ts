import type { ProviderId } from "../../config";

export type ProviderEvent =
  | { type: "text"; text: string }
  | { type: "final"; text: string }
  | { type: "error"; message: string };

export interface ProviderRequest {
  prompt: string;
  system: string;
  model?: string | null;
}

export interface ProviderCommand {
  args: string[];
  stdin?: string;
}

export interface ProviderAdapter {
  id: ProviderId;
  label: string;
  binaries: string[];
  installHint: string;
  staticModels: string[];
  streamingText?: boolean;
  modelsArgs?: string[];
  parseModels?(stdout: string): string[];
  command(request: ProviderRequest): ProviderCommand;
  parse(line: string): ProviderEvent | null;
}
