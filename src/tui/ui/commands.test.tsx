import { afterEach, describe, expect, test } from "bun:test";
import { mount, type TestApp } from "../testing";

let app: TestApp;
afterEach(async () => { await app?.dispose(); });

const lastLine = () => app.frame().trimEnd().split("\n").pop()!;
const savedConfig = async () => JSON.parse(await Bun.file(app.deps.paths.configFile).text());

describe("the command line", () => {
  test(":q quits from every Pane", async () => {
    const exits: number[] = [];
    for (const pane of ["schema", "editor", "results", "agent"] as const) {
      app = await mount();
      app.api.focus.focus(pane);
      await app.press(":q<CR>");
      exits.push(...app.deps.exits);
      await app.dispose();
    }
    expect(exits).toEqual([0, 0, 0, 0]);
  });

  test("shows what is typed on the last row and closes on Escape", async () => {
    app = await mount();
    await app.press(":the");
    expect(app.api.cmdline.active()).toBe(true);
    expect(lastLine()).toContain(":the");
    expect(lastLine()).not.toContain("NORMAL");
    await app.press("<Esc>");
    expect(app.api.cmdline.active()).toBe(false);
    expect(lastLine()).toContain("NORMAL");
    expect(app.deps.exits).toEqual([]);
  });

  test("Backspace on an empty command line closes it", async () => {
    app = await mount();
    await app.press(":a<BS><BS>");
    expect(app.api.cmdline.active()).toBe(false);
  });

  test("an unambiguous prefix runs the command", async () => {
    app = await mount();
    await app.press(":qui<CR>");
    expect(app.deps.exits).toEqual([0]);
  });

  test("an unknown command is reported", async () => {
    app = await mount();
    await app.press(":frobnicate now<CR>");
    expect(app.api.status.message()).toEqual({ text: "Not a command: frobnicate", kind: "error" });
    expect(lastLine()).toContain("Not a command: frobnicate");
  });

  test("a command that throws is reported, not fatal", async () => {
    app = await mount();
    app.api.commands.register({ id: "test.boom", title: "Boom", ex: ["boom"], run: () => { throw new Error("it broke"); } });
    await app.press(":boom<CR>");
    expect(app.api.status.message()).toEqual({ text: "it broke", kind: "error" });
  });

  test("arguments reach the command", async () => {
    app = await mount();
    const seen: string[] = [];
    app.api.commands.register({ id: "test.echo", title: "Echo", ex: ["echo"], run: (_api, args) => { seen.push(args); } });
    await app.press(":echo  hello world <CR>");
    expect(seen).toEqual(["hello world"]);
  });

  test("the command line can be opened with another prefix", async () => {
    app = await mount();
    const seen: string[] = [];
    app.api.cmdline.open({ prefix: "/", onSubmit: (text) => seen.push(text), onCancel: () => seen.push("cancelled") });
    await app.settle();
    await app.press("orders");
    expect(lastLine()).toContain("/orders");
    await app.press("<CR>");
    expect(seen).toEqual(["orders"]);
    app.api.cmdline.open({ prefix: "?", onSubmit: (text) => seen.push(text), onCancel: () => seen.push("cancelled") });
    await app.settle();
    await app.press("<Esc>");
    expect(seen).toEqual(["orders", "cancelled"]);
  });
});

describe(":set and :theme", () => {
  test(":set changes and saves options", async () => {
    app = await mount();
    await app.press(":set transparent<CR>");
    expect(app.api.config.config().transparent).toBe(true);
    await app.press(":set notransparent<CR>");
    expect(app.api.config.config().transparent).toBe(false);
    await app.press(":set animations<CR>");
    expect(app.api.config.config().animations).toBe(true);
    await app.press(":set noanimations<CR>");
    expect(app.api.config.config().animations).toBe(false);
    await app.press(":set maxrows=50<CR>");
    expect(app.api.config.config().results.maxRows).toBe(50);
    await app.api.config.set((config) => config); // saves are chained, so this waits for the earlier ones
    expect((await savedConfig()).results.maxRows).toBe(50);
  });

  test(":set reports bad input", async () => {
    app = await mount();
    await app.press(":set maxrows=abc<CR>");
    expect(app.api.status.message()).toEqual({ text: "Invalid value for maxrows: abc", kind: "error" });
    await app.press(":set bogus<CR>");
    expect(app.api.status.message()).toEqual({ text: "Unknown option: bogus", kind: "error" });
    await app.press(":set<CR>");
    expect(app.api.status.message()?.text).toContain("transparent");
  });

  test(":theme switches themes", async () => {
    app = await mount();
    await app.press(":theme nord<CR>");
    await app.waitFor(() => app.api.theme.name() === "nord");
    await app.press(":theme nope<CR>");
    await app.waitFor(() => app.api.status.message() !== null);
    expect(app.api.status.message()).toEqual({ text: "unknown theme: nope", kind: "error" });
    expect(app.api.theme.name()).toBe("nord");
  });

  test(":<line> runs editor.gotoLine and :theme without arguments opens the Theme dialog through theme.pick", async () => {
    app = await mount();
    // `theme.pick` is always registered since the Theme dialog exists: `:theme` without a name opens it.
    await app.press(":theme<CR>");
    expect(app.api.dialog.depth()).toBe(1);
    expect(app.frame()).toContain("Themes");
    await app.press("<Esc>");
    expect(app.api.dialog.depth()).toBe(0);
    expect(app.api.theme.name()).toBe("tokyonight");

    const seen: string[] = [];
    app.api.commands.register({
      id: "theme.pick",
      title: "Pick theme",
      run: () => {
        seen.push("picked");
      },
    });
    app.api.commands.register({
      id: "editor.gotoLine",
      title: "Go to line",
      run: (_api, args) => {
        seen.push(`line:${args}`);
      },
    });

    await app.press(":theme<CR>");
    await app.press(":42<CR>");
    expect(seen).toEqual(["picked", "line:42"]);
  });
});

