import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toHex } from "../core/theme/color";
import { BUILTIN_THEMES } from "../core/theme/registry";
import { resolveTheme } from "../core/theme/resolve";
import { realDeps } from "./deps";
import { mount, spanWith, transparentRatio, type TestApp } from "./testing";

let app: TestApp;
afterEach(async () => { await app?.dispose(); });

const savedConfig = async () => JSON.parse(await Bun.file(app.deps.paths.configFile).text());

describe("shell", () => {
  test("draws the workspace and the statusline", async () => {
    app = await mount();
    const frame = app.frame();
    expect(frame).toContain("NORMAL");
    expect(frame).toContain("SCHEMA");
    expect(frame).toContain("RESULTS");
    expect(app.api.focus.pane()).toBe("editor");
    expect(app.api.focus.visible("schema")).toBe(true);
    expect(app.api.focus.visible("agent")).toBe(false);
  });

  test("ctrl+w chords move focus", async () => {
    app = await mount();
    await app.press("<C-w>h");
    expect(app.api.focus.pane()).toBe("schema");
    await app.press("<C-w>h");
    expect(app.api.focus.pane()).toBe("schema");
    await app.press("<C-w>l");
    expect(app.api.focus.pane()).toBe("editor");
    await app.press("<C-w>j");
    expect(app.api.focus.pane()).toBe("results");
    await app.press("<C-w>h<C-w>l");
    expect(app.api.focus.pane()).toBe("results");
    await app.press("<C-w>k");
    expect(app.api.focus.pane()).toBe("editor");
    await app.press("<C-w>l");
    expect(app.api.focus.pane()).toBe("editor"); // the Agent Pane is hidden
  });

  test("ctrl+w w cycles through the visible Panes", async () => {
    app = await mount();
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      await app.press("<C-w>w");
      seen.push(app.api.focus.pane());
    }
    expect(seen).toEqual(["results", "schema", "editor"]);
    app.api.focus.setVisible("agent", true);
    await app.press("<C-w>w<C-w>w");
    expect(app.api.focus.pane()).toBe("agent");
  });

  test("the pending chord is shown and any other key cancels it", async () => {
    app = await mount();
    await app.press("<C-w>");
    expect(app.api.keys.chord()).toBe("^W");
    expect(app.frame()).toContain("^W");
    await app.press("x");
    expect(app.api.keys.chord()).toBe("");
    expect(app.api.focus.pane()).toBe("editor");
  });

  test("ctrl+h, j, k and l move focus directly", async () => {
    app = await mount();
    await app.press("<C-h>");
    expect(app.api.focus.pane()).toBe("schema");
    await app.press("<C-l><C-j>");
    expect(app.api.focus.pane()).toBe("results");
    await app.press("<C-k>");
    expect(app.api.focus.pane()).toBe("editor");
  });

  test("keys typed in the terminal reach the dispatcher", async () => {
    app = await mount();
    app.setup.mockInput.pressKey("w", { ctrl: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    app.setup.mockInput.pressKey("h");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await app.settle();
    expect(app.api.focus.pane()).toBe("schema");
  });

  test("toggle shows, focuses and hides a Pane", async () => {
    app = await mount();
    app.api.focus.toggle("schema");
    expect(app.api.focus.pane()).toBe("schema");
    app.api.focus.toggle("schema");
    expect(app.api.focus.visible("schema")).toBe(false);
    expect(app.api.focus.pane()).toBe("editor");
    app.api.focus.toggle("schema");
    expect(app.api.focus.visible("schema")).toBe(true);
    expect(app.api.focus.pane()).toBe("schema");
    app.api.focus.focus("agent");
    expect(app.api.focus.visible("agent")).toBe(true);
    await app.settle();
    expect(app.frame()).toContain("AGENT");
    await app.press("<C-w>h");
    expect(app.api.focus.pane()).toBe("editor");
    await app.press("<C-w>l");
    expect(app.api.focus.pane()).toBe("agent");
  });

  test("narrow terminals overlay the side Panes", async () => {
    app = await mount();
    expect(app.api.focus.layout()).toEqual({ schema: "side", agent: "side" });
    await app.resize(90, 30);
    expect(app.api.focus.layout()).toEqual({ schema: "side", agent: "overlay" });
    app.api.focus.focus("agent");
    expect(app.api.focus.visible("agent")).toBe(true);
    app.api.focus.focus("editor");
    expect(app.api.focus.visible("agent")).toBe(false); // an overlaid Pane closes when it loses focus
    await app.resize(60, 30);
    expect(app.api.focus.layout()).toEqual({ schema: "overlay", agent: "overlay" });
  });

  test("a terminal narrower than 70 columns starts with the Schema Pane hidden", async () => {
    app = await mount({ width: 60 });
    expect(app.api.focus.visible("schema")).toBe(false);
  });
});

describe("key dispatch order", () => {
  test("the focused Pane sees a key before the global handlers", async () => {
    app = await mount();
    const seen: string[] = [];
    app.api.keys.setPaneHandler("editor", (key) => {
      seen.push(`pane:${key.name}`);
      return key.name === "x";
    });
    app.api.keys.addGlobal((key) => {
      seen.push(`global:${key.name}`);
      return true;
    });
    await app.press("xy");
    expect(seen).toEqual(["pane:x", "pane:y", "global:y"]);
  });

  test("a layer sees keys first and a modal layer swallows the rest", async () => {
    app = await mount();
    const seen: string[] = [];
    const pop = app.api.keys.pushLayer((key) => {
      seen.push(key.name);
      return key.name === "a";
    }, { modal: true });
    await app.press("a<C-w>h");
    expect(seen).toEqual(["a", "w", "h"]);
    expect(app.api.focus.pane()).toBe("editor");
    pop();
    await app.press("<C-w>h");
    expect(app.api.focus.pane()).toBe("schema");
  });

  test("a layer that is not modal lets unhandled keys through", async () => {
    app = await mount();
    const pop = app.api.keys.pushLayer(() => false);
    await app.press("<C-w>h");
    expect(app.api.focus.pane()).toBe("schema");
    pop();
  });

  test("paste goes to the top layer that wants it, else to the focused Pane", async () => {
    app = await mount();
    const seen: string[] = [];
    app.api.keys.setPasteHandler("editor", (text) => seen.push(`pane:${text}`));
    app.api.keys.paste("one");
    const pop = app.api.keys.pushLayer(() => false, { onPaste: (text) => seen.push(`layer:${text}`) });
    app.api.keys.paste("two");
    pop();
    expect(seen).toEqual(["pane:one", "layer:two"]);
  });

  test("a status message lasts until the next key", async () => {
    app = await mount();
    app.api.status.say("hello there");
    await app.settle();
    expect(app.frame()).toContain("hello there");
    await app.press("x");
    expect(app.api.status.message()).toBeNull();
  });
});

describe("quitting", () => {
  test("ctrl+c twice within a second quits", async () => {
    app = await mount();
    await app.press("<C-c>");
    expect(app.deps.exits).toEqual([]);
    expect(app.frame()).toContain("Press ctrl+c again to quit");
    await app.advance(1500);
    await app.press("<C-c>");
    expect(app.deps.exits).toEqual([]);
    await app.press("<C-c>");
    expect(app.deps.exits).toEqual([0]);
  });

  test("ctrl+c cancels running work instead of counting towards quit", async () => {
    app = await mount();
    let cancelled = 0;
    let busy = true;
    app.api.keys.onInterrupt(() => {
      if (!busy) return false;
      cancelled++;
      busy = false;
      return true;
    });
    await app.press("<C-c>");
    expect(cancelled).toBe(1);
    await app.press("<C-c>");
    expect(app.deps.exits).toEqual([]);
    await app.press("<C-c>");
    expect(app.deps.exits).toEqual([0]);
  });

  test("quit runs its hooks first", async () => {
    app = await mount();
    const order: string[] = [];
    app.api.onQuit(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("hook");
    });
    await app.api.quit();
    order.push(`exit:${app.deps.exits.join(",")}`);
    expect(order).toEqual(["hook", "exit:0"]);
  });
});

