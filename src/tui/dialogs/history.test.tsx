import { afterEach, describe, expect, test } from "bun:test";
import { appendHistory, type HistoryEntry } from "../../core/state";
import { mount, type TestApp } from "../testing";
import { historyOptions } from "./history";

let app: TestApp;
afterEach(async () => { await app?.dispose(); });

const entry = (sql: string, extra: Partial<HistoryEntry> = {}): HistoryEntry =>
  ({ ts: "2026-11-11T10:00:00.000Z", connection: "demo", sql, ok: true, rows: 3, ms: 2, ...extra });

test("historyOptions: newest first, duplicates collapsed, one line each", () => {
  const options = historyOptions([
    entry("select 1"),
    entry("select *\nfrom orders\nwhere id = 1", { rows: 1, ms: 12 }),
    entry("select * from nope", { ok: false, rows: null }),
    entry("select 1", { rows: 1, ms: 5 }),
  ]);
  expect(options.map((o) => [o.title, o.hint, o.value])).toEqual([
    ["select 1", "1 row · 5 ms", "select 1"],
    ["select * from nope", "error", "select * from nope"],
    ["select * …", "1 row · 12 ms", "select *\nfrom orders\nwhere id = 1"],
  ]);
  expect(historyOptions([entry("x".repeat(100))])[0]!.title.length).toBeLessThanOrEqual(61);
  expect(historyOptions([])).toEqual([]);
});

describe("the history dialog", () => {
  test("lists this Connection's Runs and opens the chosen one in a new Buffer", async () => {
    app = await mount({
      seed: async (deps) => {
        await appendHistory(deps.paths, entry("select 'elsewhere'", { connection: "other" }));
      },
    });
    await app.waitFor(() => app.api.session.status() === "connected");
    await app.api.session.run({ statements: ["select 1 as first", "select 2 as second"] });
    await app.press("<Space>h");
    await app.waitFor(() => app.api.dialog.depth() === 1);
    expect(app.frame()).toContain("History");
    expect(app.frame()).toContain("select 2 as second");
    expect(app.frame()).toContain("select 1 as first");
    expect(app.frame()).not.toContain("elsewhere");
    await app.press("first<CR>");
    await app.waitFor(() => app.api.dialog.depth() === 0);
    expect(app.api.editor.buffers().length).toBe(2);
    expect(app.api.editor.text()).toBe("select 1 as first");
    expect(app.api.focus.pane()).toBe("editor");
  });

  test(":history with nothing recorded", async () => {
    app = await mount();
    await app.waitFor(() => app.api.session.status() === "connected");
    await app.press(":history<CR>");
    await app.waitFor(() => app.api.dialog.depth() === 1);
    expect(app.frame()).toContain("No history yet");
  });

  test("without a Session it lists every Connection's Runs", async () => {
    app = await mount({
      connection: null,
      seed: async (deps) => {
        await appendHistory(deps.paths, entry("select 'elsewhere'", { connection: "other" }));
      },
    });
    await app.press("<Esc>:history<CR>");
    await app.waitFor(() => app.frame().includes("elsewhere"));
  });

  test("scales to 5,000 entries and sanitizes control characters", async () => {
    const bulk: HistoryEntry[] = Array.from({ length: 5000 }, (_, i) =>
      entry(`select ${i} as col_${i} -- query number ${i}`),
    );
    bulk.push(entry("select 'bad\x07\x1bchar'"));
    const opts = historyOptions(bulk);
    expect(opts.length).toBe(5001);
    expect(opts[0]!.title).toBe("select 'bad\ufffd\ufffdchar'");
    expect(opts[0]!.value).toBe("select 'bad\x07\x1bchar'");

    app = await mount();
    await app.waitFor(() => app.api.session.status() === "connected");
    void app.api.dialog.select({ title: "History", options: opts, empty: "No history yet" });
    await app.settle();
    const t0 = performance.now();
    await app.press("c");
    const elapsedMs = performance.now() - t0;
    expect(elapsedMs).toBeLessThan(200);
  });
});