describe("the key menu", () => {
  test("the Leader opens it, a key runs its Command, and it closes", async () => {
    app = await mount();
    await app.press("<Space>");
    expect(app.frame()).toContain("Schema");
    expect(app.frame()).toContain("Help");
    await app.press("e");
    expect(app.api.focus.pane()).toBe("schema");
    expect(app.frame()).not.toContain("Help");
  });

  test("groups open a second level", async () => {
    app = await mount();
    const ran: string[] = [];
    app.api.commands.register({ id: "test.za", title: "Zed alpha", group: "Zed", keys: "z a", run: () => { ran.push("a"); } });
    app.api.commands.register({ id: "test.zb", title: "Zed beta", group: "Zed", keys: "z b", run: () => { ran.push("b"); } });
    await app.press("<Space>");
    expect(app.frame()).toContain("+Zed");
    expect(app.frame()).not.toContain("Zed alpha");
    await app.press("z");
    expect(app.frame()).toContain("Zed alpha");
    expect(app.frame()).toContain("Zed beta");
    await app.press("b");
    expect(ran).toEqual(["b"]);
  });

  test("Backspace goes up a level, Escape and unknown keys close", async () => {
    app = await mount();
    app.api.commands.register({ id: "test.za", title: "Zed alpha", group: "Zed", keys: "z a", run: () => {} });
    await app.press("<Space>z<BS>");
    expect(app.frame()).toContain("+Zed");
    await app.press("<Esc>");
    expect(app.frame()).not.toContain("+Zed");
    await app.press("<Space>~");
    expect(app.frame()).not.toContain("+Zed");
    expect(app.deps.exits).toEqual([]);
  });

  test("upper-case keys are distinct", async () => {
    app = await mount();
    const ran: string[] = [];
    app.api.commands.register({ id: "test.lower", title: "Lower", keys: "z", run: () => { ran.push("z"); } });
    app.api.commands.register({ id: "test.upper", title: "Upper", keys: "Z", run: () => { ran.push("Z"); } });
    await app.press("<Space>Z<Space>z");
    expect(ran).toEqual(["Z", "z"]);
  });

  test("a Pane that consumes the Leader key keeps it", async () => {
    app = await mount();
    app.api.keys.setPaneHandler("editor", (key) => key.name === "space");
    await app.press("<Space>");
    expect(app.frame()).not.toContain("Help");
  });

  test("the Leader key is configurable", async () => {
    app = await mount({ config: { leader: "," } });
    await app.press("<Space>");
    expect(app.frame()).not.toContain("Help");
    await app.press(",");
    expect(app.frame()).toContain("Help");
  });

  test("commands whose condition is false are not offered", async () => {
    app = await mount();
    app.api.commands.register({ id: "test.hidden", title: "Hidden thing", keys: "z", when: () => false, run: () => {} });
    await app.press("<Space>");
    expect(app.frame()).not.toContain("Hidden thing");
  });

  test("the key menu slides up over 100 ms when animations are on", async () => {
    app = await mount({ animations: true });
    await app.press("<Space>");
    const rowOfHelp = () => app.frame().split("\n").findIndex((l) => l.includes("Help"));
    const rowAt0 = rowOfHelp();
    expect(rowAt0).toBeGreaterThan(0);
    await app.advance(100);
    const rowAt100 = rowOfHelp();
    expect(rowAt100).toBeGreaterThan(0);
    expect(rowAt0).not.toBe(rowAt100);
    await app.press("<C-c>");
    expect(app.frame()).not.toContain("Help");
    await app.dispose();

    app = await mount({ animations: false });
    await app.press("<Space>");
    expect(rowOfHelp()).toBe(rowAt100);
  });
});

describe("the palette and help", () => {
  test("ctrl+p searches every Command", async () => {
    app = await mount();
    app.api.commands.register({ id: "test.hidden", title: "Hidden thing", when: () => false, run: () => {} });
    await app.press("<C-p>");
    expect(app.frame()).toContain("Commands");
    expect(app.frame()).toContain("Quit");
    expect(app.frame()).toContain(":quit");
    expect(app.frame()).not.toContain("Hidden thing");
    await app.press("quit<CR>");
    expect(app.deps.exits).toEqual([0]);
  });

  test("the palette shows Leader keys", async () => {
    app = await mount();
    await app.press("<C-p>schema");
    expect(app.frame()).toContain("space e");
  });

  test("F1, :help and the Leader ? open help", async () => {
    app = await mount();
    await app.press("<F1>");
    expect(app.frame()).toContain("Help");
    expect(app.frame()).toContain("ctrl+w");
    await app.press("q");
    expect(app.api.dialog.depth()).toBe(0);
    await app.press(":help<CR>");
    expect(app.api.dialog.depth()).toBe(1);
    await app.press("<Esc><Space>?");
    expect(app.api.dialog.depth()).toBe(1);
  });

  test("help lists registered Commands and scrolls", async () => {
    app = await mount();
    app.api.commands.register({ id: "test.zz", title: "Zed sleeps", ex: ["zzz"], run: () => {} });
    await app.press("<F1>");
    await app.press("G");
    expect(app.frame()).toContain(":zzz");
    expect(app.frame()).toContain("Zed sleeps");
    await app.press("gg");
    expect(app.frame()).toContain("ctrl+w");
  });
});
