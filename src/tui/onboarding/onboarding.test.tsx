import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeClaude, mount, type MountOptions, type TestApp } from "../testing";
import { LOGO } from "../ui/logo";
import { TAGLINE } from "./Welcome";

let app: TestApp;
afterEach(async () => { await app?.dispose(); });

const first = (options: MountOptions = {}) => mount({ connection: null, ...options, state: { onboarded: false, ...options.state } });
const step = () => app.api.onboarding();
const savedState = async () => JSON.parse(await Bun.file(app.deps.paths.stateFile).text());
const savedConfig = async () => JSON.parse(await Bun.file(app.deps.paths.configFile).text());

describe("the first start", () => {
  test("shows the welcome screen instead of the workspace", async () => {
    app = await first();
    expect(step()).toBe("welcome");
    for (const line of LOGO) expect(app.frame()).toContain(line.trimEnd());
    expect(app.frame()).toContain(TAGLINE);
    expect(app.frame()).toContain("enter");
    expect(app.frame()).not.toContain("SCHEMA");
    expect(app.api.dialog.depth()).toBe(0);
  });

  test("walks through the three steps and then shows the workspace", async () => {
    app = await first();
    await app.press("<CR>");
    expect(step()).toBe("connect");
    expect(app.frame()).toContain("Step 1 of 3 · Connect a database");
    await app.press("demo<CR>");
    await app.waitFor(() => step() === "agent");
    expect(app.frame()).toContain("Step 2 of 3 · Choose your agent");
    expect(app.frame()).toContain("up to 50 rows");
    await app.press("continue<CR>");
    await app.waitFor(() => step() === "look");
    expect(app.frame()).toContain("Step 3 of 3 · Pick a look");
    await app.press("<CR>");
    await app.waitFor(() => step() === "done");
    expect((await savedState()).onboarded).toBe(true);
    expect(app.api.config.state().onboarded).toBe(true);
    expect(app.frame()).toContain("SCHEMA");
    expect(app.frame()).toContain("demo · sqlite");
    expect(app.api.dialog.depth()).toBe(0);
    expect(app.api.toast.items().some((t) => t.message.includes("space"))).toBe(true);
  });

  test("Escape goes back one step, and from the welcome screen skips setup", async () => {
    app = await first();
    await app.press("<CR>");
    await app.press("demo<CR>");
    await app.waitFor(() => step() === "agent");
    await app.press("<Esc>");
    await app.waitFor(() => step() === "connect");
    await app.press("<Esc>");
    await app.waitFor(() => step() === "welcome");
    expect(app.api.dialog.depth()).toBe(0);
    await app.press("<Esc>");
    await app.waitFor(() => step() === "done");
    expect((await savedState()).onboarded).toBe(true);
    expect(app.frame()).toContain("SCHEMA");
    expect(app.api.session.connection()?.id).toBe("demo");
  });

  test("skipping setup without a Connection opens the Connections dialog", async () => {
    app = await first();
    await app.press("<Esc>");
    await app.waitFor(() => step() === "done");
    await app.waitFor(() => app.api.dialog.depth() === 1);
    expect(app.frame()).toContain("Connections");
    expect(app.frame()).not.toContain("Step 1 of 3");
  });

  test("a failed connection stays on the first step", async () => {
    app = await first({ config: { connections: [{ name: "broken", url: "/nonexistent/dir/x.db" }] } });
    await app.press("<CR>");
    await app.press("broken<CR>");
    await app.waitFor(() => app.frame().includes("no such file"));
    expect(step()).toBe("connect");
  });

  test("a Provider can be chosen and tested on the way", async () => {
    const fake = fakeClaude(["ok"]);
    app = await first({ deps: { which: fake.which, exec: fake.exec } });
    await app.press("<CR>");
    await app.press("demo<CR>");
    await app.waitFor(() => step() === "agent");
    expect(app.frame()).toContain("9.9.9");
    await app.press("<CR>");
    await app.waitFor(() => app.frame().includes("Step 2 of 3 · Choose a model"));
    await app.press("<CR>");
    await app.waitFor(() => step() === "look");
    expect(app.api.config.config().agent.provider).toBe("claude");
    await app.press("<Esc>");
    await app.waitFor(() => step() === "agent");
    expect(app.frame()).toContain("●");
  });

  test("the look step previews, toggles Transparent and saves", async () => {
    app = await first();
    await app.press("<CR>");
    await app.press("demo<CR>");
    await app.waitFor(() => step() === "agent");
    await app.press("continue<CR>");
    await app.waitFor(() => step() === "look");
    await app.press("<C-t>");
    await app.waitFor(() => app.api.config.config().transparent);
    await app.press("kanagawa<CR>");
    await app.waitFor(() => step() === "done");
    expect((await savedConfig()).theme).toBe("kanagawa");
    expect((await savedConfig()).transparent).toBe(true);
  });

  test("omarchy is preselected when its colour file exists and no theme was chosen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "losql-omarchy-"));
    const file = join(dir, "colors.toml");
    await Bun.write(file, 'background = "#101010"\nforeground = "#eeeeee"\naccent = "#ff8800"\n');
    app = await first({ deps: { env: { LOSQL_OMARCHY_COLORS: file } } });
    await app.press("<CR>");
    await app.press("demo<CR>");
    await app.waitFor(() => step() === "agent");
    await app.press("continue<CR>");
    await app.waitFor(() => step() === "look");
    await app.press("<CR>");
    await app.waitFor(() => step() === "done");
    expect((await savedConfig()).theme).toBe("omarchy");
    await rm(dir, { recursive: true, force: true });
  });

  test("a theme set in the config is kept as the preselection", async () => {
    const dir = await mkdtemp(join(tmpdir(), "losql-omarchy-"));
    const file = join(dir, "colors.toml");
    await Bun.write(file, 'background = "#101010"\nforeground = "#eeeeee"\n');
    app = await first({ config: { theme: "nord" }, deps: { env: { LOSQL_OMARCHY_COLORS: file } } });
    await app.press("<CR>");
    await app.press("demo<CR>");
    await app.waitFor(() => step() === "agent");
    await app.press("continue<CR>");
    await app.waitFor(() => step() === "look");
    await app.press("<CR>");
    await app.waitFor(() => step() === "done");
    expect((await savedConfig()).theme).toBe("nord");
    await rm(dir, { recursive: true, force: true });
  });

  test("a Connection given on the command line skips the first step", async () => {
    app = await first({ connection: "demo" });
    await app.waitFor(() => app.api.session.status() === "connected");
    expect(step()).toBe("welcome");
    await app.press("<CR>");
    await app.waitFor(() => step() === "agent");
    expect(app.frame()).toContain("Step 2 of 3");
    await app.press("<Esc>");
    await app.waitFor(() => step() === "welcome");
  });

  test("ctrl+c twice quits from the welcome screen", async () => {
    app = await first();
    await app.press("<C-c><C-c>");
    expect(app.deps.exits).toEqual([0]);
  });

  test("shows version and fits small terminals at 40x12 and 20x8", async () => {
    app = await first();
    expect(app.frame()).toContain("losql");
    await app.resize(40, 12);
    const f40 = app.frame();
    expect(f40).toContain("enter");
    expect(f40).toContain("esc");
    for (const line of f40.split("\n")) {
      expect(Bun.stringWidth(line.trimEnd())).toBeLessThanOrEqual(40);
    }

    await app.resize(20, 8);
    const f20 = app.frame();
    expect(f20).toContain("enter");
    expect(f20).toContain("esc");
    expect(f20).not.toContain(LOGO[0]!.trimEnd());
    for (const line of f20.split("\n")) {
      expect(Bun.stringWidth(line.trimEnd())).toBeLessThanOrEqual(20);
    }
  });

  test("pressing Enter while a step dialog is still opening does not open two dialogs or skip a step", async () => {
    app = await first({ connection: "demo" });
    await app.waitFor(() => app.api.session.status() === "connected");
    await app.press("<CR>");
    await app.waitFor(() => step() === "agent");
    // "continue<CR>" selects "Continue without an agent", which awaits config.set and then opens look (which awaits theme.list); an immediate extra "<CR>" in the same press must not skip look
    await app.press("continue<CR><CR>");
    await app.waitFor(() => step() === "look");
    expect(step()).toBe("look");
    expect(app.api.dialog.depth()).toBe(1);
  });

  test("quitting from a step does not mark onboarding as done", async () => {
    app = await first();
    await app.press("<CR>");
    expect(step()).toBe("connect");
    await app.api.quit();
    expect(app.deps.exits).toEqual([0]);
    expect((await savedState()).onboarded).toBe(false);
  });

  test("when saving state fails on finish, shows workspace and reports warning toast", async () => {
    app = await first();
    app.api.config.setState = async () => {
      throw new Error("disk\x07full");
    };
    await app.press("<Esc>");
    await app.waitFor(() => step() === "done");
    expect(app.frame()).toContain("SCHEMA");
    expect(
      app.api.toast.items().some((t) => t.kind === "warning" && t.message.includes("disk\ufffdfull")),
    ).toBe(true);
    expect(app.api.toast.items().some((t) => t.message.includes("space"))).toBe(true);
  });

  test("when an initial connection is still in flight or fails, Enter shows connect step and does not jump later", async () => {
    let releaseConnect!: () => void;
    const holdConnect = new Promise<void>((r) => {
      releaseConnect = r;
    });
    let firstCall = true;
    app = await first({
      connection: "demo",
      deps: {
        openSession: async (conn) => {
          if (firstCall) {
            firstCall = false;
            await holdConnect;
          }
          const { openSession } = await import("../../core/db/connection");
          return openSession(conn, { env: app.deps.env });
        },
      },
    });
    expect(app.api.session.status()).toBe("connecting");
    await app.press("<CR>");
    expect(step()).toBe("connect");
    expect(app.frame()).toContain("Step 1 of 3 · Connect a database");
    releaseConnect();
    await app.waitFor(() => app.api.session.status() === "connected");
    expect(step()).toBe("connect");
    expect(app.api.dialog.depth()).toBe(1);
  });
});

