import { afterEach, describe, expect, test } from "bun:test";
import type { PaneId } from "./context/focus";
import { fakeClaude, mount, type MountOptions, type TestApp } from "./testing";

let app: TestApp;
afterEach(async () => { await app?.dispose(); });

async function start(options: MountOptions = {}) {
  app = await mount({ width: 120, height: 40, ...options });
  await app.waitFor(() => app.api.session.status() === "connected");
}

/** Both sidebars shown, the last centre Pane is `centre`, and the focus is on `pane`. */
async function at(pane: PaneId, centre: "editor" | "results" = "editor") {
  app.api.focus.setVisible("schema", true);
  app.api.focus.setVisible("agent", true);
  app.api.focus.focus(centre);
  app.api.focus.focus(pane);
  await app.settle();
}

const pane = () => app.api.focus.pane();
const text = () => app.api.editor.text();

/** Puts `value` into the Editor and the cursor on the first character, in normal mode. */
async function editorText(value: string) {
  app.api.focus.focus("editor");
  app.api.editor.setText(value);
  await app.settle();
  await app.press("<Esc>gg0");
}

const PANES: PaneId[] = ["schema", "editor", "results", "agent"];
const LETTERS = ["h", "j", "k", "l"] as const;

describe("shift+h/j/k/l move the focus between Panes", () => {
  test("from every Pane each key lands where ctrl and the same letter lands (both sidebars shown)", async () => {
    await start();
    const seen: string[] = [];
    for (const centre of ["editor", "results"] as const) {
      for (const from of PANES) {
        for (const letter of LETTERS) {
          await at(from, centre);
          await app.press(`<C-${letter}>`);
          const expected = pane();
          await at(from, centre);
          await app.press(letter.toUpperCase());
          seen.push(`${centre} ${from} ${letter}: ${pane()}`);
          expect(`${centre} ${from} ${letter}: ${pane()}`).toBe(`${centre} ${from} ${letter}: ${expected}`);
        }
      }
    }
    // The moves themselves, spelled out once.
    expect(seen).toContain("editor editor h: schema");
    expect(seen).toContain("editor editor j: results");
    expect(seen).toContain("editor editor l: agent");
    expect(seen).toContain("editor results k: editor");
    expect(seen).toContain("editor schema l: editor");
    expect(seen).toContain("results schema l: results");
    expect(seen).toContain("editor agent h: editor");
    expect(seen).toContain("results agent h: results");
  });

  test("H leaves the Agent Pane for the centre Pane focused last", async () => {
    await start();
    await at("agent", "results");
    await app.press("H");
    expect(pane()).toBe("results");
    await at("agent", "editor");
    await app.press("H");
    expect(pane()).toBe("editor");
  });

  test("with the Agent sidebar hidden, L from the centre does nothing", async () => {
    await start();
    app.api.focus.setVisible("agent", false);
    app.api.focus.focus("editor");
    await app.press("L");
    expect(pane()).toBe("editor");
    expect(app.api.focus.visible("agent")).toBe(false);
    app.api.focus.focus("results");
    await app.press("L");
    expect(pane()).toBe("results");
    expect(app.api.focus.visible("agent")).toBe(false);
  });

  test("with the Schema sidebar hidden, H from the centre does nothing", async () => {
    await start();
    app.api.focus.setVisible("schema", false);
    app.api.focus.focus("editor");
    await app.press("H");
    expect(pane()).toBe("editor");
    expect(app.api.focus.visible("schema")).toBe(false);
  });

  test("with both sidebars hidden J and K still move between Editor and Results", async () => {
    await start();
    app.api.focus.setVisible("schema", false);
    app.api.focus.setVisible("agent", false);
    app.api.focus.focus("editor");
    await app.press("J");
    expect(pane()).toBe("results");
    await app.press("K");
    expect(pane()).toBe("editor");
  });
});

