import { afterEach, describe, expect, test } from "bun:test";
import { createSignal, Show } from "solid-js";
import { osc52 } from "../../../core/clipboard";
import type { Cell, Connection, Driver, Result } from "../../../core/db/types";
import type { ExecRequest, ExecResult } from "../../../core/exec";
import { mount, spanWith, type MountOptions, type TestApp } from "../../testing";
import { ResultsPane } from "./ResultsPane";

let app: TestApp;
afterEach(async () => { await app?.dispose(); });

async function start(options: MountOptions = {}) {
  app = await mount(options);
  await app.waitFor(() => app.api.session.status() === "connected");
}
/** Run SQL through the Session and focus the Results Pane. */
async function run(...statements: string[]) {
  await app.api.session.run({ statements });
  app.api.focus.focus("results");
  await app.settle();
}
const people = "select 'Ada' as name, 42 as answer union all select 'Linus', 7 union all select 'Grace', null";
const numbered = "with recursive c(x) as (select 1 union all select x + 1 from c where x < 100) select x as n, 'row-' || x as label from c";
const cursor = () => app.api.results.cursor();
const copied = () => app.deps.written[app.deps.written.length - 1];

/** A Session whose Driver returns fixed rows, for values SQLite cannot produce. */
function fixed(columns: string[], rows: Cell[][]): Partial<MountOptions> {
  const result: Result = { columns: columns.map((name) => ({ name, type: "json" })), rows, truncated: false, affected: null, command: "SELECT", durationMs: 3 };
  const openSession = async (connection: Connection): Promise<Driver> => ({
    connection, run: async () => result, schema: async () => ({ dialect: "postgres", namespaces: [] }), close: async () => {},
  });
  return { connection: "postgres://localhost/dev", deps: { openSession } };
}

describe("the Table view", () => {
  test("nothing has run yet", async () => {
    await start();
    expect(app.frame()).toContain("Run a statement with Enter");
  });

  test("shows headers, rows, the row count and the time", async () => {
    await start();
    await run(people);
    const frame = app.frame();
    for (const text of ["RESULTS", "Table", "JSON", "Record", "3 rows", "ms", "name", "answer", "Ada", "Linus", "Grace", "42"]) {
      expect(frame).toContain(text);
    }
    expect(app.api.results.view()).toBe("table");
    expect(cursor()).toEqual({ row: 0, column: 0 });
  });

  test("NULL is drawn as a muted glyph", async () => {
    await start();
    await run(people);
    expect(spanWith(app.spans(), "∅")!.fg.toInts()).toEqual(app.api.theme.color("textMuted").toInts());
  });

  test("the cursor moves with vim keys and counts", async () => {
    await start();
    await run(numbered);
    await app.press("jjl");
    expect(cursor()).toEqual({ row: 2, column: 1 });
    await app.press("h5j");
    expect(cursor()).toEqual({ row: 7, column: 0 });
    await app.press("k$");
    expect(cursor()).toEqual({ row: 6, column: 1 });
    await app.press("0G");
    expect(cursor()).toEqual({ row: 99, column: 0 });
    expect(app.frame()).toContain("row-100");
    expect(app.frame()).not.toContain("row-1 ");
    await app.press("gg");
    expect(cursor()).toEqual({ row: 0, column: 0 });
    expect(app.frame()).toContain("row-1 ");
    await app.press("<C-d>");
    expect(cursor().row).toBeGreaterThan(3);
    await app.press("<C-u>k200j");
    expect(cursor().row).toBe(99);
    await app.press("hhhh");
    expect(cursor().column).toBe(0);
  });

  test("wide Results scroll sideways", async () => {
    await start();
    const columns = Array.from({ length: 12 }, (_, i) => `'${"v".repeat(18)}' as c${String(i + 1).padStart(2, "0")}`).join(", ");
    await run(`select ${columns}`);
    expect(app.frame()).toContain("c01");
    expect(app.frame()).not.toContain("c12");
    await app.press("$");
    expect(app.frame()).toContain("c12");
    expect(app.frame()).not.toContain("c01");
    await app.press("0");
    expect(app.frame()).toContain("c01");
  });

  test("the cell cursor is drawn with the selection colour", async () => {
    await start();
    await run(people);
    expect(spanWith(app.spans(), "Ada")!.bg.toInts()).toEqual(app.api.theme.color("selection").toInts());
    await app.press("j");
    expect(spanWith(app.spans(), "Linus")!.bg.toInts()).toEqual(app.api.theme.color("selection").toInts());
  });

  test("a truncated Result says so", async () => {
    await start({ config: { results: { maxRows: 5 } } });
    await run("select * from orders");
    expect(app.frame()).toContain("first 5 rows");
  });

  test("JSON cells are drawn compact and NULL as the glyph", async () => {
    await start(fixed(["meta", "nothing"], [[{ a: [1, 2] }, null]]));
    await run("select 1");
    expect(app.frame()).toContain('{"a":[1,2]}');
    expect(app.frame()).toContain("∅");
  });

  test("a cell with multi-codepoint grapheme clusters keeps the next column aligned", async () => {
    await start(
      fixed(
        ["emoji", "second"],
        [
          ["plain", "MARKER_TOP"],
          ["👍🏽".repeat(30), "MARKER_BOT"],
        ],
      ),
    );
    await run("select 1");
    const lines = app.frame().split("\n");
    const topLine = lines.find((l) => l.includes("MARKER_TOP"))!;
    const botLine = lines.find((l) => l.includes("MARKER_BOT"))!;
    expect(topLine).toBeDefined();
    expect(botLine).toBeDefined();
    const topX = Bun.stringWidth(topLine.slice(0, topLine.indexOf("MARKER_TOP")));
    const botX = Bun.stringWidth(botLine.slice(0, botLine.indexOf("MARKER_BOT")));
    expect(botX).toBe(topX);
  });
});

