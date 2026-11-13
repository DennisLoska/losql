import { ThemeError, type ThemeJson, type ThemeValue } from "./tokens";

export function omarchyToThemeJson(toml: string): { json: ThemeJson; mode: "dark" | "light" } {
  let parsed: Record<string, unknown>;
  try {
    parsed = Bun.TOML.parse(toml) as Record<string, unknown>;
  } catch (err) {
    throw new ThemeError(
      `invalid omarchy colors.toml: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const str = (key: string): string | undefined => {
    const v = parsed[key];
    return typeof v === "string" && v.trim() !== "" ? v : undefined;
  };

  const foreground = str("foreground");
  const background = str("background");
  if (!foreground || !background) {
    throw new ThemeError("omarchy colors.toml missing required foreground or background");
  }

  const mode: "dark" | "light" = str("mode") === "light" ? "light" : "dark";

  const theme: Record<string, ThemeValue> = {};
  const set = (token: string, value: string | undefined) => {
    if (value !== undefined) {
      theme[token] = value;
    }
  };

  set("primary", str("accent") ?? str("blue") ?? foreground);
  set("secondary", str("magenta"));
  set("accent", str("orange") ?? str("yellow"));
  set("error", str("red"));
  set("warning", str("yellow"));
  set("success", str("green"));
  set("info", str("cyan") ?? str("blue"));
  set("text", foreground);
  set("textMuted", str("dark_foreground"));
  set("background", background);
  set("backgroundPanel", str("dark_background"));
  set("backgroundElement", str("lighter_background"));
  set("border", str("muted"));
  set("borderSubtle", str("selection"));
  set("syntaxKeyword", str("magenta"));
  set("syntaxFunction", str("blue"));
  set("syntaxString", str("green"));
  set("syntaxNumber", str("orange") ?? str("yellow"));
  set("syntaxType", str("cyan"));
  set("syntaxComment", str("dark_foreground"));

  return { json: { theme }, mode };
}