describe("config", () => {
  test("command-line arguments override the file without being saved", async () => {
    app = await mount({ config: { theme: "gruvbox" }, args: { theme: "nord" } });
    expect(app.api.config.config().theme).toBe("nord");
    expect(app.api.theme.name()).toBe("nord");
    await app.api.config.set((config) => ({ ...config, leader: "," }));
    expect((await savedConfig()).theme).toBe("gruvbox");
    expect((await savedConfig()).leader).toBe(",");
    expect(app.api.config.config().leader).toBe(",");
    expect(app.api.config.config().theme).toBe("nord");
  });

  test("changing an overridden value replaces the override", async () => {
    app = await mount({ config: { theme: "gruvbox" }, args: { theme: "nord" } });
    await app.api.theme.select("kanagawa");
    expect(app.api.config.config().theme).toBe("kanagawa");
    expect((await savedConfig()).theme).toBe("kanagawa");
  });

  test("unknown keys in the file survive a save", async () => {
    app = await mount({ config: { somethingElse: { keep: true } } });
    await app.api.config.set((config) => ({ ...config, leader: "," }));
    expect((await savedConfig()).somethingElse).toEqual({ keep: true });
  });

  test("LOSQL_NO_ANIMATIONS=1 turns animations off", async () => {
    app = await mount({ animations: true, deps: { env: { LOSQL_NO_ANIMATIONS: "1" } } });
    expect(app.api.config.config().animations).toBe(true);
    expect(app.api.config.animations()).toBe(false);
  });

  test("state changes are saved", async () => {
    app = await mount();
    await app.api.config.setState({ lastConnection: "dev" });
    expect(app.api.config.state().lastConnection).toBe("dev");
    expect(JSON.parse(await Bun.file(app.deps.paths.stateFile).text()).lastConnection).toBe("dev");
  });
});