describe("statements without rows, and errors", () => {
  test("shows the command and the affected count", async () => {
    await start();
    await run("create table t (a integer)");
    expect(app.frame()).toContain("CREATE");
    await run("insert into t values (1), (2)");
    expect(app.frame()).toContain("INSERT");
    expect(app.frame()).toContain("2 rows affected");
  });

  test("an error shows its message", async () => {
    await start();
    await run("select * from nope");
    expect(app.frame()).toContain("no such table: nope");
    expect(spanWith(app.spans(), "no such table")!.fg.toInts()).toEqual(app.api.theme.color("error").toInts());
  });

  test("a running Run shows a spinner in the header", async () => {
    let release: (result: Result) => void = () => {};
    const openSession = async (connection: Connection): Promise<Driver> => ({
      connection,
      run: () => new Promise<Result>((resolve) => { release = resolve; }),
      schema: async () => ({ dialect: "postgres", namespaces: [] }),
      close: async () => {},
    });
    await start({ connection: "postgres://localhost/dev", deps: { openSession } });
    const pending = app.api.session.run({ statements: ["select pg_sleep(5)"] });
    await app.settle();
    const header = app.frame().split("\n").find((line) => line.includes("RESULTS"))!;
    expect(header).toContain("running");
    release({ columns: [], rows: [], truncated: false, affected: 0, command: "SELECT", durationMs: 1 });
    await pending;
  });

  test("without a table, Tab and shift+Tab do not change the view and the status line shows no cell position", async () => {
    await start();
    app.api.focus.focus("results");
    await app.settle();

    const checkNoTable = async () => {
      expect(app.api.results.view()).toBe("table");
      expect(spanWith(app.spans(), "Table")!.fg.toInts()).toEqual(app.api.theme.color("primary").toInts());
      const statusLine = app.frame().split("\n").at(-1)!;
      expect(statusLine).not.toContain("1:1");
      await app.press("<Tab>");
      expect(app.api.results.view()).toBe("table");
      expect(spanWith(app.spans(), "Table")!.fg.toInts()).toEqual(app.api.theme.color("primary").toInts());
      await app.press("<S-Tab>");
      expect(app.api.results.view()).toBe("table");
      expect(spanWith(app.spans(), "Table")!.fg.toInts()).toEqual(app.api.theme.color("primary").toInts());
    };

    // 1. No Result yet
    await checkNoTable();

    // 2. Command outcome without columns
    await run("create table t (a integer)");
    await checkNoTable();

    // 3. Error outcome
    await run("select * from nope");
    await checkNoTable();
  });
});

