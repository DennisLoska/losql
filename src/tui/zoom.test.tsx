import { afterEach, describe, expect, test } from "bun:test";
import type { PaneId } from "./context/focus";
import { mount, type MountOptions, type TestApp } from "./testing";

let app: TestApp;
afterEach(async () => { await app?.dispose(); });

async function start(options: MountOptions = {}) {
  app = await mount({ width: 120, height: 40, ...options });
  await app.waitFor(() => app.api.session.status() === "connected");
  app.api.focus.setVisible("schema", true);
  app.api.focus.setVisible("agent", true);
  app.api.focus.focus("editor");
  await app.settle();
}

const ROWS_200 =
  "with recursive c(x) as (select 1 union all select x + 1 from c where x < 200) select x as n, 'row-' || x as label from c";
const WIDE = `select ${Array.from({ length: 40 }, (_, i) => `'value-${i + 1}-${"x".repeat(10)}' as column_${String(i + 1).padStart(2, "0")}`).join(", ")}`;

async function show(sql: string) {
  await app.api.session.run({ statements: [sql] });
  await app.settle();
}

const pane = () => app.api.focus.pane();
const zoomed = () => app.api.focus.zoomed();
const lines = () => app.frame().split("\n");
/** The screen line of the status line (the one with the mode). */
const statusRow = () => lines().findIndex((line) => /^ (NORMAL|INSERT|VISUAL|V-LINE) /.test(line));
const dataRows = () => lines().filter((line) => /row-\d+/.test(line)).length;
const editorTab = () => ` 1 ${app.api.editor.buffers()[0]!.name} `;

