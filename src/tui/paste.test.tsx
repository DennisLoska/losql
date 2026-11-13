import { afterEach, describe, expect, test } from "bun:test";
import type { Renderable } from "@opentui/core";
import type { Position } from "../core/vim/buffer";
import { fromBufferCol } from "./panes/editor/edit-buffer-text";
import { VimTextareaRenderable } from "./panes/editor/VimTextareaRenderable";
import { fakeClaude, mount, type MountOptions, type TestApp } from "./testing";

// Every paste here reaches the program the way a terminal sends it: the bytes of a bracketed
// paste (ESC [ 200 ~, the text, ESC [ 201 ~) on the renderer's input. `keys.paste` is never called
// directly, so the terminal library's own delivery of the paste is part of what is tested.

let app: TestApp;
afterEach(async () => {
  await app?.dispose();
});

async function start(text = "12", options: MountOptions = {}) {
  app = await mount(options);
  await app.waitFor(() => app.api.session.status() === "connected");
  app.api.editor.setText(text);
  await app.settle();
}

async function startWithAgent(text = "12") {
  const fake = fakeClaude(["unused"]);
  app = await mount({ config: { agent: { provider: "claude" } }, deps: { which: fake.which, exec: fake.exec } });
  await app.waitFor(() => app.api.session.status() === "connected" && app.api.agent.providers().length === 4);
  app.api.editor.setText(text);
  await app.settle();
}

async function paste(text: string) {
  await app.setup.mockInput.pasteBracketedText(text);
  await app.settle();
}

function textareas(): VimTextareaRenderable[] {
  const found: VimTextareaRenderable[] = [];
  const walk = (node: Renderable) => {
    if (node instanceof VimTextareaRenderable) found.push(node);
    for (const child of node.getChildren()) walk(child as Renderable);
  };
  walk(app.setup.renderer.root);
  return found;
}

/** The textarea that shows the Editor's Buffer (the Results Pane's JSON view has one as well). */
function editorTextarea(): VimTextareaRenderable {
  const all = textareas().filter((t) => !t.isDestroyed && t.editBuffer.getText() === app.api.editor.text());
  const ta = all[0] ?? textareas()[0];
  if (!ta) throw new Error("no textarea");
  return ta;
}

/** The textarea's own cursor, in UTF-16 columns as the engine counts them. */
function textareaCursor(ta: VimTextareaRenderable): Position {
  const { row, col } = ta.editBuffer.getCursorPosition();
  const line = ta.editBuffer.getText().split("\n")[row] ?? "";
  return { row, col: fromBufferCol(ta.editBuffer, row, line, col) };
}

/** The Editor's engine and its textarea agree on text and cursor, and the text is `text`. */
function expectEditor(text: string, cursor?: Position) {
  expect(app.api.editor.text()).toBe(text);
  const editorTas = textareas().filter((t) => t.editBuffer.getText() === text);
  expect(editorTas.length).toBeGreaterThanOrEqual(1);
  const ta = editorTextarea();
  expect(ta.editBuffer.getText()).toBe(text);
  expect(textareaCursor(ta)).toEqual(app.api.editor.cursor());
  if (cursor) expect(app.api.editor.cursor()).toEqual(cursor);
}

function insertAt(text: string, pos: Position, inserted: string): string {
  const lines = text.split("\n");
  const line = lines[pos.row]!;
  lines[pos.row] = line.slice(0, pos.col) + inserted + line.slice(pos.col);
  return lines.join("\n");
}

/**
 * With the Editor focused: one typed character lands at the engine's cursor, and `u` restores
 * `before` in one step. In insert mode the paste and the typed character are one insert, so one
 * `u` takes both back; in normal mode the paste is its own change, after the one that typed `X`.
 * Leaves the Editor in normal mode.
 */
async function expectTypingAndUndo(before: string) {
  expect(app.api.focus.pane()).toBe("editor");
  const text = app.api.editor.text();
  const cursor = app.api.editor.cursor();
  const insert = app.api.editor.mode() === "insert";
  await app.press(insert ? "X" : "iX");
  expectEditor(insertAt(text, cursor, "X"), { row: cursor.row, col: cursor.col + 1 });
  await app.press("<Esc>u");
  if (!insert) {
    expectEditor(text);
    await app.press("u");
  }
  expectEditor(before);
  await app.press("u");
  expectEditor(before);
}