describe("the JSON and Record views", () => {
  test("Tab and shift+Tab cycle the views", async () => {
    await start();
    await run(people);
    await app.press("<Tab>");
    expect(app.api.results.view()).toBe("json");
    await app.press("<Tab>");
    expect(app.api.results.view()).toBe("record");
    await app.press("<Tab>");
    expect(app.api.results.view()).toBe("table");
    await app.press("<S-Tab>");
    expect(app.api.results.view()).toBe("record");
  });

  test("the JSON view shows highlighted rows as objects", async () => {
    await start();
    await run(people);
    await app.press("<Tab>");
    expect(app.frame()).toContain('"name": "Ada"');
    expect(app.frame()).toContain('"answer": 42');
    expect(spanWith(app.spans(), '"name"')!.fg.toInts()).toEqual(app.api.theme.color("syntaxType").toInts());
    expect(spanWith(app.spans(), '"Ada"')!.fg.toInts()).toEqual(app.api.theme.color("syntaxString").toInts());
  });

  test("the JSON view is a read-only vim Buffer", async () => {
    await start();
    await run(people);
    await app.press("<Tab>jddxyy");
    expect(app.frame()).toContain('"name": "Ada"');
    expect(copied()).toBe(osc52("  {\n"));
    await app.press("/Linus<CR>");
    expect(app.api.status.message()).toBeNull();
    await app.press("/zebra<CR>");
    expect(app.api.status.message()?.text).toBe("Pattern not found: zebra");
  });

  test("the JSON view leaves rows out beyond jsonMaxRows and says so", async () => {
    await start({ config: { results: { jsonMaxRows: 2 } } });
    await run(people);
    await app.press("<Tab>");
    expect(app.frame()).toContain("showing 2 of 3 rows");
    expect(app.frame()).not.toContain("Grace");
  });

  test("Enter opens the current row as a Record and q or Escape returns", async () => {
    await start();
    await run(people);
    await app.press("j<CR>");
    expect(app.api.results.view()).toBe("record");
    expect(app.frame()).toContain("Linus");
    expect(app.frame()).toContain("answer");
    expect(app.frame()).not.toContain("Ada");
    expect(app.frame()).toContain("row 2 of 3");
    await app.press("q");
    expect(app.api.results.view()).toBe("table");
    expect(cursor()).toEqual({ row: 1, column: 0 });
    await app.press("<CR><Esc>");
    expect(app.api.results.view()).toBe("table");
  });

  test("the Record view pretty-prints JSON values and yanks fields", async () => {
    await start(fixed(["id", "meta"], [[1, { a: [1, 2] }]]));
    await run("select 1");
    await app.press("<CR>");
    expect(app.frame()).toContain('"a": [');
    await app.press("jy");
    expect(copied()).toBe(osc52('{\n  "a": [\n    1,\n    2\n  ]\n}'));
    await app.press("Y");
    expect(JSON.parse(Buffer.from(copied()!.slice(7, -1), "base64").toString())).toEqual({ id: 1, meta: { a: [1, 2] } });
  });

  test(":view and the Leader switch views, and a new Result returns to the Table", async () => {
    await start();
    await run(people);
    await app.press(":view json<CR>");
    expect(app.api.results.view()).toBe("json");
    await app.press("<Space>vr");
    expect(app.api.results.view()).toBe("record");
    await app.press("<Space>vt");
    expect(app.api.results.view()).toBe("table");
    await app.press(":view nope<CR>");
    expect(app.api.status.message()).toEqual({ text: "Unknown view: nope (table, json or record)", kind: "error" });
    await app.press("<Space>vj");
    await run("select 1 as one");
    expect(app.api.results.view()).toBe("table");
    expect(cursor()).toEqual({ row: 0, column: 0 });
  });

  test("the Record view caps long fields, shows … N more lines, yanks the whole value and moves fast", async () => {
    const bigText = Array.from({ length: 100_000 }, (_, i) => `line-${i + 1}`).join("\n");
    const bigJson = Array.from({ length: 20_000 }, (_, i) => i);
    let yankedStdin = "";
    const base = fixed(["id", "huge_text", "huge_json", "tail"], [[1, bigText, bigJson, "end"]]);
    await start({
      ...base,
      deps: {
        ...base.deps,
        which: (bin) => (bin === "wl-copy" ? "/usr/bin/wl-copy" : null),
        exec: async (req) => {
          yankedStdin = req.stdin ?? "";
          return { code: 0, stdout: "", stderr: "", timedOut: false, aborted: false };
        },
      },
    });
    await run("select 1");
    await app.press("<CR>");
    expect(app.api.results.view()).toBe("record");

    const t0 = performance.now();
    await app.press("j");
    const firstJMs = performance.now() - t0;

    const frame = app.frame();
    expect(frame).toContain("line-1");
    const match = frame.match(/… (\d+) more lines · y copies the whole value/);
    expect(match).not.toBeNull();
    const shownLines = 100_000 - Number(match![1]);
    expect(shownLines).toBeGreaterThanOrEqual(3);
    expect(frame).toContain(`line-${shownLines}`);
    expect(frame).not.toContain(`line-${shownLines + 1}`);

    await app.press("y");
    expect(yankedStdin).toBe(bigText);

    const t1 = performance.now();
    await app.press("j");
    const secondJMs = performance.now() - t1;

    expect(firstJMs).toBeLessThan(16);
    expect(secondJMs).toBeLessThan(16);
  });

  test("the Record view draws a text value '∅' in text colour and only real NULL in muted colour", async () => {
    await start(fixed(["literal_glyph", "real_null"], [["∅", null]]));
    await run("select 1");
    await app.press("<CR>");
    const glyphSpans = app
      .spans()
      .lines.flatMap((l) => l.spans)
      .filter((s) => s.text.includes("∅"));
    expect(glyphSpans.length).toBe(2);
    expect(glyphSpans[0]!.fg.toInts()).toEqual(app.api.theme.color("text").toInts());
    expect(glyphSpans[1]!.fg.toInts()).toEqual(app.api.theme.color("textMuted").toInts());
  });

  test("a Record whose last field is [] shows it at Pane heights from 5 to 12", async () => {
    const cols = ["f1", "f2", "f3", "f4", "f5", "last_arr"];
    const row: Cell[] = ["v1", "v2", "v3", "v4", "v5", []];
    await start({ ...fixed(cols, [row]), height: 14 });
    await run("select 1");
    await app.press("<CR>G");
    // Total app height 11..26 spans Results Pane heights from 5 to 12
    for (let appH = 11; appH <= 26; appH++) {
      await app.resize(120, appH);
      expect(app.frame()).toContain("last_arr");
      expect(app.frame()).toContain("[]");
    }
  });

  test("y in the Record view copies the exact cell text including \\r\\n, \\r and trailing line breaks", async () => {
    await start(
      fixed(
        ["crlf", "cr", "trailing", "json_col"],
        [["x\r\ny\rz", "a\rb\r", "hello\r\n", { k: 1 }]],
      ),
    );
    await run("select 1");
    await app.press("<CR>");
    await app.press("y");
    expect(copied()).toBe(osc52("x\r\ny\rz"));
    await app.press("jy");
    expect(copied()).toBe(osc52("a\rb\r"));
    await app.press("jy");
    expect(copied()).toBe(osc52("hello\r\n"));
    await app.press("jy");
    expect(copied()).toBe(osc52('{\n  "k": 1\n}'));
  });

  test("the JSON view escapes U+2028, U+2029 and C1 characters so the shown and copied text parses back to the original values", async () => {
    const row: Cell[] = [
      "line\u2028sep",
      "para\u2029sep",
      "nel\u0085c1",
      "csi\u009bseq",
      "esc\u001b[31mred",
      "lone\ud800surrogate",
    ];
    const cols = ["ls", "ps", "nel", "csi", "esc", "sur"];
    await start(fixed(cols, [row]));
    await run("select 1");
    await app.press("<Tab>ggVG");
    await app.press("y");
    const rawCopied = Buffer.from(copied()!.slice(7, -1), "base64").toString("utf8");
    expect(JSON.parse(rawCopied)).toEqual([
      {
        ls: "line\u2028sep",
        ps: "para\u2029sep",
        nel: "nel\u0085c1",
        csi: "csi\u009bseq",
        esc: "esc\u001b[31mred",
        sur: "lone\ud800surrogate",
      },
    ]);
    const frame = app.frame();
    expect(frame).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u2028\u2029]/);
  });

  test("Enter on a Result without rows stays in the Table view and says No rows", async () => {
    await start();
    await run("select * from orders where 1 = 0");
    expect(app.api.results.view()).toBe("table");
    await app.press("<CR>");
    expect(app.api.results.view()).toBe("table");
    expect(app.api.status.message()?.text).toBe("No rows");
  });

  test("an unlisted key cancels the pending count in all three views", async () => {
    await start(
      fixed(
        ["f1", "f2", "f3", "f4", "f5", "f6", "f7"],
        [
          ["a1", "a2", "a3", "a4", "a5", "a6", "a7"],
          ["b1", "b2", "b3", "b4", "b5", "b6", "b7"],
          ["c1", "c2", "c3", "c4", "c5", "c6", "c7"],
          ["d1", "d2", "d3", "d4", "d5", "d6", "d7"],
          ["e1", "e2", "e3", "e4", "e5", "e6", "e7"],
          ["f1", "f2", "f3", "f4", "f5", "f6", "f7"],
          ["g1", "g2", "g3", "g4", "g5", "g6", "g7"],
        ],
      ),
    );
    await run("select 1");

    // 1. Table view: 5 then z (unlisted) then j moves 1 row, not 5
    await app.press("5zj");
    expect(cursor().row).toBe(1);

    // 2. JSON view: 5 then z (unlisted) then j moves 1 row, not 5
    await app.press("<Tab>gg5zjyy");
    expect(copied()).toBe(osc52("  {\n"));

    // 3. Record view: 5 then z (unlisted) then j moves 1 field (from f1 to f2) and yanks b2
    await app.press("<Tab>gg5zjy");
    expect(copied()).toBe(osc52("b2"));
  });
});