describe("theme", () => {
  const nord = resolveTheme("nord", BUILTIN_THEMES.nord!, { mode: "dark", transparent: false });
  const tokyo = resolveTheme("tokyonight", BUILTIN_THEMES.tokyonight!, { mode: "dark", transparent: false });

  test("the default theme is tokyonight and every cell is painted", async () => {
    app = await mount();
    expect(app.api.theme.name()).toBe("tokyonight");
    expect(toHex(app.api.theme.theme().background)).toBe("#1a1b26");
    expect(transparentRatio(app.spans())).toBe(0);
  });

  test("Transparent leaves Pane backgrounds unpainted and keeps the mode label readable", async () => {
    app = await mount();
    await app.api.theme.setTransparent(true);
    await app.settle();
    expect(app.api.config.config().transparent).toBe(true);
    expect((await savedConfig()).transparent).toBe(true);
    expect(transparentRatio(app.spans())).toBeGreaterThan(0.5);
    expect(spanWith(app.spans(), "NORMAL")!.bg.toInts()[3]).toBe(255);
    await app.api.theme.setTransparent(false);
    await app.settle();
    expect(transparentRatio(app.spans())).toBe(0);
  });

  test("--transparent starts Transparent", async () => {
    app = await mount({ args: { transparent: true } });
    expect(transparentRatio(app.spans())).toBeGreaterThan(0.5);
  });

  test("select saves, preview does not", async () => {
    app = await mount();
    await app.api.theme.preview("nord");
    expect(app.api.theme.theme().background).toEqual(nord.background);
    expect(app.api.theme.name()).toBe("tokyonight");
    await app.api.theme.preview(null);
    expect(app.api.theme.theme().background).toEqual(tokyo.background);
    await app.api.theme.select("nord");
    expect(app.api.theme.name()).toBe("nord");
    expect((await savedConfig()).theme).toBe("nord");
    await expect(app.api.theme.select("nope")).rejects.toThrow("unknown theme: nope");
    expect(app.api.theme.name()).toBe("nord");
  });

  test("a theme change cross-fades when animations are on", async () => {
    app = await mount({ animations: true });
    await app.api.theme.select("nord");
    await app.advance(100);
    const mid = app.api.theme.theme().background;
    expect(mid).not.toEqual(tokyo.background);
    expect(mid).not.toEqual(nord.background);
    await app.advance(200);
    expect(app.api.theme.theme().background).toEqual(nord.background);
  });

  test("an unknown theme in the config falls back to tokyonight and says so", async () => {
    app = await mount({ config: { theme: "nope" } });
    expect(app.api.theme.name()).toBe("tokyonight");
    expect(app.api.status.message()).toEqual({ text: "unknown theme: nope", kind: "error" });
  });

  test("user themes and light mode", async () => {
    app = await mount({ config: { mode: "light" } });
    expect(toHex(app.api.theme.theme().background)).toBe("#e1e2e7");
    await Bun.write(
      `${app.deps.paths.themesDir}/mine.json`,
      JSON.stringify({ theme: { primary: "#ff0000", text: "#111111", background: "#fefefe" } }),
    );
    expect((await app.api.theme.list()).map((t) => t.name)).toContain("mine");
    await app.api.theme.select("mine");
    expect(toHex(app.api.theme.theme().primary)).toBe("#ff0000");
  });

  test("the omarchy theme follows its colour file", async () => {
    let changed = () => {};
    const colors = (accent: string) => `background = "#101010"\nforeground = "#eeeeee"\naccent = "${accent}"\n`;
    const colorDir = await mkdtemp(join(tmpdir(), "losql-omarchy-"));
    const file = join(colorDir, "colors.toml");
    await Bun.write(file, colors("#ff0000"));
    app = await mount({
      config: { theme: "omarchy" },
      deps: {
        env: { LOSQL_OMARCHY_COLORS: file },
        watch: (path, onChange) => {
          if (path === file) changed = onChange;
          return () => {};
        },
      },
    });
    expect(app.api.theme.name()).toBe("omarchy");
    expect(toHex(app.api.theme.theme().primary)).toBe("#ff0000");
    expect((await app.api.theme.list())[0]).toEqual({ name: "omarchy", source: "omarchy" });
    await Bun.write(file, colors("#00ff00"));
    changed();
    await app.waitFor(() => toHex(app.api.theme.theme().primary) === "#00ff00");
    await rm(colorDir, { recursive: true, force: true });
  });

  test("the omarchy theme follows theme switches that replace its directory, with the real watch", async () => {
    const colors = (background: string) => `background = "${background}"\nforeground = "#eeeeee"\naccent = "#ff0000"\n`;
    const root = await mkdtemp(join(tmpdir(), "losql-omarchy-switch-"));
    const themeDir = join(root, "current", "theme");
    const file = join(themeDir, "colors.toml");
    await mkdir(themeDir, { recursive: true });
    await writeFile(file, colors("#101010"));
    // What omarchy-theme-set does: build the next theme beside it, remove the current one, move the next one in.
    const switchTo = async (background: string, gapMs: number) => {
      const next = join(root, "next-theme");
      await mkdir(next, { recursive: true });
      await writeFile(join(next, "colors.toml"), colors(background));
      await rm(themeDir, { recursive: true, force: true });
      await new Promise((resolve) => setTimeout(resolve, gapMs));
      await rename(next, themeDir);
    };
    const messages: string[] = [];
    const drawn = (hex: string) => {
      const message = app.api.status.message();
      if (message) messages.push(message.text);
      const ints = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      return (
        toHex(app.api.theme.theme().background) === hex &&
        app.spans().lines.some((line) =>
          line.spans.some((span) => span.bg.toInts().slice(0, 3).every((v, i) => v === ints[i])),
        )
      );
    };
    try {
      app = await mount({
        config: { theme: "omarchy" },
        deps: { env: { LOSQL_OMARCHY_COLORS: file }, watch: realDeps().watch },
      });
      expect(app.api.theme.name()).toBe("omarchy");
      expect(drawn("#101010")).toBe(true);
      await writeFile(file, colors("#202020"));
      await app.waitFor(() => drawn("#202020"));
      await switchTo("#303030", 30);
      await app.waitFor(() => drawn("#303030"));
      await switchTo("#404040", 0);
      await app.waitFor(() => drawn("#404040"));
      await switchTo("#505050", 300);
      await app.waitFor(() => drawn("#505050"));
      expect(messages.filter((text) => text.includes("unknown theme"))).toEqual([]);
      expect(app.api.theme.name()).toBe("omarchy");
      // A file that is there but cannot be read as colours warns and keeps the colours shown.
      await writeFile(file, "background = \n");
      await app.waitFor(() => app.api.status.message()?.kind === "error");
      expect(app.api.status.message()!.text).toContain("invalid omarchy colors.toml");
      expect(drawn("#505050")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