describe("a paste meant for the Editor arrives once", () => {
  test("insert mode: 12, li, paste xyz gives 1xyz2", async () => {
    await start("12");
    await app.press("li");
    await paste("xyz");
    expect(app.frame()).toContain("1xyz2");
    expect(app.frame()).not.toContain("xyzxyz");
    expectEditor("1xyz2", { row: 0, col: 4 });
    await expectTypingAndUndo("12");
  });

  test("normal mode: the Pane's handler inserts after the cursor, once", async () => {
    await start("12");
    await paste("xyz");
    expect(app.frame()).not.toContain("xyzxyz");
    expect(app.api.editor.mode()).toBe("normal");
    expectEditor("1xyz2");
    await expectTypingAndUndo("12");
  });

  test("insert mode, a line feed in the paste: two lines and the cursor after b", async () => {
    await start("12");
    await app.press("li");
    await paste("a\nb");
    expectEditor("1a\nb2", { row: 1, col: 1 });
    expect(app.api.status.current().position).toBe("2:2");
    await app.press("X");
    expectEditor("1a\nbX2", { row: 1, col: 2 });
    await app.press("<Esc>u");
    expectEditor("12");
  });

  test("two pastes in a row", async () => {
    await start("12");
    await app.press("li");
    await paste("xyz");
    await paste("abc");
    expectEditor("1xyzabc2", { row: 0, col: 7 });
    await expectTypingAndUndo("12");
  });

  test("a paste with CRLF, a tab and ESC", async () => {
    await start("12");
    await app.press("li");
    await paste("a\r\nb\tc\x1bd");
    expectEditor("1a\nb\tc\x1bd2", { row: 1, col: 5 });
    await expectTypingAndUndo("12");
  });

  test("a paste of 1 MB", async () => {
    await start("12");
    await app.press("li");
    const line = "select 1234567890 from abcdefghijklmnopqrstuvwxyz where x = 1;";
    const big = `${line}\n`.repeat(Math.ceil((1024 * 1024) / (line.length + 1)));
    expect(big.length).toBeGreaterThanOrEqual(1024 * 1024);
    await paste(big);
    const lines = big.split("\n").length;
    expectEditor(`1${big}2`, { row: lines - 1, col: 0 });
    await expectTypingAndUndo("12");
  }, 30_000);

  test("while the completion popup is open", async () => {
    await start("");
    await app.waitFor(() => app.api.session.schema() !== null);
    await app.press("iselect * from cu<C-n>");
    expect(app.api.editor.completion()).not.toBeNull();
    await paste("x");
    expect(app.api.editor.completion()).toBeNull();
    expectEditor("select * from cux", { row: 0, col: 17 });
    await expectTypingAndUndo("");
  });
});

describe("a paste meant for another input leaves the Buffer alone", () => {
  async function expectBufferUntouched() {
    expect(app.api.focus.pane()).toBe("editor");
    expect(app.api.editor.mode()).toBe("normal");
    expectEditor("12", { row: 0, col: 0 });
    await expectTypingAndUndo("12");
  }

  test("the command line", async () => {
    await start("12");
    await app.press(":");
    await paste("abc");
    expect(app.api.cmdline.input.text()).toBe("abc");
    expect(app.frame()).toContain(":abc");
    expectEditor("12");
    await app.press("<Esc>");
    expect(app.api.cmdline.active()).toBe(false);
    await expectBufferUntouched();
  });

  test("the key menu", async () => {
    await start("12");
    await app.press("<Space>");
    expect(app.frame()).toContain("Help");
    await paste("abc");
    expectEditor("12");
    await app.press("<Esc>");
    expect(app.frame()).not.toContain("Help");
    await expectBufferUntouched();
  });

  test("the Connections dialog's filter", async () => {
    await start("12");
    await app.press("<Space>c");
    expect(app.api.dialog.depth()).toBe(1);
    await paste("dem");
    expect(app.frame()).toContain("dem");
    expectEditor("12");
    await app.press("<Esc>");
    await app.waitFor(() => app.api.dialog.depth() === 0);
    await expectBufferUntouched();
  });
});

describe("a paste while another Pane is focused leaves the Buffer alone", () => {
  async function backToEditor() {
    app.api.focus.focus("editor");
    await app.settle();
    expect(app.api.editor.mode()).toBe("normal");
    expectEditor("12", { row: 0, col: 0 });
    await expectTypingAndUndo("12");
  }

  test("the Results Pane", async () => {
    await start("12");
    app.api.focus.focus("results");
    await app.settle();
    await paste("abc");
    expectEditor("12");
    await backToEditor();
  });

  test("the Results Pane in its JSON view", async () => {
    await start("12");
    await app.api.session.run({ statements: ["select 1 as one"], record: false, show: true });
    await app.waitFor(() => app.api.session.shown() !== null);
    app.api.results.setView("json");
    app.api.focus.focus("results");
    await app.settle();
    const json = textareas().find((t) => t.editBuffer.getText() !== "12");
    expect(json).toBeDefined();
    const jsonText = json!.editBuffer.getText();
    await paste("abc");
    expect(json!.editBuffer.getText()).toBe(jsonText);
    expectEditor("12");
    await backToEditor();
  });

  test("the Schema Pane", async () => {
    await start("12");
    app.api.focus.focus("schema");
    await app.settle();
    await paste("abc");
    expectEditor("12");
    await backToEditor();
  });

  test("the Agent Pane in normal mode", async () => {
    await startWithAgent("12");
    app.api.focus.focus("agent");
    await app.settle();
    await paste("pasted");
    expect(app.frame()).toContain("pasted");
    expectEditor("12");
    await backToEditor();
  });

  test("the Agent Pane in insert mode", async () => {
    await startWithAgent("12");
    app.api.focus.focus("agent");
    await app.press("i");
    await paste("pasted");
    expect(app.frame()).toContain("pasted");
    expectEditor("12");
    await app.press("<Esc>");
    await backToEditor();
  });

  test("the Agent Pane with a dialog over it", async () => {
    await startWithAgent("12");
    app.api.focus.focus("agent");
    await app.settle();
    await app.press("<Space>c");
    expect(app.api.dialog.depth()).toBe(1);
    await paste("dem");
    expectEditor("12");
    await app.press("<Esc>");
    await app.waitFor(() => app.api.dialog.depth() === 0);
    await backToEditor();
  });
});