describe("yank and search", () => {
  test("y yanks the cell, yy and Y the row, V selects rows", async () => {
    await start();
    await run(people);
    await app.press("y");
    expect(copied()).toBe(osc52("Ada"));
    await app.press("ly");
    expect(copied()).toBe(osc52("42"));
    await app.press("yy");
    expect(copied()).toBe(osc52('{\n  "name": "Ada",\n  "answer": 42\n}'));
    await app.press("jY");
    expect(copied()).toBe(osc52('{\n  "name": "Linus",\n  "answer": 7\n}'));
    await app.press("ggVjy");
    expect(JSON.parse(Buffer.from(copied()!.slice(7, -1), "base64").toString())).toEqual([
      { name: "Ada", answer: 42 },
      { name: "Linus", answer: 7 },
    ]);
    await app.press("Gly");
    expect(copied()).toBe(osc52("NULL"));
  });

  test("/ searches cells; n and N move between matches", async () => {
    await start();
    await run(people);
    await app.press("/a<CR>");
    expect(cursor()).toEqual({ row: 0, column: 0 });
    await app.press("n");
    expect(cursor()).toEqual({ row: 2, column: 0 });
    await app.press("n");
    expect(cursor()).toEqual({ row: 0, column: 0 });
    await app.press("N");
    expect(cursor()).toEqual({ row: 2, column: 0 });
    await app.press("/zebra<CR>");
    expect(app.api.status.message()).toEqual({ text: "Pattern not found: zebra", kind: "error" });
  });
});

