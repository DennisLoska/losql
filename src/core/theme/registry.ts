import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import catppuccin from "./builtin/catppuccin.json";
import everforest from "./builtin/everforest.json";
import gruvbox from "./builtin/gruvbox.json";
import kanagawa from "./builtin/kanagawa.json";
import nord from "./builtin/nord.json";
import rosepine from "./builtin/rosepine.json";
import tokyonight from "./builtin/tokyonight.json";
import { omarchyToThemeJson } from "./omarchy";
import { ThemeError, type ThemeJson } from "./tokens";

export const MAX_THEME_FILE_BYTES = 1024 * 1024;

export const BUILTIN_THEMES: Record<string, ThemeJson> = {
  catppuccin: catppuccin as ThemeJson,
  everforest: everforest as ThemeJson,
  gruvbox: gruvbox as ThemeJson,
  kanagawa: kanagawa as ThemeJson,
  nord: nord as ThemeJson,
  rosepine: rosepine as ThemeJson,
  tokyonight: tokyonight as ThemeJson,
};

export interface ThemeInfo {
  name: string;
  source: "builtin" | "user" | "omarchy";
}

export interface ThemeSources {
  themesDir: string;
  omarchyColors: string | null;
}

async function statRegularFile(path: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    const st = await stat(path);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

async function isReadableOmarchyFile(path: string | null): Promise<boolean> {
  if (!path) return false;
  const st = await statRegularFile(path);
  return st !== null && st.size <= MAX_THEME_FILE_BYTES;
}

export function omarchyColorsPath(
  env: Record<string, string | undefined>,
  home: string,
  exists: (path: string) => boolean,
): string | null {
  const stateHome = env.XDG_STATE_HOME || join(home, ".local", "state");
  const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
  const statePath = join(stateHome, "omarchy", "current", "theme", "colors.toml");
  if (exists(statePath)) return statePath;
  const configPath = join(configHome, "omarchy", "current", "theme", "colors.toml");
  if (exists(configPath)) return configPath;
  return null;
}

function isValidThemeName(name: string): boolean {
  if (!name || name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  return true;
}

export async function listThemes(sources: ThemeSources): Promise<ThemeInfo[]> {
  const byName = new Map<string, "builtin" | "user">();
  for (const name of Object.keys(BUILTIN_THEMES)) {
    byName.set(name, "builtin");
  }

  try {
    const entries = await readdir(sources.themesDir);
    for (const entry of entries) {
      if (entry.endsWith(".json")) {
        const name = entry.slice(0, -5);
        if (isValidThemeName(name) && name !== "omarchy") {
          const st = await statRegularFile(join(sources.themesDir, entry));
          if (st !== null) {
            byName.set(name, "user");
          }
        }
      }
    }
  } catch {
    // Missing directory is not an error
  }

  const sorted: ThemeInfo[] = Array.from(byName.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, source]) => ({ name, source }));

  if (await isReadableOmarchyFile(sources.omarchyColors)) {
    return [{ name: "omarchy", source: "omarchy" }, ...sorted];
  }
  return sorted;
}

export async function loadThemeJson(
  name: string,
  sources: ThemeSources,
): Promise<{ json: ThemeJson; mode?: "dark" | "light" }> {
  if (!isValidThemeName(name)) {
    throw new ThemeError(`unknown theme: ${name}`);
  }
  if (name === "omarchy") {
    if (!sources.omarchyColors || !(await isReadableOmarchyFile(sources.omarchyColors))) {
      throw new ThemeError("unknown theme: omarchy");
    }
    let content: string;
    try {
      content = await Bun.file(sources.omarchyColors).text();
    } catch {
      throw new ThemeError(`theme omarchy: could not read ${sources.omarchyColors}`);
    }
    return omarchyToThemeJson(content);
  }

  const userPath = join(sources.themesDir, `${name}.json`);
  const userStat = await statRegularFile(userPath);
  if (userStat !== null) {
    if (userStat.size > MAX_THEME_FILE_BYTES) {
      throw new ThemeError(`theme ${name}: could not read ${userPath}`);
    }
    try {
      const parsed = (await Bun.file(userPath).json()) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as { theme?: unknown }).theme !== "object" ||
        (parsed as { theme?: unknown }).theme === null ||
        Array.isArray((parsed as { theme?: unknown }).theme)
      ) {
        throw new ThemeError(`theme ${name}: could not read ${userPath}`);
      }
      return { json: parsed as ThemeJson };
    } catch (err) {
      if (err instanceof ThemeError) throw err;
      throw new ThemeError(`theme ${name}: could not read ${userPath}`);
    }
  }

  if (Object.hasOwn(BUILTIN_THEMES, name)) {
    return { json: BUILTIN_THEMES[name]! };
  }

  throw new ThemeError(`unknown theme: ${name}`);
}
