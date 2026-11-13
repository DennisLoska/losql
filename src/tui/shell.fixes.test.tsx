import { afterEach, describe, expect, test } from "bun:test";
import { mount, type TestApp } from "./testing";

let app: TestApp;
afterEach(async () => {
  await app?.dispose();
});

describe("fix 1: split borders", () => {
  test("only the Schema and Agent Panes draw a split border", async () => {
    app = await mount();
    app.api.focus.setVisible("agent", true);
    await app.settle();

    const lines = app.frame().split("\n");
    // In a 120x36 terminal with schema (32 cols) and agent (44 cols) on the sides:
    // Schema occupies columns 0..31, so its right edge is column 31 ("┃").
    // Editor and Results occupy columns 32..75, so their first column is column 32.
    // Agent occupies columns 76..119, so its left edge is column 76 ("┃").
    // Check across all workspace rows (rows 0..34; row 35 is the statusline).
    for (let row = 0; row < 35; row++) {
      const line = lines[row]!;
      expect(line[31]).toBe("┃"); // Schema right border
      expect(line[32]).not.toBe("┃"); // Editor / Results first column has no border
      expect(line[76]).toBe("┃"); // Agent left border
    }
  });
});

describe("fix 2: select is never dropped by preview or reload", () => {
  test("select('b') followed at once by preview('c') ends on 'b' with config saved after preview(null)", async () => {
    app = await mount({
      seed: async (deps) => {
        await Bun.write(
          `${deps.paths.themesDir}/b.json`,
          JSON.stringify({ theme: { primary: "#0000bb", text: "#eeeeee", background: "#111122" } }),
        );
        await Bun.write(
          `${deps.paths.themesDir}/c.json`,
          JSON.stringify({ theme: { primary: "#00cc00", text: "#eeeeee", background: "#112211" } }),
        );
      },
    });

    const pSelect = app.api.theme.select("b");
    const pPreview = app.api.theme.preview("c");
    await Promise.all([pSelect, pPreview]);
    await app.api.theme.preview(null);

    expect(app.api.theme.name()).toBe("b");
    const saved = JSON.parse(await Bun.file(app.deps.paths.configFile).text());
    expect(saved.theme).toBe("b");
  });

  test("select('b') then select('c') ends on 'c' and the saved Theme is 'c'", async () => {
    app = await mount({
      seed: async (deps) => {
        await Bun.write(
          `${deps.paths.themesDir}/b.json`,
          JSON.stringify({ theme: { primary: "#0000bb", text: "#eeeeee", background: "#111122" } }),
        );
        await Bun.write(
          `${deps.paths.themesDir}/c.json`,
          JSON.stringify({ theme: { primary: "#00cc00", text: "#eeeeee", background: "#112211" } }),
        );
      },
    });

    const savedThemes: string[] = [];
    const origSet = app.api.config.set.bind(app.api.config);
    app.api.config.set = async (update) => {
      await origSet((c) => {
        const next = update(c);
        savedThemes.push(next.theme);
        return next;
      });
    };

    const p1 = app.api.theme.select("b");
    const p2 = app.api.theme.select("c");
    await Promise.all([p1, p2]);

    expect(app.api.theme.name()).toBe("c");
    const saved = JSON.parse(await Bun.file(app.deps.paths.configFile).text());
    expect(saved.theme).toBe("c");
    // The last entry of savedThemes is 'c', every entry is 'b' or 'c', and no 'b' comes after the first 'c'
    expect(savedThemes[savedThemes.length - 1]).toBe("c");
    expect(savedThemes.every((t) => t === "b" || t === "c")).toBe(true);
    const firstC = savedThemes.indexOf("c");
    expect(firstC).toBeGreaterThanOrEqual(0);
    expect(savedThemes.slice(firstC).includes("b")).toBe(false);
  });

  test("a slow preview('c') that finishes after select('b') applied does not change the active Theme", async () => {
    app = await mount({
      seed: async (deps) => {
        await Bun.write(
          `${deps.paths.themesDir}/b.json`,
          JSON.stringify({ theme: { primary: "#0000bb", text: "#eeeeee", background: "#111122" } }),
        );
        await Bun.write(
          `${deps.paths.themesDir}/c.json`,
          JSON.stringify({ theme: { primary: "#00cc00", text: "#eeeeee", background: "#112211" } }),
        );
      },
    });

    const origFile = Bun.file;
    let releaseC!: () => void;
    const gateC = new Promise<void>((resolve) => {
      releaseC = resolve;
    });

    (Bun as { file: typeof Bun.file }).file = ((path: string | URL, options?: unknown) => {
      const f = origFile(path as string, options as never);
      if (typeof path === "string" && path.endsWith("/c.json")) {
        return new Proxy(f, {
          get(target, prop, receiver) {
            if (prop === "json") {
              return async () => {
                await gateC;
                return target.json();
              };
            }
            const val = Reflect.get(target, prop, receiver);
            return typeof val === "function" ? val.bind(target) : val;
          },
        });
      }
      return f;
    }) as typeof Bun.file;

    try {
      const pPreview = app.api.theme.preview("c");
      await app.api.theme.select("b");
      expect(app.api.theme.name()).toBe("b");
      expect(app.api.theme.theme().name).toBe("b");

      releaseC();
      await pPreview;

      expect(app.api.theme.name()).toBe("b");
      expect(app.api.theme.theme().name).toBe("b");
    } finally {
      (Bun as { file: typeof Bun.file }).file = origFile;
    }
  });
});