test("the row count counts up when animations are on", async () => {
  app = await mount({ animations: true });
  await app.waitFor(() => app.api.session.status() === "connected");
  await app.api.session.run({ statements: [numbered] });
  await app.advance(400);
  expect(app.frame()).toContain("100 rows");
});

describe("clipboard copy failure reporting in the Results Pane", () => {
  test("a failed copy says Could not copy: <reason> on the status line and does not flash", async () => {
    const base = fixed(["name", "val"], [["Ada", "42"]]);
    app = await mount({
      ...base,
      animations: true,
      deps: {
        ...base.deps,
        write: () => {
          throw new Error("terminal write failed");
        },
        which: (bin) => (bin === "wl-copy" ? "/usr/bin/wl-copy" : null),
        exec: async () => ({
          code: 1,
          stdout: "",
          stderr: "wayland display not found\nextra",
          timedOut: false,
          aborted: false,
        }),
      },
    });
    await app.waitFor(() => app.api.session.status() === "connected");
    await run("select 1");
    await app.press("Y");
    await app.waitFor(() => app.api.status.message() !== null);
    expect(app.api.status.message()).toEqual({
      text: "Could not copy: wl-copy failed: wayland display not found",
      kind: "error",
    });
    // Row did not flash: column 1 ('42', not under cursor) does not have primary flash background
    expect(spanWith(app.spans(), "42")!.bg.toInts()).not.toEqual(
      app.api.theme.color("primary").toInts(),
    );
  });

  test("a successful copy flashes and leaves the status line clear", async () => {
    const base = fixed(["name", "val"], [["Ada", "42"]]);
    app = await mount({
      ...base,
      animations: true,
      deps: {
        ...base.deps,
      },
    });
    await app.waitFor(() => app.api.session.status() === "connected");
    await run("select 1");
    await app.press("Y");
    expect(app.api.status.message()).toBeNull();
    expect(copied()).toBe(osc52('{\n  "name": "Ada",\n  "val": "42"\n}'));
    expect(spanWith(app.spans(), "42")!.bg.toInts()).toEqual(
      app.api.theme.color("primary").toInts(),
    );
  });
});