describe("the Editor keeps text and vim commands in progress", () => {
  test("in insert mode H, J, K and L are typed and the focus stays", async () => {
    await start();
    await editorText("");
    await app.press("iHJKL");
    expect(pane()).toBe("editor");
    expect(app.api.editor.mode()).toBe("insert");
    await app.press("<Esc>");
    expect(text()).toBe("HJKL");
  });

  test("in visual mode J goes to the vim engine as before and the focus stays", async () => {
    // The engine has no visual-mode J (it never joined lines there): the key stays with the Editor.
    await start();
    await editorText("a\nb\nc");
    await app.press("VjJ");
    expect(pane()).toBe("editor");
    expect(app.api.editor.mode()).toBe("visual-line");
    expect(text()).toBe("a\nb\nc");
    await app.press("vHKL");
    expect(pane()).toBe("editor");
    expect(app.api.editor.mode()).toBe("visual");
  });

  test("a counted J joins as many lines", async () => {
    await start();
    await editorText("a\nb\nc\nd");
    await app.press("3J");
    expect(pane()).toBe("editor");
    expect(text()).toBe("a b c\nd");
  });

  test("dJ behaves as before: nothing changes and the focus stays", async () => {
    await start();
    await editorText("a\nb\nc");
    await app.press("dJ");
    expect(pane()).toBe("editor");
    expect(text()).toBe("a\nb\nc");
    expect(app.api.status.current().pending).toBe("");
    // the operator is gone: the next key is a plain key again
    await app.press("x");
    expect(text()).toBe("\nb\nc");
  });

  test("a key after f, t, r, a register or g is the argument, not a move", async () => {
    await start();
    await editorText("aHbJcKdLe");
    await app.press("fJ");
    expect(pane()).toBe("editor");
    expect(app.api.editor.cursor()).toEqual({ row: 0, col: 3 });
    await app.press("tL");
    expect(pane()).toBe("editor");
    expect(app.api.editor.cursor()).toEqual({ row: 0, col: 6 });
    await app.press("rH");
    expect(pane()).toBe("editor");
    expect(text()).toBe("aHbJcKHLe");
    await app.press('"Kyl');
    expect(pane()).toBe("editor");
    await app.press("gK");
    expect(pane()).toBe("editor");
    expect(app.api.status.current().pending).toBe("");
  });

  test("gJ and 3gJ join lines and . repeats them", async () => {
    await start();
    await editorText("a\nb\nc\nd\ne\nf\ng");
    await app.press("gJ");
    expect(pane()).toBe("editor");
    expect(text()).toBe("a b\nc\nd\ne\nf\ng");
    await app.press(".");
    expect(text()).toBe("a b c\nd\ne\nf\ng");
    await app.press("j03gJ");
    expect(text()).toBe("a b c\nd e f\ng");
    expect(pane()).toBe("editor");
  });

  test(". repeats a counted J", async () => {
    await start();
    await editorText("a\nb\nc\nd\ne\nf");
    await app.press("3Jj0.");
    expect(text()).toBe("a b c\nd e f");
    expect(pane()).toBe("editor");
  });

  test("plain J in normal mode leaves the Buffer unchanged and focuses Results", async () => {
    await start();
    await editorText("a\nb\nc");
    await app.press("J");
    expect(text()).toBe("a\nb\nc");
    expect(pane()).toBe("results");
    expect(app.api.editor.mode()).toBe("normal");
  });
});

describe("the Agent Pane", () => {
  async function startAgent() {
    const fake = fakeClaude([]);
    await start({ config: { agent: { provider: "claude" } }, deps: { which: fake.which, exec: fake.exec } });
    await app.waitFor(() => app.api.agent.providers().length === 4);
  }

  test("in insert mode H is typed into the input; after Esc, H moves to the centre", async () => {
    await startAgent();
    await app.press("<Space>ai");
    expect(pane()).toBe("agent");
    expect(app.api.status.current().mode).toBe("INSERT");
    await app.press("HJKL");
    expect(pane()).toBe("agent");
    expect(app.frame()).toContain("> HJKL");
    await app.press("<Esc>H");
    expect(pane()).toBe("editor");
  });

  test("ctrl+h moves the focus left when the input is not in insert mode", async () => {
    await startAgent();
    await app.press("<Space>aa");
    expect(pane()).toBe("agent");
    expect(app.api.status.current().mode).toBe("NORMAL");
    await app.press("<C-h>");
    expect(pane()).toBe("editor");
  });

  test("after g the next key goes to the Agent Pane, not to a move", async () => {
    await startAgent();
    await app.press("<Space>aa");
    expect(pane()).toBe("agent");
    await app.press("g");
    expect(app.api.status.current().pending).toBe("g");
    await app.press("H");
    expect(pane()).toBe("agent");
    expect(app.api.status.current().pending).toBe("");
    await app.press("H");
    expect(pane()).toBe("editor");
  });
});

describe("layers come first", () => {
  test("with a dialog open J does not move the focus behind it", async () => {
    await start();
    app.api.focus.focus("editor");
    await app.press("<F1>");
    expect(app.api.dialog.depth()).toBe(1);
    await app.press("JHLK");
    expect(pane()).toBe("editor");
    await app.press("<Esc>");
    expect(app.api.dialog.depth()).toBe(0);
    expect(pane()).toBe("editor");
  });

  test("on the command line H, J, K and L are text", async () => {
    await start();
    app.api.focus.focus("editor");
    await app.press(":JHKL");
    expect(pane()).toBe("editor");
    expect(app.frame()).toContain(":JHKL");
    await app.press("<Esc>");
  });

  test("with the Leader menu open J does not move the focus", async () => {
    await start();
    app.api.focus.focus("editor");
    await app.press("<Space>J");
    expect(pane()).toBe("editor");
  });

  test("the ctrl+w chord takes the next key as before (one move, not two)", async () => {
    await start();
    app.api.focus.focus("editor");
    await app.press("<C-w>J");
    expect(pane()).toBe("results");
    expect(app.api.keys.chord()).toBe("");
    await app.press("<C-w>K");
    expect(pane()).toBe("editor");
  });
});

describe("F1 help", () => {
  test("names shift+h/j/k/l with the global keys and gJ with the Editor keys", async () => {
    await start({ height: 60 });
    await app.press("<F1>");
    let seen = app.frame();
    for (let i = 0; i < 6; i++) {
      await app.press("<C-d>");
      seen += app.frame();
    }
    expect(seen).toContain("shift+h/j/k/l");
    expect(seen).toContain("gJ");
  });
});