test("later starts go straight to the workspace", async () => {
  app = await mount();
  expect(app.api.onboarding()).toBe("done");
  expect(app.frame()).toContain("SCHEMA");
});

describe("Task 23 review", () => {
  test("a failed save of the chosen Provider keeps the onboarding on its agent step", async () => {
    const fake = fakeClaude(["ok"]);
    app = await first({ connection: "demo", deps: { which: fake.which, exec: fake.exec } });
    await app.waitFor(() => app.api.session.status() === "connected");
    const realSet = app.api.config.set;
    app.api.config.set = async () => {
      throw new Error("permission denied");
    };
    await app.press("<CR>");
    await app.waitFor(() => step() === "agent");
    await app.press("continue<CR>");
    await app.waitFor(() => app.api.toast.items().some((t) => t.kind === "error" && t.message === "Could not save config: permission denied"));
    expect(step()).toBe("agent");
    expect(app.api.dialog.depth()).toBe(1);
    expect(app.frame()).toContain("Step 2 of 3 · Choose your agent");
    app.api.config.set = realSet;
    await app.press("continue<CR>");
    await app.waitFor(() => step() === "look");
  });

  test("a failed state write for the chosen Provider keeps the onboarding on its agent step", async () => {
    const fake = fakeClaude(["ok"]);
    app = await first({ connection: "demo", deps: { which: fake.which, exec: fake.exec } });
    await app.waitFor(() => app.api.session.status() === "connected");
    const realSetState = app.api.config.setState;
    app.api.config.setState = async () => {
      throw new Error("state dir locked");
    };
    await app.press("<CR>");
    await app.waitFor(() => step() === "agent");
    await app.press("<CR>");
    await app.waitFor(() => app.frame().includes("Step 2 of 3 · Choose a model"));
    await app.press("<CR>");
    await app.waitFor(() => app.api.toast.items().some((t) => t.message === "Could not save state: state dir locked"));
    await app.settle();
    expect(step()).toBe("agent");
    expect(app.frame()).toContain("Step 2 of 3 · Choose your agent");
    expect(app.api.config.config().agent.provider).toBeNull();
    app.api.config.setState = realSetState;
  });

  test("a step that fails to open is reported, and the welcome screen comes back and works", async () => {
    app = await first();
    const realOpen = app.api.dialog.open;
    let failures = 0;
    app.api.dialog.open = (...args) => {
      if (failures === 0) {
        failures++;
        throw new Error("cannot\x07open");
      }
      return realOpen(...args);
    };
    await app.press("<CR>");
    await app.settle();
    expect(failures).toBe(1);
    expect(app.api.status.message()).toEqual({ text: "cannot�open", kind: "error" });
    expect(step()).toBe("welcome");
    expect(app.frame()).toContain(TAGLINE);
    expect(app.api.dialog.depth()).toBe(0);
    await app.press("<CR>");
    expect(step()).toBe("connect");
    expect(app.frame()).toContain("Step 1 of 3 · Connect a database");
    await app.press("demo<CR>");
    await app.waitFor(() => step() === "agent");
  });

  test("the agent step that failed to open once opens on the next Enter", async () => {
    app = await first({ connection: "demo", deps: { which: () => null } });
    await app.waitFor(() => app.api.session.status() === "connected");
    const realOpen = app.api.dialog.open;
    let failures = 0;
    app.api.dialog.open = (...args) => {
      if (failures === 0) {
        failures++;
        throw new Error("agent step cannot open");
      }
      return realOpen(...args);
    };
    await app.press("<CR>");
    await app.settle();
    expect(failures).toBe(1);
    expect(app.api.status.message()).toEqual({ text: "agent step cannot open", kind: "error" });
    expect(step()).toBe("welcome");
    expect(app.frame()).toContain(TAGLINE);
    await app.press("<CR>");
    await app.waitFor(() => step() === "agent");
    expect(app.frame()).toContain("Step 2 of 3 · Choose your agent");
    expect(app.api.dialog.depth()).toBe(1);
  });

  test("going back and forth 200 times leaves nothing behind", async () => {
    app = await first();
    const realPush = app.api.keys.pushLayer;
    let activeLayers = 0;
    app.api.keys.pushLayer = (handler, options) => {
      activeLayers++;
      const remove = realPush(handler, options);
      let removed = false;
      return () => {
        if (!removed) {
          removed = true;
          activeLayers--;
        }
        remove();
      };
    };
    await app.press("<CR>");
    expect(step()).toBe("connect");
    for (let i = 0; i < 200; i++) {
      await app.press("demo<CR>");
      await app.waitFor(() => step() === "agent");
      await app.press("continue<CR>");
      await app.waitFor(() => step() === "look");
      await app.press("<Esc>");
      await app.waitFor(() => step() === "agent");
      await app.press("<Esc>");
      await app.waitFor(() => step() === "connect");
    }
    await app.press("demo<CR>");
    await app.waitFor(() => step() === "agent");
    await app.press("continue<CR>");
    await app.waitFor(() => step() === "look");
    await app.press("<CR>");
    await app.waitFor(() => step() === "done");
    await app.settle();
    expect(app.api.toast.items().filter((t) => t.message.includes("You are set")).length).toBe(1);
    expect(app.api.dialog.depth()).toBe(0);
    expect(activeLayers).toBe(0);
    expect(app.frame()).toContain("SCHEMA");
    const before = app.api.editor.text();
    await app.press("ix");
    expect(app.api.editor.mode()).toBe("insert");
    expect(app.api.editor.text().length).toBe(before.length + 1);
    expect(app.api.editor.text()).toContain("x");
  }, 120_000);
});
