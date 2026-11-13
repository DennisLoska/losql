import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_THEME_FILE_BYTES, listThemes, loadThemeJson, omarchyColorsPath } from "./registry";
import { ThemeError } from "./tokens";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "losql-themes-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

test("omarchyColorsPath prefers the state directory", () => {
  const state = "/home/u/.local/state/omarchy/current/theme/colors.toml";
  const config = "/home/u/.config/omarchy/current/theme/colors.toml";
  expect(omarchyColorsPath({}, "/home/u", (p) => p === state || p === config)).toBe(state);
  expect(omarchyColorsPath({}, "/home/u", (p) => p === config)).toBe(config);
  expect(omarchyColorsPath({ XDG_STATE_HOME: "/s" }, "/home/u", (p) => p === "/s/omarchy/current/theme/colors.toml")).toBe("/s/omarchy/current/theme/colors.toml");
  expect(omarchyColorsPath({}, "/home/u", () => false)).toBeNull();
});

test("listThemes: omarchy first when present, then built-in and user themes by name", async () => {
  await mkdir(join(dir, "themes"));
  await Bun.write(join(dir, "themes", "mine.json"), JSON.stringify({ theme: { primary: "#ff0000", text: "#ffffff", background: "#000000" } }));
  await Bun.write(join(dir, "themes", "nord.json"), JSON.stringify({ theme: { primary: "#00ff00", text: "#ffffff", background: "#000000" } }));
  await Bun.write(join(dir, "themes", "notes.txt"), "ignored");
  await Bun.write(join(dir, "colors.toml"), 'background = "#000000"\nforeground = "#ffffff"\n');

  expect(await listThemes({ themesDir: join(dir, "themes"), omarchyColors: join(dir, "colors.toml") })).toEqual([
    { name: "omarchy", source: "omarchy" },
    { name: "catppuccin", source: "builtin" },
    { name: "everforest", source: "builtin" },
    { name: "gruvbox", source: "builtin" },
    { name: "kanagawa", source: "builtin" },
    { name: "mine", source: "user" },
    { name: "nord", source: "user" },
    { name: "rosepine", source: "builtin" },
    { name: "tokyonight", source: "builtin" },
  ]);
  expect((await listThemes({ themesDir: join(dir, "missing"), omarchyColors: null })).map((t) => t.name)).toEqual([
    "catppuccin", "everforest", "gruvbox", "kanagawa", "nord", "rosepine", "tokyonight",
  ]);
});

test("loadThemeJson: user themes win, omarchy carries its mode, unknown names fail", async () => {
  await mkdir(join(dir, "themes"));
  await Bun.write(join(dir, "themes", "nord.json"), JSON.stringify({ theme: { primary: "#00ff00", text: "#ffffff", background: "#000000" } }));
  await Bun.write(join(dir, "themes", "broken.json"), "{ nope");
  await Bun.write(join(dir, "colors.toml"), 'mode = "light"\nbackground = "#ffffff"\nforeground = "#111111"\n');
  const sources = { themesDir: join(dir, "themes"), omarchyColors: join(dir, "colors.toml") };

  expect((await loadThemeJson("nord", sources)).json.theme.primary).toBe("#00ff00");
  expect((await loadThemeJson("tokyonight", sources)).json.theme.primary).toEqual({ dark: "darkStep9", light: "lightStep9" });
  expect((await loadThemeJson("omarchy", sources)).mode).toBe("light");
  await expect(loadThemeJson("nope", sources)).rejects.toThrow("unknown theme: nope");
  await expect(loadThemeJson("broken", sources)).rejects.toThrow(ThemeError);
  await expect(loadThemeJson("omarchy", { ...sources, omarchyColors: null })).rejects.toThrow("unknown theme: omarchy");
});