describe("space z shows the Results Pane full screen", () => {
  test("with both sidebars and 200 rows: only the Results Pane is drawn, from the first line to the status line", async () => {
    await start();
    await show(ROWS_200);
    const before = app.frame();
    expect(before).toContain("SCHEMA");
    expect(before).toContain("AGENT");
    expect(before).toContain(editorTab());
    const rowsBefore = dataRows();

    await app.press("<Space>z");
    expect(zoomed()).toBe(true);
    expect(pane()).toBe("results");
    const frame = app.frame();
    expect(frame).not.toContain("SCHEMA");
    expect(frame).not.toContain("AGENT");
    expect(frame).not.toContain(editorTab());
    expect(lines()[0]).toContain("RESULTS");
    const status = statusRow();
    expect(status).toBe(39);
    expect(lines()[status - 1]).toMatch(/row-\d+/); // the last drawn row sits directly above the status line
    expect(dataRows()).toBeGreaterThan(rowsBefore);
    expect(dataRows()).toBe(status - 2); // the header line and the column names, then rows only
  });

  test("G shows the last row and gg the first", async () => {
    await start();
    await show(ROWS_200);
    await app.press("<Space>z");
    await app.press("G");
    expect(app.api.results.cursor().row).toBe(199);
    expect(app.frame()).toContain("row-200");
    expect(lines()[statusRow() - 1]).toContain("row-200");
    await app.press("gg");
    expect(app.api.results.cursor().row).toBe(0);
    expect(lines()[2]).toMatch(/row-1(?!\d)/);
    await app.press("<C-d>");
    expect(app.api.results.cursor().row).toBeGreaterThan(10);
    await app.press("<C-u>");
    expect(app.api.results.cursor().row).toBe(0);
  });

  test("a wide Result scrolls horizontally and shows more columns than before", async () => {
    await start();
    await show(WIDE);
    const columnsShown = () => (app.frame().match(/column_\d\d/g) ?? []).length;
    const before = columnsShown();
    await app.press("<Space>z");
    expect(columnsShown()).toBeGreaterThan(before);
    expect(app.frame()).not.toContain("column_40");
    await app.press("$");
    expect(app.frame()).toContain("column_40");
    expect(app.frame()).not.toContain("column_01");
    await app.press("0");
    expect(app.frame()).toContain("column_01");
  });

  test("the JSON and Record views fill the area", async () => {
    await start();
    await show(ROWS_200);
    await app.press("<Space>z<Tab>");
    expect(app.api.results.view()).toBe("json");
    expect(lines()[0]).toContain("RESULTS");
    expect(lines()[statusRow() - 1]!.trim()).not.toBe("");
    await app.press("G");
    expect(app.frame()).toContain("row-200");

    await show(WIDE);
    await app.press("<Tab><Tab>");
    expect(app.api.results.view()).toBe("record");
    expect(app.frame()).toContain("column_01");
    expect(app.frame()).toContain("column_30");
  });

  test("space z again brings back exactly the frame from before", async () => {
    await start();
    await show(ROWS_200);
    await app.press("<C-w>j<C-w>k"); // the last centre Pane is Results, the focus is on the Editor
    const before = app.frame();
    await app.press("<Space>z");
    expect(app.frame()).not.toBe(before);
    await app.press("<Space>z");
    expect(zoomed()).toBe(false);
    expect(pane()).toBe("editor");
    expect(app.frame()).toBe(before);
  });

  for (const from of ["editor", "schema", "agent", "results"] as PaneId[]) {
    test(`from the ${from} Pane the focus goes back there and the layout is the same`, async () => {
      await start();
      await show(ROWS_200);
      app.api.focus.focus(from);
      await app.settle();
      const before = app.frame();
      await app.press("<Space>z");
      expect(pane()).toBe("results");
      await app.press("<Space>z");
      expect(pane()).toBe(from);
      expect(app.api.focus.visible("schema")).toBe(true);
      expect(app.api.focus.visible("agent")).toBe(true);
      expect(app.frame()).toBe(before);
    });
  }

  test("H from the Agent Pane still goes to the centre Pane focused before zooming", async () => {
    await start();
    app.api.focus.focus("agent");
    await app.press("<Space>z<Space>zH");
    expect(pane()).toBe("editor");
  });

  test("the layout without sidebars comes back too", async () => {
    await start();
    app.api.focus.setVisible("schema", false);
    app.api.focus.setVisible("agent", false);
    await app.settle();
    const before = app.frame();
    await app.press("<Space>z<Space>z");
    expect(app.api.focus.visible("schema")).toBe(false);
    expect(app.api.focus.visible("agent")).toBe(false);
    expect(app.frame()).toBe(before);
  });

  test("works without a Result: the empty state is shown full screen", async () => {
    await start();
    await app.press("<Space>z");
    expect(zoomed()).toBe(true);
    expect(lines()[0]).toContain("RESULTS");
    expect(app.frame()).toContain("Run a statement with Enter");
    expect(app.frame()).not.toContain("SCHEMA");
    expect(app.frame()).not.toContain("AGENT");
  });

  test("keys that move the focus do nothing while zoomed", async () => {
    await start();
    await show(ROWS_200);
    await app.press("<Space>z");
    for (const key of ["<C-h>", "<C-k>", "<C-l>", "<C-j>", "<C-w>h", "<C-w>k", "<C-w>l", "<C-w>w", "H", "K", "L", "J"]) {
      await app.press(key);
      expect(`${key}: ${pane()} ${zoomed()}`).toBe(`${key}: results true`);
    }
    expect(app.frame()).not.toContain("SCHEMA");
  });

  test("Leader e leaves zoom and then shows the Schema Pane", async () => {
    await start();
    app.api.focus.setVisible("schema", false);
    await app.press("<Space>z");
    await app.press("<Space>e");
    expect(zoomed()).toBe(false);
    expect(pane()).toBe("schema");
    expect(app.frame()).toContain("SCHEMA");
  });

  test("Leader e after zooming from the Schema Pane leaves zoom and then hides it, as without zoom", async () => {
    await start();
    app.api.focus.focus("schema");
    await app.press("<Space>z<Space>e");
    expect(zoomed()).toBe(false);
    expect(app.api.focus.visible("schema")).toBe(false);
    expect(pane()).toBe("editor");
  });

  test("the Agent toggle leaves zoom and focuses the Agent Pane", async () => {
    await start();
    await app.press("<Space>z<Space>aa");
    expect(zoomed()).toBe(false);
    expect(pane()).toBe("agent");
    expect(app.frame()).toContain("AGENT");
  });

  test("opening a Buffer leaves zoom", async () => {
    await start();
    await app.press("<Space>z");
    await app.press(":new<CR>");
    expect(zoomed()).toBe(false);
    expect(app.api.editor.buffers().length).toBe(2);
    expect(app.frame()).toContain("SCHEMA");
  });

  test("running a Statement keeps the zoom and shows the new Result in it", async () => {
    await start();
    app.api.editor.setText(ROWS_200);
    await app.settle();
    await app.press("<Space>z");
    await app.press("<Space>r");
    await app.waitFor(() => app.api.session.running() === null && app.frame().includes("row-1"));
    expect(zoomed()).toBe(true);
    expect(pane()).toBe("results");
    expect(lines()[statusRow() - 1]).toMatch(/row-\d+/);
  });

  test(":zoom toggles", async () => {
    await start();
    await app.press(":zoom<CR>");
    expect(zoomed()).toBe(true);
    await app.press(":zoom<CR>");
    expect(zoomed()).toBe(false);
    expect(pane()).toBe("editor");
  });

  test("the status line shows ZOOM while zoomed", async () => {
    await start();
    expect(lines()[statusRow()]).not.toContain("ZOOM");
    await app.press("<Space>z");
    expect(lines()[statusRow()]).toContain("ZOOM");
    await app.press("<Space>z");
    expect(lines()[statusRow()]).not.toContain("ZOOM");
  });

  test("a resize while zoomed is followed", async () => {
    await start();
    await show(ROWS_200);
    await app.press("<Space>z");
    await app.resize(100, 30);
    expect(statusRow()).toBe(29);
    expect(lines()[0]).toContain("RESULTS");
    expect(lines()[28]).toMatch(/row-\d+/);
    expect(dataRows()).toBe(27);
    await app.resize(150, 50);
    expect(statusRow()).toBe(49);
    expect(lines()[48]).toMatch(/row-\d+/);
    expect(dataRows()).toBe(47);
    expect(app.frame()).not.toContain("SCHEMA");
  });

  test("the Leader menu, the palette and F1 name it", async () => {
    await start();
    await app.press("<Space>");
    expect(app.frame()).toContain("Zoom results");
    await app.press("<Esc><C-p>");
    await app.press("zoom");
    expect(app.frame()).toContain("Zoom results");
    await app.press("<CR>");
    expect(zoomed()).toBe(true);
    await app.press("<F1>");
    let seen = app.frame();
    for (let i = 0; i < 8; i++) {
      await app.press("<C-d>");
      seen += app.frame();
    }
    expect(seen).toMatch(/space z\s+Zoom results/);
  });

  test("a new start is not zoomed", async () => {
    await start();
    await app.press("<Space>z");
    await app.dispose();
    await start();
    expect(zoomed()).toBe(false);
  });
});
