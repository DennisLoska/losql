import type { ProviderId } from "../../config";
import { antigravityAdapter } from "./antigravity";
import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import { opencodeAdapter } from "./opencode";
import type { ProviderAdapter } from "./types";

export const PROVIDERS: Record<ProviderId, ProviderAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  opencode: opencodeAdapter,
  antigravity: antigravityAdapter,
};

export * from "./types";