/** An exec whose clipboard tool fails only once `release` is called. */
function heldFailingTool(bin: string) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const calls: string[] = [];
  const exec = async (req: ExecRequest): Promise<ExecResult> => {
    calls.push(req.cmd[0]!);
    if (req.cmd[0] === `/usr/bin/${bin}`) await held;
    return { code: 1, stdout: "", stderr: `${bin} broken`, timedOut: false, aborted: false };
  };
  return { exec, calls, release: () => release() };
}

test("a failed copy that finishes after the Results Pane is gone changes nothing", async () => {
  const [shown, setShown] = createSignal(true);
  const tool = heldFailingTool("wl-copy");
  app = await mount({
    animations: true,
    deps: {
      write: () => {
        throw new Error("terminal write failed");
      },
      which: (bin) => (bin === "wl-copy" ? "/usr/bin/wl-copy" : null),
      exec: tool.exec,
    },
    ui: () => (
      <Show when={shown()}>
        <ResultsPane />
      </Show>
    ),
  });
  await app.waitFor(() => app.api.session.status() === "connected");
  await run("select 1 as n");
  await app.press("Y");
  expect(tool.calls).toEqual(["/usr/bin/wl-copy"]);
  setShown(false);
  await app.settle();
  tool.release();
  await app.settle();
  expect(app.api.status.message()).toBeNull();
});