test("regular file and size limits for user themes and Omarchy colours", async () => {
  const themesDir = join(dir, "themes");
  await mkdir(themesDir);

  expect(MAX_THEME_FILE_BYTES).toBe(1024 * 1024);

  const hugePath = join(themesDir, "huge.json");
  const padding = "a".repeat(MAX_THEME_FILE_BYTES);
  await Bun.write(
    hugePath,
    JSON.stringify({
      defs: { pad: padding },
      theme: { primary: "#ff0000", text: "#ffffff", background: "#000000" },
    }),
  );
  await expect(loadThemeJson("huge", { themesDir, omarchyColors: null })).rejects.toThrow(
    new ThemeError(`theme huge: could not read ${hugePath}`),
  );

  await mkdir(join(themesDir, "big.json"));
  await expect(loadThemeJson("big", { themesDir, omarchyColors: null })).rejects.toThrow(ThemeError);

  const realThemePath = join(dir, "real-theme.json");
  await Bun.write(
    realThemePath,
    JSON.stringify({ theme: { primary: "#123456", text: "#ffffff", background: "#000000" } }),
  );
  await symlink(realThemePath, join(themesDir, "linked.json"));
  expect((await loadThemeJson("linked", { themesDir, omarchyColors: null })).json.theme.primary).toBe("#123456");

  const hugeOmarchy = join(dir, "huge-colors.toml");
  await Bun.write(
    hugeOmarchy,
    `background = "#000000"\nforeground = "#ffffff"\n# ${"x".repeat(MAX_THEME_FILE_BYTES)}\n`,
  );
  const missingOmarchy = join(dir, "missing-colors.toml");
  expect(await listThemes({ themesDir, omarchyColors: hugeOmarchy })).toEqual(
    await listThemes({ themesDir, omarchyColors: missingOmarchy }),
  );
  expect((await listThemes({ themesDir, omarchyColors: hugeOmarchy })).some((t) => t.name === "omarchy")).toBe(false);
  await expect(loadThemeJson("omarchy", { themesDir, omarchyColors: hugeOmarchy })).rejects.toThrow(
    "unknown theme: omarchy",
  );
});

test("theme names cannot leave the themes directory", async () => {
  const themesDir = join(dir, "themes");
  await mkdir(themesDir);
  await Bun.write(
    join(dir, "outside.json"),
    JSON.stringify({ theme: { primary: "#ff0000", text: "#ffffff", background: "#000000" } }),
  );
  const sources = { themesDir, omarchyColors: null };

  for (const bad of ["../outside", "a/b", "a\\b", "", "..", ".", "bad\0name"]) {
    await expect(loadThemeJson(bad, sources)).rejects.toThrow(new ThemeError(`unknown theme: ${bad}`));
  }
});

test("built-in lookup ignores inherited Object.prototype properties", async () => {
  const sources = { themesDir: join(dir, "missing"), omarchyColors: null };
  for (const prop of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
    await expect(loadThemeJson(prop, sources)).rejects.toThrow(new ThemeError(`unknown theme: ${prop}`));
  }
});

test("listThemes and loadThemeJson ignore directories ending in .json", async () => {
  const themesDir = join(dir, "themes");
  await mkdir(themesDir);
  await mkdir(join(themesDir, "dir.json"));
  await mkdir(join(themesDir, "nord.json"));
  const sources = { themesDir, omarchyColors: null };

  const listed = await listThemes(sources);
  expect(listed.find((t) => t.name === "dir")).toBeUndefined();
  expect(listed.find((t) => t.name === "nord")).toEqual({ name: "nord", source: "builtin" });

  const loadedNord = await loadThemeJson("nord", sources);
  expect(loadedNord.json).toEqual((await loadThemeJson("nord", { themesDir: join(dir, "missing"), omarchyColors: null })).json);
});

test("user omarchy.json in themes directory is never listed and never loaded", async () => {
  const themesDir = join(dir, "themes");
  await mkdir(themesDir);
  await Bun.write(
    join(themesDir, "omarchy.json"),
    JSON.stringify({ theme: { primary: "#ff00ff", text: "#ffffff", background: "#000000" } }),
  );

  const withoutOmarchy = { themesDir, omarchyColors: null };
  expect((await listThemes(withoutOmarchy)).find((t) => t.name === "omarchy")).toBeUndefined();
  await expect(loadThemeJson("omarchy", withoutOmarchy)).rejects.toThrow(
    new ThemeError("unknown theme: omarchy"),
  );

  const omarchyPath = join(dir, "colors.toml");
  await Bun.write(omarchyPath, 'accent = "#00ff00"\nbackground = "#000000"\nforeground = "#ffffff"\n');
  const withOmarchy = { themesDir, omarchyColors: omarchyPath };
  expect((await listThemes(withOmarchy))[0]).toEqual({ name: "omarchy", source: "omarchy" });
  expect((await loadThemeJson("omarchy", withOmarchy)).json.theme.primary).toBe("#00ff00");
});
