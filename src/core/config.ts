import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { Paths } from "./paths";

export type ProviderId = "claude" | "codex" | "opencode" | "antigravity";
export const PROVIDER_IDS: readonly ProviderId[] = ["claude", "codex", "opencode", "antigravity"];

export interface SavedConnection {
  name: string;
  url: string;
}

export interface Config {
  theme: string;
  mode: "dark" | "light";
  transparent: boolean;
  animations: boolean;
  leader: string;
  connections: SavedConnection[];
  results: { maxRows: number; jsonMaxRows: number; peekRows: number };
  agent: {
    provider: ProviderId | null;
    model: string | null;
    dataAccess: "rows" | "schema";
    maxSteps: number;
    stepTimeoutMs: number;
  };
}

export const DEFAULT_CONFIG: Config = {
  theme: "tokyonight",
  mode: "dark",
  transparent: false,
  animations: true,
  leader: "space",
  connections: [],
  results: { maxRows: 1000, jsonMaxRows: 200, peekRows: 100 },
  agent: {
    provider: null,
    model: null,
    dataAccess: "rows",
    maxSteps: 8,
    stepTimeoutMs: 120000,
  },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function parseConfig(raw: unknown): { config: Config; warnings: string[] } {
  const config: Config = {
    theme: DEFAULT_CONFIG.theme,
    mode: DEFAULT_CONFIG.mode,
    transparent: DEFAULT_CONFIG.transparent,
    animations: DEFAULT_CONFIG.animations,
    leader: DEFAULT_CONFIG.leader,
    connections: [],
    results: { ...DEFAULT_CONFIG.results },
    agent: { ...DEFAULT_CONFIG.agent },
  };
  const warnings: string[] = [];

  if (!isPlainObject(raw)) {
    warnings.push("config: expected a JSON object");
    return { config, warnings };
  }

  if (raw.theme !== undefined) {
    if (isNonEmptyString(raw.theme)) {
      config.theme = raw.theme;
    } else {
      warnings.push('config: "theme" must be a non-empty string');
    }
  }

  if (raw.mode !== undefined) {
    if (raw.mode === "dark" || raw.mode === "light") {
      config.mode = raw.mode;
    } else {
      warnings.push('config: "mode" must be "dark" or "light"');
    }
  }

  if (raw.transparent !== undefined) {
    if (typeof raw.transparent === "boolean") {
      config.transparent = raw.transparent;
    } else {
      warnings.push('config: "transparent" must be true or false');
    }
  }

  if (raw.animations !== undefined) {
    if (typeof raw.animations === "boolean") {
      config.animations = raw.animations;
    } else {
      warnings.push('config: "animations" must be true or false');
    }
  }

  if (raw.leader !== undefined) {
    if (isNonEmptyString(raw.leader)) {
      config.leader = raw.leader;
    } else {
      warnings.push('config: "leader" must be a non-empty string');
    }
  }

  if (raw.connections !== undefined) {
    if (Array.isArray(raw.connections)) {
      for (let i = 0; i < raw.connections.length; i++) {
        const item = raw.connections[i];
        if (isPlainObject(item) && isNonEmptyString(item.name) && isNonEmptyString(item.url)) {
          config.connections.push({ name: item.name, url: item.url });
        } else {
          warnings.push(`config: "connections[${i}]" needs a name and a url`);
        }
      }
    } else {
      warnings.push('config: "connections" must be an array');
    }
  }

  if (raw.results !== undefined) {
    if (isPlainObject(raw.results)) {
      const resultsKeys = ["maxRows", "jsonMaxRows", "peekRows"] as const;
      for (const key of resultsKeys) {
        const val = raw.results[key];
        if (val !== undefined) {
          if (isPositiveInteger(val)) {
            config.results[key] = val;
          } else {
            warnings.push(`config: "results.${key}" must be a positive integer`);
          }
        }
      }
    } else {
      warnings.push('config: "results" must be an object');
    }
  }

  if (raw.agent !== undefined) {
    if (isPlainObject(raw.agent)) {
      if (raw.agent.provider !== undefined) {
        if (
          raw.agent.provider === null ||
          (typeof raw.agent.provider === "string" &&
            (PROVIDER_IDS as readonly string[]).includes(raw.agent.provider))
        ) {
          config.agent.provider = raw.agent.provider as ProviderId | null;
        } else {
          warnings.push('config: "agent.provider" must be one of claude, codex, opencode, antigravity');
        }
      }

      if (raw.agent.model !== undefined) {
        if (raw.agent.model === null || isNonEmptyString(raw.agent.model)) {
          config.agent.model = raw.agent.model;
        } else {
          warnings.push('config: "agent.model" must be a non-empty string');
        }
      }

      if (raw.agent.dataAccess !== undefined) {
        if (raw.agent.dataAccess === "rows" || raw.agent.dataAccess === "schema") {
          config.agent.dataAccess = raw.agent.dataAccess;
        } else {
          warnings.push('config: "agent.dataAccess" must be "rows" or "schema"');
        }
      }

      if (raw.agent.maxSteps !== undefined) {
        if (isPositiveInteger(raw.agent.maxSteps)) {
          config.agent.maxSteps = raw.agent.maxSteps;
        } else {
          warnings.push('config: "agent.maxSteps" must be a positive integer');
        }
      }

      if (raw.agent.stepTimeoutMs !== undefined) {
        if (isPositiveInteger(raw.agent.stepTimeoutMs)) {
          config.agent.stepTimeoutMs = raw.agent.stepTimeoutMs;
        } else {
          warnings.push('config: "agent.stepTimeoutMs" must be a positive integer');
        }
      }
    } else {
      warnings.push('config: "agent" must be an object');
    }
  }

  return { config, warnings };
}

export async function loadConfig(
  paths: Paths,
): Promise<{ config: Config; warnings: string[]; raw: Record<string, unknown> }> {
  let text: string;
  try {
    text = await readFile(paths.configFile, "utf8");
  } catch (err) {
    const { config, warnings } = parseConfig({});
    // A file that is not there is no error; one that is there and cannot be read is.
    const code = (err as { code?: unknown } | null)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      const reason = typeof code === "string" ? code : err instanceof Error ? err.message : String(err);
      warnings.push(`config: could not read ${paths.configFile} (${reason}); using defaults`);
    }
    return { config, warnings, raw: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const { config } = parseConfig({});
    return {
      config,
      warnings: ["config: could not parse config.json; using defaults"],
      raw: {},
    };
  }

  const { config, warnings } = parseConfig(parsed);
  const raw = isPlainObject(parsed) ? parsed : {};
  return { config, warnings, raw };
}

export async function saveConfig(
  paths: Paths,
  config: Config,
  raw?: Record<string, unknown>,
): Promise<void> {
  await mkdir(paths.configDir, { recursive: true });

  let existingText: string | undefined;
  try {
    existingText = await readFile(paths.configFile, "utf8");
  } catch {
    // Missing or unreadable file is not backed up
  }

  if (existingText !== undefined) {
    let validObject = false;
    try {
      const parsed: unknown = JSON.parse(existingText);
      validObject = isPlainObject(parsed);
    } catch {
      validObject = false;
    }
    if (!validObject) {
      const bakFile = `${paths.configFile}.bak`;
      await writeFile(bakFile, existingText, { mode: 0o600 });
      await chmod(bakFile, 0o600);
    }
  }

  const tmpFile = `${paths.configFile}.tmp`;
  const merged = { ...(raw ?? {}), ...config };
  await writeFile(tmpFile, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmpFile, 0o600);
  await rename(tmpFile, paths.configFile);
}

export function expandEnv(text: string, env: Record<string, string | undefined>): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const value = env[name];
    if (value === undefined) {
      throw new Error(`environment variable ${name} is not set`);
    }
    return value;
  });
}