describe("fix 3: quit runs once and always exits", () => {
  test("a throwing hook does not stop remaining hooks and exit is called once", async () => {
    app = await mount();
    const ran: string[] = [];
    app.api.onQuit(() => {
      ran.push("first");
      throw new Error("boom");
    });
    app.api.onQuit(async () => {
      await Promise.resolve();
      ran.push("second");
    });

    await app.api.quit();
    expect(ran).toEqual(["first", "second"]);
    expect(app.deps.exits).toEqual([0]);
  });

  test("calling quit() twice runs each hook once and exit once", async () => {
    app = await mount();
    let count = 0;
    app.api.onQuit(async () => {
      count++;
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const p1 = app.api.quit();
    const p2 = app.api.quit();
    expect(p1).toBe(p2);
    await Promise.all([p1, p2]);

    expect(count).toBe(1);
    expect(app.deps.exits).toEqual([0]);
  });
});

describe("fix 4: key dispatch survives handlers that change the layer list", () => {
  test("a non-modal layer that removes itself and one that removes the layer below it while handling a key", async () => {
    app = await mount();
    const seen: string[] = [];

    app.api.keys.addGlobal((k) => {
      seen.push(`global1:${k.name}`);
      return false;
    });
    const removeGlobal2 = app.api.keys.addGlobal((k) => {
      seen.push(`global2:${k.name}`);
      removeGlobal2();
      return false;
    });

    app.api.keys.setPaneHandler("editor", (k) => {
      seen.push(`pane:${k.name}`);
      return false;
    });

    const popBottom = app.api.keys.pushLayer((k) => {
      seen.push(`bottom:${k.name}`);
      return false;
    });

    let popMiddle = () => {};
    popMiddle = app.api.keys.pushLayer((k) => {
      seen.push(`middle:${k.name}`);
      popBottom();
      return false;
    });

    let popTop = () => {};
    popTop = app.api.keys.pushLayer((k) => {
      seen.push(`top:${k.name}`);
      popTop();
      return false;
    });

    await app.press("a");
    // top removes itself, middle runs once and removes bottom, bottom is skipped, pane runs, global2 removes itself, global1 runs
    expect(seen).toEqual(["top:a", "middle:a", "pane:a", "global2:a", "global1:a"]);
    popMiddle();
  });
});

describe("fix 5: a handler that throws does not break the keyboard", () => {
  test("a Pane handler that throws shows the error, <C-w>l moves focus afterwards, and <C-c> twice quits", async () => {
    app = await mount();
    app.api.focus.setVisible("agent", true);
    app.api.keys.setPaneHandler("editor", () => {
      throw new Error("pane boom");
    });

    await app.press("x");
    expect(app.frame()).toContain("pane boom");
    expect(app.api.status.message()).toEqual({ text: "pane boom", kind: "error" });

    await app.press("<C-w>l");
    expect(app.api.focus.pane()).toBe("agent");

    await app.press("<C-c><C-c>");
    expect(app.deps.exits).toEqual([0]);
  });

  test("a throwing non-modal layer lets the key through to the Pane handler", async () => {
    app = await mount();
    const seen: string[] = [];
    app.api.keys.setPaneHandler("editor", (k) => {
      seen.push(`pane:${k.name}`);
      return true;
    });
    const pop = app.api.keys.pushLayer(() => {
      throw new Error("layer boom");
    });

    await app.press("z");
    expect(seen).toEqual(["pane:z"]);
    expect(app.api.status.message()).toEqual({ text: "layer boom", kind: "error" });
    pop();
  });

  test("a throwing modal layer swallows the key", async () => {
    app = await mount();
    const seen: string[] = [];
    app.api.keys.setPaneHandler("editor", (k) => {
      seen.push(`pane:${k.name}`);
      return true;
    });
    const pop = app.api.keys.pushLayer(
      () => {
        throw new Error("modal boom");
      },
      { modal: true },
    );

    await app.press("z");
    expect(seen).toEqual([]);
    expect(app.api.status.message()).toEqual({ text: "modal boom", kind: "error" });
    pop();
  });
});

describe("fix 6: syntax style is built once per Theme, not once per animation frame", () => {
  test("switching Theme with animations on creates one new syntax style and destroys the replaced one", async () => {
    app = await mount({ animations: true });
    const initialSyntax = app.api.theme.syntax();

    await app.api.theme.select("nord");
    const switchedSyntax = app.api.theme.syntax();
    expect(switchedSyntax).not.toBe(initialSyntax);

    // Wait a microtask so the replaced style is destroyed
    await Promise.resolve();
    expect(() => initialSyntax.getStyleCount()).toThrow();

    for (let step = 0; step < 5; step++) {
      await app.advance(50);
      expect(app.api.theme.syntax()).toBe(switchedSyntax);
    }
    expect(switchedSyntax.getStyleCount()).toBeGreaterThan(0);
  });
});

describe("fix 7: the configured Theme is on screen in the first frame", () => {
  test("a user Theme in themesDir configured in config is active in the first frame without waiting for loadInitial", async () => {
    let firstFrameThemeName = "";
    let firstFramePrimaryHex = "";

    app = await mount({
      config: { theme: "customfirst" },
      seed: async (deps) => {
        await Bun.write(
          `${deps.paths.themesDir}/customfirst.json`,
          JSON.stringify({ theme: { primary: "#ab12cd", text: "#eeeeee", background: "#121314" } }),
        );
      },
      ui: (api) => {
        if (!firstFrameThemeName) {
          firstFrameThemeName = api.theme.name();
          const c = api.theme.theme().primary;
          firstFramePrimaryHex = `#${[c.r, c.g, c.b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
        }
        return <text>first frame check</text>;
      },
    });

    expect(firstFrameThemeName).toBe("customfirst");
    expect(firstFramePrimaryHex).toBe("#ab12cd");
    expect(app.api.theme.name()).toBe("customfirst");
    const c = app.api.theme.theme().primary;
    expect(`#${[c.r, c.g, c.b].map((n) => n.toString(16).padStart(2, "0")).join("")}`).toBe("#ab12cd");
  });
});

describe("fix 8: a Pane is mounted once, whatever the terminal width", () => {
  test("resizing from 120 to 80 to 60 columns and back never remounts the Schema or Agent Pane while visible", async () => {
    app = await mount({ width: 120 });

    // Focus Schema and resize 120 -> 80 -> 60 -> 80 -> 120 while Schema stays visible
    app.api.focus.focus("schema");
    await app.settle();
    const schemaNum = app.setup.renderer.root.findDescendantById("pane-schema")?.num;
    expect(schemaNum).toBeDefined();

    await app.resize(80, 36);
    expect(app.api.focus.visible("schema")).toBe(true);
    expect(app.api.focus.layout().schema).toBe("side");
    expect(app.setup.renderer.root.findDescendantById("pane-schema")?.num).toBe(schemaNum);

    await app.resize(60, 36);
    expect(app.api.focus.visible("schema")).toBe(true);
    expect(app.api.focus.layout().schema).toBe("overlay");
    expect(app.setup.renderer.root.findDescendantById("pane-schema")?.num).toBe(schemaNum);

    await app.resize(80, 36);
    expect(app.api.focus.layout().schema).toBe("side");
    expect(app.setup.renderer.root.findDescendantById("pane-schema")?.num).toBe(schemaNum);

    await app.resize(120, 36);
    expect(app.setup.renderer.root.findDescendantById("pane-schema")?.num).toBe(schemaNum);

    // Focus Agent and resize 120 -> 80 -> 60 -> 80 -> 120 while Agent stays visible
    app.api.focus.focus("agent");
    await app.settle();
    const agentNum = app.setup.renderer.root.findDescendantById("pane-agent")?.num;
    expect(agentNum).toBeDefined();

    await app.resize(80, 36);
    expect(app.api.focus.visible("agent")).toBe(true);
    expect(app.api.focus.layout().agent).toBe("overlay");
    expect(app.setup.renderer.root.findDescendantById("pane-agent")?.num).toBe(agentNum);

    await app.resize(60, 36);
    expect(app.api.focus.visible("agent")).toBe(true);
    expect(app.api.focus.layout().agent).toBe("overlay");
    expect(app.setup.renderer.root.findDescendantById("pane-agent")?.num).toBe(agentNum);

    await app.resize(80, 36);
    expect(app.setup.renderer.root.findDescendantById("pane-agent")?.num).toBe(agentNum);

    await app.resize(120, 36);
    expect(app.api.focus.layout().agent).toBe("side");
    expect(app.setup.renderer.root.findDescendantById("pane-agent")?.num).toBe(agentNum);
  });
});

describe("fix 10: modal layer <C-c> and paste routing", () => {
  test("a modal layer that handles nothing swallows <C-c> without quitting or showing the quit message", async () => {
    app = await mount();
    const pop = app.api.keys.pushLayer(() => false, { modal: true });

    await app.press("<C-c>");
    expect(app.deps.exits).toEqual([]);
    expect(app.frame()).not.toContain("Press ctrl+c again to quit");
    expect(app.api.status.message()).toBeNull();

    await app.press("<C-c>");
    expect(app.deps.exits).toEqual([]);
    expect(app.frame()).not.toContain("Press ctrl+c again to quit");
    expect(app.api.status.message()).toBeNull();

    pop();
  });

  test("pasted text goes to the topmost layer with onPaste and never below a modal layer", async () => {
    app = await mount();
    const seen: string[] = [];
    app.api.keys.setPasteHandler("editor", (t) => seen.push(`pane:${t}`));

    const popBelow = app.api.keys.pushLayer(() => false, {
      onPaste: (t) => seen.push(`below:${t}`),
    });
    const popModal = app.api.keys.pushLayer(() => false, { modal: true });

    // Modal layer has no onPaste, so paste stops at the modal layer and never reaches below or pane
    app.api.keys.paste("blocked");
    expect(seen).toEqual([]);

    // Top layer above modal has onPaste -> receives paste
    const popTopWithPaste = app.api.keys.pushLayer(() => false, {
      onPaste: (t) => seen.push(`top:${t}`),
    });
    const popTopWithoutPaste = app.api.keys.pushLayer(() => false);
    app.api.keys.paste("allowed");
    expect(seen).toEqual(["top:allowed"]);

    popTopWithoutPaste();
    popTopWithPaste();
    popModal();
    popBelow();
  });

  test("a non-modal layer without onPaste lets the paste through to the focused Pane's paste handler", async () => {
    app = await mount();
    const seen: string[] = [];
    app.api.keys.setPasteHandler("editor", (t) => seen.push(`pane:${t}`));
    const pop = app.api.keys.pushLayer(() => false);

    app.api.keys.paste("hello");
    expect(seen).toEqual(["pane:hello"]);
    pop();
  });
});

describe("fix 11: a failing select does not discard a valid one", () => {
  test("select('b') (slow) followed by select('nope') (fails) ends with Theme 'b' active and saved", async () => {
    app = await mount({
      seed: async (deps) => {
        await Bun.write(
          `${deps.paths.themesDir}/b.json`,
          JSON.stringify({ theme: { primary: "#0000bb", text: "#eeeeee", background: "#111122" } }),
        );
      },
    });

    const origFile = Bun.file;
    let releaseB!: () => void;
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });

    (Bun as { file: typeof Bun.file }).file = ((path: string | URL, options?: unknown) => {
      const f = origFile(path as string, options as never);
      if (typeof path === "string" && path.endsWith("/b.json")) {
        return new Proxy(f, {
          get(target, prop, receiver) {
            if (prop === "json") {
              return async () => {
                await gateB;
                return target.json();
              };
            }
            const val = Reflect.get(target, prop, receiver);
            return typeof val === "function" ? val.bind(target) : val;
          },
        });
      }
      return f;
    }) as typeof Bun.file;

    try {
      const pValid = app.api.theme.select("b");
      let failed = false;
      try {
        await app.api.theme.select("nope");
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);

      releaseB();
      await pValid;

      expect(app.api.theme.name()).toBe("b");
      expect(app.api.theme.theme().name).toBe("b");
      const saved = JSON.parse(await origFile(app.deps.paths.configFile).text());
      expect(saved.theme).toBe("b");
    } finally {
      (Bun as { file: typeof Bun.file }).file = origFile;
    }
  });
});

describe("fix 12: quit hook timeout", () => {
  test("a quit hook that never settles is abandoned after 2,000 ms on the clock so remaining hooks and exit(0) still run", async () => {
    app = await mount({ connection: null });
    const events: string[] = [];

    app.api.onQuit(() => {
      events.push("first-start");
      return new Promise<void>(() => {
        // Never resolves or rejects
      });
    });

    app.api.onQuit(() => {
      events.push("second");
    });

    const quitPromise = app.api.quit();
    await app.settle();
    expect(events).toEqual(["first-start"]);
    expect(app.deps.exits).toEqual([]);

    await app.advance(1999);
    expect(events).toEqual(["first-start"]);
    expect(app.deps.exits).toEqual([]);

    await app.advance(1);

    expect(events).toEqual(["first-start", "second"]);
    expect(app.deps.exits).toEqual([0]);
    await quitPromise;
  });
});

describe("Follow-up Fix 4: a Theme that has loaded is applied without waiting for a later one", () => {
  test("select('b') fast then select('c') slow: 'b' is active and saved while 'c' loads, then 'c'; and if 'c' never settles, 'b' stays active", async () => {
    app = await mount({
      seed: async (deps) => {
        await Bun.write(
          `${deps.paths.themesDir}/b.json`,
          JSON.stringify({ theme: { primary: "#0000bb", text: "#eeeeee", background: "#111122" } }),
        );
        await Bun.write(
          `${deps.paths.themesDir}/c.json`,
          JSON.stringify({ theme: { primary: "#00cc00", text: "#eeeeee", background: "#112211" } }),
        );
        await Bun.write(
          `${deps.paths.themesDir}/never.json`,
          JSON.stringify({ theme: { primary: "#ff0000", text: "#eeeeee", background: "#221111" } }),
        );
      },
    });

    const origFile = Bun.file;
    let releaseB!: () => void;
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    let releaseC!: () => void;
    const gateC = new Promise<void>((resolve) => {
      releaseC = resolve;
    });
    const gateNever = new Promise<void>(() => {});

    (Bun as { file: typeof Bun.file }).file = ((path: string | URL, options?: unknown) => {
      const f = origFile(path as string, options as never);
      if (typeof path === "string" && path.endsWith("/b.json")) {
        return new Proxy(f, {
          get(target, prop, receiver) {
            if (prop === "json") {
              return async () => {
                await gateB;
                return target.json();
              };
            }
            const val = Reflect.get(target, prop, receiver);
            return typeof val === "function" ? val.bind(target) : val;
          },
        });
      }
      if (typeof path === "string" && path.endsWith("/c.json")) {
        return new Proxy(f, {
          get(target, prop, receiver) {
            if (prop === "json") {
              return async () => {
                await gateC;
                return target.json();
              };
            }
            const val = Reflect.get(target, prop, receiver);
            return typeof val === "function" ? val.bind(target) : val;
          },
        });
      }
      if (typeof path === "string" && path.endsWith("/never.json")) {
        return new Proxy(f, {
          get(target, prop, receiver) {
            if (prop === "json") {
              return async () => {
                await gateNever;
                return target.json();
              };
            }
            const val = Reflect.get(target, prop, receiver);
            return typeof val === "function" ? val.bind(target) : val;
          },
        });
      }
      return f;
    }) as typeof Bun.file;

    try {
      const pB = app.api.theme.select("b");
      const pC = app.api.theme.select("c");
      const pNever = app.api.theme.select("never");

      // Release 'b' first while 'c' and 'never' are still pending
      releaseB();
      await pB;

      expect(app.api.theme.name()).toBe("b");
      expect(app.api.theme.theme().name).toBe("b");
      const savedAfterB = JSON.parse(await origFile(app.deps.paths.configFile).text());
      expect(savedAfterB.theme).toBe("b");

      // Now release 'c' while 'never' never settles
      releaseC();
      await pC;

      expect(app.api.theme.name()).toBe("c");
      expect(app.api.theme.theme().name).toBe("c");
      const savedAfterC = JSON.parse(await origFile(app.deps.paths.configFile).text());
      expect(savedAfterC.theme).toBe("c");
      void pNever;
    } finally {
      (Bun as { file: typeof Bun.file }).file = origFile;
    }
  });

  test("slow 'b' then fast 'c': 'c' applies and saves, and 'b' resolving later changes nothing", async () => {
    app = await mount({
      seed: async (deps) => {
        await Bun.write(
          `${deps.paths.themesDir}/b.json`,
          JSON.stringify({ theme: { primary: "#0000bb", text: "#eeeeee", background: "#111122" } }),
        );
        await Bun.write(
          `${deps.paths.themesDir}/c.json`,
          JSON.stringify({ theme: { primary: "#00cc00", text: "#eeeeee", background: "#112211" } }),
        );
      },
    });

    const origFile = Bun.file;
    let releaseB!: () => void;
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    let releaseC!: () => void;
    const gateC = new Promise<void>((resolve) => {
      releaseC = resolve;
    });

    (Bun as { file: typeof Bun.file }).file = ((path: string | URL, options?: unknown) => {
      const f = origFile(path as string, options as never);
      if (typeof path === "string" && path.endsWith("/b.json")) {
        return new Proxy(f, {
          get(target, prop, receiver) {
            if (prop === "json") {
              return async () => {
                await gateB;
                return target.json();
              };
            }
            const val = Reflect.get(target, prop, receiver);
            return typeof val === "function" ? val.bind(target) : val;
          },
        });
      }
      if (typeof path === "string" && path.endsWith("/c.json")) {
        return new Proxy(f, {
          get(target, prop, receiver) {
            if (prop === "json") {
              return async () => {
                await gateC;
                return target.json();
              };
            }
            const val = Reflect.get(target, prop, receiver);
            return typeof val === "function" ? val.bind(target) : val;
          },
        });
      }
      return f;
    }) as typeof Bun.file;

    try {
      const savedThemes: string[] = [];
      const origSet = app.api.config.set.bind(app.api.config);
      app.api.config.set = async (update) => {
        await origSet((c) => {
          const next = update(c);
          savedThemes.push(next.theme);
          return next;
        });
      };

      const pB = app.api.theme.select("b");
      const pC = app.api.theme.select("c");

      // Resolve 'c' first
      releaseC();
      await pC;
      expect(app.api.theme.name()).toBe("c");
      expect(app.api.theme.theme().name).toBe("c");

      // Resolve 'b' later -> changes nothing
      releaseB();
      await pB;
      expect(app.api.theme.name()).toBe("c");
      expect(app.api.theme.theme().name).toBe("c");
      const saved = JSON.parse(await origFile(app.deps.paths.configFile).text());
      expect(saved.theme).toBe("c");
      expect(new Set(savedThemes)).toEqual(new Set(["c"]));
    } finally {
      (Bun as { file: typeof Bun.file }).file = origFile;
    }
  });

  test("select('b') loads first and its save is slow, select('c') loads, applies and saves meanwhile, then the slow save of 'b' is released: ends on 'c' in theme, config and disk", async () => {
    app = await mount({
      seed: async (deps) => {
        await Bun.write(
          `${deps.paths.themesDir}/b.json`,
          JSON.stringify({ theme: { primary: "#0000bb", text: "#eeeeee", background: "#111122" } }),
        );
        await Bun.write(
          `${deps.paths.themesDir}/c.json`,
          JSON.stringify({ theme: { primary: "#00cc00", text: "#eeeeee", background: "#112211" } }),
        );
      },
    });

    let saveBStarted = false;
    let releaseSaveB!: () => void;
    const gateSaveB = new Promise<void>((resolve) => {
      releaseSaveB = resolve;
    });

    const origSet = app.api.config.set.bind(app.api.config);
    app.api.config.set = async (update) => {
      const probe = update(app.api.config.config());
      if (probe.theme === "b") {
        saveBStarted = true;
        await gateSaveB;
      }
      await origSet(update);
    };

    const pB = app.api.theme.select("b");
    await app.waitFor(() => saveBStarted);

    await app.api.theme.select("c");
    expect(app.api.theme.name()).toBe("c");
    expect(app.api.config.config().theme).toBe("c");

    releaseSaveB();
    await pB;

    expect(app.api.theme.name()).toBe("c");
    expect(app.api.config.config().theme).toBe("c");
    const saved = JSON.parse(await Bun.file(app.deps.paths.configFile).text());
    expect(saved.theme).toBe("c");
  });
});


