import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { osc52 } from "../../../core/clipboard";
import { QueryError, type Connection, type Driver } from "../../../core/db/types";
import { loadBuffers, readHistory, saveBuffers } from "../../../core/state";
import { mount, spanWith, type MountOptions, type TestApp } from "../../testing";
import { DEMO_BUFFER_TEXT } from "./buffers";
import { MAX_OPEN_FILE_BYTES } from "./EditorPane";

let app: TestApp;
afterEach(async () => {
  await app?.dispose();
});

async function start(text = "", options: MountOptions = {}) {
  app = await mount(options);
  await app.waitFor(() => app.api.session.status() === "connected");
  app.api.editor.setText(text);
  await app.settle();
}
const shown = () => app.api.session.shown();
const shownColumns = () => {
  const outcome = shown();
  return outcome?.ok ? outcome.result.columns.map((c) => c.name) : null;
};

describe("typing", () => {
  test("the demo database starts with a sample Buffer", async () => {
    app = await mount();
    await app.waitFor(() => app.api.session.status() === "connected");
    expect(app.api.editor.text()).toBe(DEMO_BUFFER_TEXT);
    expect(DEMO_BUFFER_TEXT).toContain("select");
    expect(app.frame()).toContain("1 scratch");
  });

  test("insert mode types text and the statusline follows the mode", async () => {
    await start();
    await app.press("iselect 1 as one");
    expect(app.api.editor.mode()).toBe("insert");
    expect(app.frame()).toContain("INSERT");
    await app.press("<Esc>");
    expect(app.api.editor.text()).toBe("select 1 as one");
    expect(app.frame()).toContain("NORMAL");
    expect(app.frame()).toContain("select 1 as one");
    expect(spanWith(app.spans(), "select")!.fg.toInts()).toEqual(app.api.theme.color("syntaxKeyword").toInts());
  });

  test("the statusline shows pending keys and the cursor position", async () => {
    await start("one\ntwo three");
    await app.press("jw2");
    expect(app.api.status.current()).toEqual({ mode: "NORMAL", pending: "2", position: "2:5" });
    await app.press("<Esc>v");
    expect(app.api.status.current().mode).toBe("VISUAL");
    await app.press("V");
    expect(app.api.status.current().mode).toBe("V-LINE");
  });

  test("operators, repeat and undo work in the Pane", async () => {
    await start("one two three");
    await app.press("dw.");
    expect(app.api.editor.text()).toBe("three");
    await app.press("u");
    expect(app.api.editor.text()).toBe("two three");
    await app.press('ciwTWO<Esc>"ayiwo<Esc>"ap');
    expect(app.api.editor.text()).toBe("TWO three\nTWO");
  });

  test("the Leader types a space in insert mode and opens the menu in normal mode", async () => {
    await start();
    await app.press("ia<Space>b");
    expect(app.api.editor.text()).toBe("a b");
    expect(app.frame()).not.toContain("Help");
    await app.press("<Esc><Space>");
    expect(app.frame()).toContain("Help");
  });

  test("a yank is copied to the clipboard", async () => {
    await start("select 1");
    await app.press("yy");
    expect(app.deps.written).toEqual([osc52("select 1\n")]);
  });

  test("paste inserts at the cursor", async () => {
    await start("select  from t");
    await app.press("6l");
    app.api.keys.paste("name\nage");
    await app.settle();
    expect(app.api.editor.text()).toBe("select name\nage from t");
  });

  test("insert, replace and statement", async () => {
    await start("select * from ");
    await app.press("$");
    app.api.editor.insert("customers");
    expect(app.api.editor.text()).toBe("select * from customers");
    await app.press("u");
    expect(app.api.editor.text()).toBe("select * from ");
    app.api.editor.setText("select 1;\nselect 2;");
    await app.press("j");
    expect(app.api.editor.statement()).toEqual({ text: "select 2", start: 10, end: 18 });
    app.api.editor.replace(10, 18, "select 3");
    expect(app.api.editor.text()).toBe("select 1;\nselect 3;");
    app.api.editor.setText("");
    expect(app.api.editor.statement()).toBeNull();
  });
});

describe("running", () => {
  test("Enter in normal mode runs the Statement under the cursor", async () => {
    await start("select 1 as one;\nselect 2 as two;");
    await app.press("j<CR>");
    await app.waitFor(() => shown() !== null);
    expect(shownColumns()).toEqual(["two"]);
    expect(app.api.focus.pane()).toBe("editor");
    expect((await readHistory(app.deps.paths)).map((h) => h.sql)).toEqual(["select 2 as two"]);
  });

  test("ctrl+s runs in insert mode and stays there", async () => {
    await start();
    await app.press("iselect 3 as three<C-s>");
    await app.waitFor(() => shown() !== null);
    expect(shownColumns()).toEqual(["three"]);
    expect(app.api.editor.mode()).toBe("insert");
  });

  test("ctrl+enter runs too", async () => {
    await start("select 4 as four");
    await app.press("<C-CR>");
    await app.waitFor(() => shown() !== null);
    expect(shownColumns()).toEqual(["four"]);
  });

  test("Enter in visual mode runs the selected Statements in order", async () => {
    await start("select 1 as one;\nselect 2 as two;\nselect 3 as three;");
    await app.press("Vj<CR>");
    await app.waitFor(() => shown() !== null);
    expect(shownColumns()).toEqual(["two"]);
    expect((await readHistory(app.deps.paths)).map((h) => h.sql).reverse()).toEqual(["select 1 as one", "select 2 as two"]);
    expect(app.api.editor.mode()).toBe("normal");
  });

  test("an empty Buffer has nothing to run", async () => {
    await start("   ");
    await app.press("<CR>");
    expect(app.api.status.message()).toEqual({ text: "No statement under the cursor", kind: "error" });
    expect(shown()).toBeNull();
  });

  test(":run all runs every Statement and summarizes", async () => {
    await start("create table t (a integer);\ninsert into t values (1), (2);\nselect a from t;");
    await app.press(":run all<CR>");
    await app.waitFor(() => app.api.toast.items().length > 0);
    expect(app.api.toast.items()[0]).toMatchObject({ kind: "success", message: "Ran 3 statements" });
    expect(shownColumns()).toEqual(["a"]);
  });

  test(":run all stops at the first error", async () => {
    await start("select 1;\nselect * from nope;\nselect 3;");
    await app.press(":run all<CR>");
    await app.waitFor(() => app.api.toast.items().length > 0);
    expect(app.api.toast.items()[0]).toMatchObject({ kind: "error", message: "Statement 2 of 3 failed" });
    expect(shown()?.ok).toBe(false);
  });

  test("the Leader runs and explains", async () => {
    await start("select 5 as five;\nselect 6 as six;");
    await app.press("<Space>r");
    await app.waitFor(() => shownColumns()?.[0] === "five");
    await app.press("<Space>R");
    await app.waitFor(() => shownColumns()?.[0] === "six");
    await app.press("<Space>x");
    await app.waitFor(() => shownColumns()?.includes("detail") === true);
    await app.press(":run<CR>");
    await app.waitFor(() => shownColumns()?.[0] === "five");
    await app.press(":explain<CR>");
    await app.waitFor(() => shownColumns()?.includes("detail") === true);
  });

  test("an error position from the Driver is marked until the text changes", async () => {
    const openSession = async (connection: Connection): Promise<Driver> => ({
      connection,
      run: async () => { throw new QueryError('syntax error at or near "frm"', { position: 10 }); },
      schema: async () => ({ dialect: "postgres", namespaces: [] }),
      close: async () => {},
    });
    await start("select 1;\nselect * frm t;", { connection: "postgres://localhost/dev", deps: { openSession } });
    await app.press("j<CR>");
    await app.waitFor(() => shown() !== null);
    const error = app.api.theme.color("error").toInts();
    expect(spanWith(app.spans(), "frm")!.fg.toInts()).toEqual(error);
    await app.press("A <Esc>");
    expect(spanWith(app.spans(), "frm")!.fg.toInts()).not.toEqual(error);
  });

  test("Fix 2: a Run interrupted by switching Connection reports the Session-closed error, a second Run while one is in flight says so, and runAll reports why a Statement failed", async () => {
    let rejectInFlight!: (err: unknown) => void;
    let driverCalls: string[] = [];
    const openSession = async (connection: Connection): Promise<Driver> => ({
      connection,
      run: async (sql: string) => {
        driverCalls.push(`${connection.id}:${sql}`);
        if (sql === "select slow") {
          return new Promise((_res, rej) => {
            rejectInFlight = rej;
          });
        }
        if (sql === "select * from bad") {
          throw new QueryError("no such table: bad");
        }
        return {
          columns: [{ name: "x", type: "integer" }],
          rows: [[1]],
          truncated: false,
          affected: null,
          command: "SELECT",
          durationMs: 1,
        };
      },
      schema: async () => ({ dialect: "sqlite", namespaces: [] }),
      close: async () => {
        rejectInFlight?.(new QueryError("the Session is closed"));
      },
    });

    await start("select slow", { connection: ":memory:", deps: { openSession } });
    // Start first Run in flight
    await app.press("<CR>");
    await app.waitFor(() => app.api.session.running() !== null);

    // Start a second Run while first is in flight
    await app.press("<CR>");
    expect(app.api.status.message()).toEqual({
      text: "A Run is already in progress",
      kind: "error",
    });

    // Switch Connection while first Run is in flight
    await app.api.session.connect("demo");
    await app.waitFor(() => app.api.session.running() === null);
    expect(app.api.status.message()).toEqual({
      text: "the Session is closed",
      kind: "error",
    });

    // Now test runAll with a failing second Statement
    driverCalls = [];
    app.api.editor.setText("select 1;\nselect * from bad;\nselect 3;");
    await app.settle();
    await app.press(":run all<CR>");
    await app.waitFor(() => app.api.toast.items().length > 0);
    expect(app.api.status.message()).toEqual({
      text: "Statement 2 of 3 failed: no such table: bad",
      kind: "error",
    });
    expect(driverCalls).toEqual(["demo:select 1", "demo:select * from bad"]);
  });

  test("Fix 4: error mark converts code-point position to UTF-16 offset and is not placed when Buffer text changed during the Run", async () => {
    let rejectSlow!: (err: unknown) => void;
    const openSession = async (connection: Connection): Promise<Driver> => ({
      connection,
      run: async (sql: string) => {
        if (sql.includes("slow")) {
          return new Promise((_res, rej) => {
            rejectSlow = rej;
          });
        }
        // "select '😀😀' frm t" -> 'f' of 'frm' is 1-based code point 13 (UTF-16 index 14)
        throw new QueryError('syntax error at or near "frm"', { position: 13 });
      },
      schema: async () => ({ dialect: "postgres", namespaces: [] }),
      close: async () => {},
    });

    await start("select '😀😀' frm t;", {
      connection: "postgres://localhost/dev",
      deps: { openSession },
    });
    await app.press("<CR>");
    await app.waitFor(() => shown() !== null);
    const errorColor = app.api.theme.color("error").toInts();
    expect(spanWith(app.spans(), "frm")!.fg.toInts()).toEqual(errorColor);

    // Now test stale text: start a slow Run, edit the Buffer while in flight, then reject with position
    app.api.editor.setText("select slow frm t;");
    await app.settle();
    await app.press("<CR>");
    await app.waitFor(() => app.api.session.running() !== null);

    // Edit text while Run is in flight
    await app.press("A <Esc>");
    expect(app.api.editor.text()).toBe("select slow frm t; ");

    rejectSlow(new QueryError('syntax error at or near "frm"', { position: 13 }));
    await app.waitFor(() => app.api.session.running() === null);
    await app.settle();
    expect(spanWith(app.spans(), "frm")!.fg.toInts()).not.toEqual(errorColor);
  });

  test("Fix 7: Ctrl+C cancels a Run in flight started from insert mode on the first press, and without a Run leaves insert mode", async () => {
    const openSession = async (connection: Connection): Promise<Driver> => ({
      connection,
      run: async (_sql, opts) =>
        new Promise((_res, rej) => {
          opts?.signal?.addEventListener("abort", () => {
            rej(new QueryError("cancelled"));
          });
        }),
      schema: async () => ({ dialect: "sqlite", namespaces: [] }),
      close: async () => {},
    });

    await start("", { connection: ":memory:", deps: { openSession } });
    // Start a Run from insert mode via <C-s>
    await app.press("iselect slow<C-s>");
    await app.waitFor(() => app.api.session.running() !== null);
    expect(app.api.editor.mode()).toBe("insert");

    // One <C-c> cancels the Run
    await app.press("<C-c>");
    await app.waitFor(() => app.api.session.running() === null);
    expect(shown()?.ok).toBe(false);

    // Without a Run in flight, <C-c> leaves insert mode
    if (app.api.editor.mode() !== "insert") {
      await app.press("i");
    }
    expect(app.api.editor.mode()).toBe("insert");
    await app.press("<C-c>");
    expect(app.api.editor.mode()).toBe("normal");
  });

  test("Fix 4 (round 2): a second Run started during a Run is reported once in total (status line and toasts together)", async () => {
    const { spyOn } = await import("bun:test");
    let resolveInFlight!: () => void;
    const openSession = async (connection: Connection): Promise<Driver> => ({
      connection,
      run: async (sql: string) => {
        if (sql === "select slow") {
          await new Promise<void>((res) => {
            resolveInFlight = res;
          });
        }
        return {
          columns: [{ name: "x", type: "integer" }],
          rows: [[1]],
          truncated: false,
          affected: null,
          command: "SELECT",
          durationMs: 1,
        };
      },
      schema: async () => ({ dialect: "sqlite", namespaces: [] }),
      close: async () => {},
    });

    await start("select slow", { connection: ":memory:", deps: { openSession } });
    // Start first Run in flight
    await app.press("<CR>");
    await app.waitFor(() => app.api.session.running() !== null);

    const saySpy = spyOn(app.api.status, "say");
    const toastSpy = spyOn(app.api.toast, "show");

    try {
      // 1. Second runStatement while first is in flight
      saySpy.mockClear();
      toastSpy.mockClear();
      await app.press("<CR>");
      expect(saySpy.mock.calls.length + toastSpy.mock.calls.length).toBe(1);
      expect(app.api.status.message()?.text).toBe("A Run is already in progress");

      // 2. Second runSelection while first is in flight
      saySpy.mockClear();
      toastSpy.mockClear();
      await app.press("V<CR>");
      expect(saySpy.mock.calls.length + toastSpy.mock.calls.length).toBe(1);
      expect(app.api.status.message()?.text).toBe("A Run is already in progress");

      // 3. Second runAll while first is in flight
      saySpy.mockClear();
      toastSpy.mockClear();
      await app.press(":run all<CR>");
      expect(saySpy.mock.calls.length + toastSpy.mock.calls.length).toBe(1);
      expect(app.api.status.message()?.text).toBe("A Run is already in progress");

      // 4. Explain while first is in flight
      saySpy.mockClear();
      toastSpy.mockClear();
      await app.press(":explain<CR>");
      expect(saySpy.mock.calls.length + toastSpy.mock.calls.length).toBe(1);
      expect(app.api.status.message()?.text).toBe("A Run is already in progress");
    } finally {
      saySpy.mockRestore();
      toastSpy.mockRestore();
      resolveInFlight?.();
    }
  });
});

describe("search and lines", () => {
  test("/ searches forward, ? backward, n and N repeat", async () => {
    await start("from a\nfrom b\nfrom c");
    await app.press("/from<CR>");
    expect(app.api.editor.cursor()).toEqual({ row: 1, col: 0 });
    await app.press("n");
    expect(app.api.editor.cursor()).toEqual({ row: 2, col: 0 });
    await app.press("N");
    expect(app.api.editor.cursor()).toEqual({ row: 1, col: 0 });
    await app.press("?from<CR>");
    expect(app.api.editor.cursor()).toEqual({ row: 0, col: 0 });
    await app.press("/zebra<CR>");
    expect(app.api.status.message()).toEqual({ text: "Pattern not found: zebra", kind: "error" });
  });

  test(":noh hides the matches and :<n> goes to a line", async () => {
    await start("from a\nfrom b\nfrom c");
    await app.press("/from<CR>");
    const highlighted = () => app.spans().lines.some((l) => l.spans.some((s) => s.text.includes("from") && s.bg.toInts().join() === app.api.theme.color("warning").toInts().join()));
    expect(highlighted()).toBe(true);
    await app.press(":noh<CR>");
    expect(highlighted()).toBe(false);
    await app.press(":3<CR>");
    expect(app.api.editor.cursor().row).toBe(2);
    await app.press(":99<CR>");
    expect(app.api.editor.cursor().row).toBe(2);
  });
});

describe("Buffers", () => {
  test(":new, gt, gT, :bn, :bp and :bd", async () => {
    await start("first");
    await app.press(":new<CR>");
    expect(app.api.editor.buffers().map((b) => b.name)).toEqual(["scratch", "scratch-2"]);
    expect(app.api.editor.active()).toBe(1);
    expect(app.api.editor.text()).toBe("");
    expect(app.frame()).toContain("2 scratch-2");
    await app.press("isecond<Esc>");
    await app.press("gt");
    expect([app.api.editor.active(), app.api.editor.text()]).toEqual([0, "first"]);
    await app.press("gT");
    expect([app.api.editor.active(), app.api.editor.text()]).toEqual([1, "second"]);
    await app.press(":bn<CR>");
    expect(app.api.editor.active()).toBe(0);
    await app.press(":bp<CR>");
    expect(app.api.editor.active()).toBe(1);
    await app.press(":bd<CR>");
    expect(app.api.editor.buffers().map((b) => b.name)).toEqual(["scratch"]);
    await app.press(":bd<CR>");
    expect(app.api.editor.buffers().map((b) => [b.name, b.text])).toEqual([["scratch", ""]]);
  });

  test("each Buffer keeps its own undo history", async () => {
    await start("first");
    await app.press("x:new<CR>");
    await app.press("iabc<Esc>gtu");
    expect(app.api.editor.text()).toBe("first");
    await app.press("gTu");
    expect(app.api.editor.text()).toBe("");
  });

  test("the Leader opens, closes and lists Buffers", async () => {
    await start("first");
    await app.press("<Space>bn");
    expect(app.api.editor.buffers().length).toBe(2);
    await app.press("<Space>bl");
    expect(app.frame()).toContain("Buffers");
    expect(app.frame()).toContain("scratch-2");
    await app.press("<C-p><CR>");
    expect(app.api.editor.active()).toBe(0);
    await app.press("<Space>bd");
    expect(app.api.editor.buffers().map((b) => b.name)).toEqual(["scratch-2"]);
  });

  test(":w and :e", async () => {
    await start("select 42;");
    await app.press(":w<CR>");
    expect(app.api.status.message()).toEqual({ text: "No file name (use :w <path>)", kind: "error" });
    await app.press(":w out.sql<CR>");
    const file = join(app.deps.cwd, "out.sql");
    await app.waitFor(() => app.api.editor.buffers()[0]!.path === file);
    expect(await Bun.file(file).text()).toBe("select 42;\n");
    expect(app.api.editor.buffers()[0]!.name).toBe("out.sql");
    await app.press("A -- more<Esc>:w<CR>");
    await app.waitFor(() => app.api.status.message() !== null);
    expect(await Bun.file(file).text()).toBe("select 42; -- more\n");

    await Bun.write(join(app.deps.cwd, "other.sql"), "select 7;\n");
    await app.press(":e other.sql<CR>");
    await app.waitFor(() => app.api.editor.buffers().length === 2);
    expect(app.api.editor.text()).toBe("select 7;");
    await app.press(":e out.sql<CR>");
    await app.waitFor(() => app.api.editor.active() === 0);
    expect(app.api.editor.buffers().length).toBe(2);
    await app.press(":e brand-new.sql<CR>");
    await app.waitFor(() => app.api.editor.buffers().length === 3);
    expect(app.api.editor.buffers()[2]).toMatchObject({ name: "brand-new.sql", text: "" });
  });

  test("Buffers are saved per Connection and restored", async () => {
    await start("select 'kept';");
    await app.press(":new<CR>");
    await app.press("iselect 2<Esc>");
    await app.api.editor.flush();
    expect(await loadBuffers(app.deps.paths, "demo")).toEqual({
      buffers: [
        { name: "scratch", path: null, text: "select 'kept';" },
        { name: "scratch-2", path: null, text: "select 2" },
      ],
      active: 1,
    });
    await app.dispose();

    app = await mount({
      seed: (deps) => saveBuffers(deps.paths, "demo", [
        { name: "a.sql", path: null, text: "select 42" },
        { name: "b", path: null, text: "select 43" },
      ], 1),
    });
    await app.waitFor(() => app.api.session.status() === "connected");
    expect(app.api.editor.buffers().map((b) => b.name)).toEqual(["a.sql", "b"]);
    expect(app.api.editor.text()).toBe("select 43");
    expect(app.frame()).toContain("1 a.sql");
  });

  test("quitting saves the Buffers", async () => {
    await start("select 'on quit';");
    await app.api.quit();
    expect((await loadBuffers(app.deps.paths, "demo"))!.buffers[0]!.text).toBe("select 'on quit';");
  });

  test("switching the Connection switches the Buffer set", async () => {
    await start("for demo");
    await app.api.session.connect(":memory:");
    await app.waitFor(() => app.api.editor.text() === "");
    app.api.editor.setText("for memory");
    await app.api.session.connect("demo");
    await app.waitFor(() => app.api.editor.text() === "for demo");
  });

  test("Fix 5: a failing Buffer save is reported once as a warning toast and flush still resolves", async () => {
    app = await mount({
      seed: async (deps) => {
        await Bun.write(deps.paths.buffersDir, "not a directory");
      },
    });
    await app.waitFor(() => app.api.session.status() === "connected");
    app.api.editor.setText("select 1;");
    await app.settle();
    await app.api.editor.flush();

    const saveWarnings = () =>
      app.api.toast
        .items()
        .filter((t) => t.kind === "warning" && t.message.startsWith("Buffers could not be saved: "));
    expect(saveWarnings().length).toBe(1);

    // A second failing save (debounced or flush) does not emit a second warning toast
    app.api.editor.setText("select 2;");
    app.deps.clock.advance(500);
    await app.api.editor.flush();
    expect(saveWarnings().length).toBe(1);
  });

  test("Fix 6: :e opens missing files as empty, refuses directories, permission errors, >MAX_OPEN_FILE_BYTES and NUL bytes, and normalizes CRLF/CR to LF", async () => {
    expect(MAX_OPEN_FILE_BYTES).toBe(5 * 1024 * 1024);
    await start("initial");
    const cwd = app.deps.cwd;

    // 1. Directory is refused and opens nothing
    await mkdir(join(cwd, "adir"));
    await app.press(":e adir<CR>");
    await app.waitFor(() => app.api.status.message() !== null);
    expect(app.api.status.message()?.kind).toBe("error");
    expect(app.api.editor.buffers().length).toBe(1);

    // 2. Unreadable file (permission error) is refused and opens nothing
    if (process.getuid?.() !== 0) {
      const secretPath = join(cwd, "secret.sql");
      await Bun.write(secretPath, "select 'secret';\n");
      await chmod(secretPath, 0o000);
      try {
        app.api.status.clear();
        await app.press(":e secret.sql<CR>");
        await app.waitFor(() => app.api.status.message() !== null);
        expect(app.api.status.message()?.kind).toBe("error");
        expect(app.api.editor.buffers().length).toBe(1);
      } finally {
        await chmod(secretPath, 0o600);
      }
    }

    // 3. File larger than MAX_OPEN_FILE_BYTES is refused
    const hugePath = join(cwd, "huge.sql");
    await Bun.write(hugePath, new Uint8Array(MAX_OPEN_FILE_BYTES + 1).fill(0x61));
    app.api.status.clear();
    await app.press(":e huge.sql<CR>");
    await app.waitFor(() => app.api.status.message() !== null);
    expect(app.api.status.message()?.kind).toBe("error");
    expect(app.api.status.message()?.text.toLowerCase()).toMatch(/large|size|byte|limit|max/);
    expect(app.api.editor.buffers().length).toBe(1);

    // 4. File containing a NUL byte is refused
    const nulPath = join(cwd, "binary.sql");
    await Bun.write(nulPath, "select 1;\0select 2;\n");
    app.api.status.clear();
    await app.press(":e binary.sql<CR>");
    await app.waitFor(() => app.api.status.message() !== null);
    expect(app.api.status.message()?.kind).toBe("error");
    expect(app.api.status.message()?.text.toLowerCase()).toMatch(/binary|nul|null/);
    expect(app.api.editor.buffers().length).toBe(1);

    // 5. Missing file (ENOENT) opens an empty Buffer for a new file
    await app.press(":e does-not-exist.sql<CR>");
    await app.waitFor(() => app.api.editor.buffers().length === 2);
    expect(app.api.editor.text()).toBe("");
    expect(app.api.editor.buffers()[1]!.name).toBe("does-not-exist.sql");

    // 6. \r\n and lone \r are normalized to \n when loaded (and agree across Buffer, EditorApi, and persisted text)
    const crlfPath = join(cwd, "crlf.sql");
    await Bun.write(crlfPath, "select 1;\r\nselect 2;\rselect 3;\r\n");
    await app.press(":e crlf.sql<CR>");
    await app.waitFor(() => app.api.editor.buffers().length === 3);
    expect(app.api.editor.text()).toBe("select 1;\nselect 2;\nselect 3;");
    expect(app.api.editor.buffers()[2]!.text).toBe("select 1;\nselect 2;\nselect 3;");
    await app.api.editor.flush();
    const persisted = await loadBuffers(app.deps.paths, "demo");
    expect(persisted?.buffers[2]?.text).toBe("select 1;\nselect 2;\nselect 3;");
  });

  test("Fix 8: the tab row shows whole tabs without squeezing, cuts names >20 cells with …, always includes the active Buffer, and marks hidden sides with ‹ and › at widths 100 and 40", async () => {
    await start("b1", { width: 100 });
    // Open 24 more buffers (total 25), including one with a name longer than 20 cells
    for (let i = 2; i <= 25; i++) {
      const name = i === 13 ? "very_long_buffer_name_exceeding_twenty_cells.sql" : `buffer-${i}`;
      app.api.editor.openBuffer({ name, text: `select ${i};` });
    }
    await app.settle();
    expect(app.api.editor.buffers().length).toBe(25);

    const checkAtWidth = async (width: number) => {
      await app.resize(width, 36);

      // Active first (index 0, tab 1)
      await app.press(":ls<CR>");
      await app.press("<Esc>");
      while (app.api.editor.active() !== 0) {
        await app.press("gt");
      }
      expect(app.api.editor.active()).toBe(0);
      let topLine = app.frame().split("\n")[0]!;
      expect(topLine).toContain(" 1 scratch ");
      expect(topLine).toContain("›");
      expect(topLine).not.toContain("‹");

      // Active in the middle (index 12, tab 13 with long name > 20 cells)
      for (let k = 0; k < 12; k++) {
        await app.press("gt");
      }
      expect(app.api.editor.active()).toBe(12);
      topLine = app.frame().split("\n")[0]!;
      expect(topLine).toContain(" 13 very_long_buffer_na… ");
      expect(topLine).toContain("‹");
      expect(topLine).toContain("›");

      // Active last (index 24, tab 25)
      for (let k = 0; k < 12; k++) {
        await app.press("gt");
      }
      expect(app.api.editor.active()).toBe(24);
      topLine = app.frame().split("\n")[0]!;
      expect(topLine).toContain(" 25 buffer-25 ");
      expect(topLine).toContain("‹");
      expect(topLine).not.toContain("›");
    };

    await checkAtWidth(100);
    await checkAtWidth(40);
  });

  test("Fix 10: a saved set of Buffers is never overwritten during load, and edits made during load are merged with the loaded set", async () => {
    let releaseLoad!: () => void;
    const gateLoad = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });

    app = await mount({
      deps: {
        loadBuffers: async (paths, connId) => {
          if (connId === "demo") {
            await gateLoad;
          }
          return loadBuffers(paths, connId);
        },
      },
      seed: async (deps) => {
        await saveBuffers(
          deps.paths,
          "demo",
          [
            { name: "saved-1.sql", path: null, text: "select 'from disk 1';" },
            { name: "saved-2.sql", path: null, text: "select 'from disk 2';" },
          ],
          1,
        );
      },
    });
    await app.waitFor(() => app.api.session.status() === "connected");

    // While the load is still in flight, type into the scratch Buffer
    app.api.editor.setText("typed while loading");
    await app.settle();

    // Advance the clock past the 400ms debounce: nothing may be saved before load finishes!
    await app.advance(500);
    expect(await loadBuffers(app.deps.paths, "demo")).toEqual({
      buffers: [
        { name: "saved-1.sql", path: null, text: "select 'from disk 1';" },
        { name: "saved-2.sql", path: null, text: "select 'from disk 2';" },
      ],
      active: 1,
    });

    // Now resolve the load by hand
    releaseLoad();
    await app.waitFor(() => app.api.editor.buffers().length === 3);

    // The loaded Buffers are there AND the typed text is there
    const names = app.api.editor.buffers().map((b) => b.name);
    const texts = app.api.editor.buffers().map((b) => b.text);
    expect(names).toContain("saved-1.sql");
    expect(names).toContain("saved-2.sql");
    expect(texts).toContain("select 'from disk 1';");
    expect(texts).toContain("select 'from disk 2';");
    expect(texts).toContain("typed while loading");
    expect(app.api.editor.text()).toBe("typed while loading");

    // And the file on disk STILL holds the saved Buffers until the next save writes the merged set
    expect(await loadBuffers(app.deps.paths, "demo")).toEqual({
      buffers: [
        { name: "saved-1.sql", path: null, text: "select 'from disk 1';" },
        { name: "saved-2.sql", path: null, text: "select 'from disk 2';" },
      ],
      active: 1,
    });

    // Trigger the next save (advance debounce or flush) and verify the merged set is written to disk
    await app.advance(500);
    await app.api.editor.flush();
    const afterMergeSave = await loadBuffers(app.deps.paths, "demo");
    expect(afterMergeSave?.buffers.map((b) => b.text)).toEqual(texts);
  });

  test("Fix 2 (round 2): :e opens regular files only and refuses /dev/zero, a FIFO, and symlinks to them without reading", async () => {
    await start("initial");
    const cwd = app.deps.cwd;
    const { statSync } = await import("node:fs");
    const { symlink } = await import("node:fs/promises");
    const { spyOn } = await import("bun:test");
    const fsPromises = await import("node:fs/promises");

    const fifoPath = join(cwd, "mypipe.sql");
    const mk = Bun.spawnSync(["mkfifo", fifoPath]);
    expect(mk.exitCode).toBe(0);

    const fifoLinkPath = join(cwd, "link-to-fifo.sql");
    await symlink(fifoPath, fifoLinkPath);

    let hasDevZero = false;
    try {
      statSync("/dev/zero");
      hasDevZero = true;
    } catch {
      hasDevZero = false;
    }

    const zeroLinkPath = join(cwd, "link-to-zero.sql");
    if (hasDevZero) {
      await symlink("/dev/zero", zeroLinkPath);
    }

    const readSpy = spyOn(fsPromises, "readFile").mockImplementation(async () => {
      throw new Error("readFile should not be called on non-regular files");
    });
    try {
      const checkSpecial = async (arg: string) => {
        app.api.status.clear();
        readSpy.mockClear();
        const t0 = performance.now();
        await app.api.commands.run("buffer.edit", arg);
        const elapsed = performance.now() - t0;
        expect(elapsed).toBeLessThan(100);
        expect(readSpy).not.toHaveBeenCalled();
        expect(app.api.status.message()).toEqual({
          text: `Not a regular file: ${arg}`,
          kind: "error",
        });
        expect(app.api.editor.buffers().length).toBe(1);
      };

      if (hasDevZero) {
        await checkSpecial("/dev/zero");
        await checkSpecial("link-to-zero.sql");
      }
      await checkSpecial("mypipe.sql");
      await checkSpecial("link-to-fifo.sql");
    } finally {
      readSpy.mockRestore();
    }
  });

  test("Fix 5 (round 2): the Buffer tabs always show ‹ and › when tabs are hidden, cut the active tab title with … as needed, and never exceed the Pane width at widths 8 to 40", async () => {
    const runSuite = async (titleFn: (i: number) => string) => {
      // PaneFrame has paddingLeft=1 and paddingRight=1 (2 cells total), so terminal width = pane inner width + 2
      await start("select 1;", { width: 42 });
      for (let i = 1; i <= 12; i++) {
        app.api.editor.openBuffer({ name: titleFn(i), text: `select ${i};` });
      }
      // Close the initial scratch buffer so we have 12 buffers with exact titles
      while (app.api.editor.active() !== 0) await app.press("gt");
      await app.press(":bd<CR>");
      expect(app.api.editor.buffers().length).toBe(12);

      for (const targetIdx of [0, 6, 11]) {
        while (app.api.editor.active() !== targetIdx) {
          await app.press("gt");
        }
        expect(app.api.editor.active()).toBe(targetIdx);

        for (let paneWidth = 8; paneWidth <= 40; paneWidth++) {
          await app.resize(paneWidth + 2, 36);
          const rawLine = app.frame().split("\n")[0] ?? "";
          // Strip 1 cell left padding and 1 cell right padding of PaneFrame
          const innerLine = rawLine.slice(1, rawLine.length - 1).trimEnd();
          expect(Bun.stringWidth(innerLine)).toBeLessThanOrEqual(paneWidth);

          const hasHiddenLeft = targetIdx > 0;
          const hasHiddenRight = targetIdx < 11;
          const bufName = app.api.editor.buffers()[targetIdx]!.name;
          const firstCharWidth = Bun.stringWidth([...bufName][0]!);
          const minForMarkersAndOneChar =
            (hasHiddenLeft ? 2 : 0) +
            (hasHiddenRight ? 2 : 0) +
            ` ${targetIdx + 1} `.length +
            firstCharWidth +
            2; // `… `

          if (paneWidth >= minForMarkersAndOneChar) {
            if (hasHiddenLeft) expect(innerLine).toContain("‹");
            if (hasHiddenRight) expect(innerLine).toContain("›");
          }
        }
      }
      await app.dispose();
    };

    // 12 Buffers with 3-character titles
    await runSuite((i) => `b${String(i).padStart(2, "0")}`);
    // 12 Buffers with 60-character titles including a wide character
    await runSuite((i) => (`世_${"long_buffer_title_".repeat(4)}${i}`).slice(0, 59));
  });

  test("Fix 6 (round 2): setLoadBuffersInterceptor is removed and deps.loadBuffers replaces the loader per application", async () => {
    const buffersMod = await import("./buffers");
    expect("setLoadBuffersInterceptor" in buffersMod).toBe(false);

    app = await mount({
      deps: {
        loadBuffers: async () => ({
          buffers: [{ name: "custom.sql", path: null, text: "select 'per-app';" }],
          active: 0,
        }),
      },
    });
    await app.waitFor(() => app.api.session.status() === "connected");
    await app.waitFor(() => app.api.editor.text() === "select 'per-app';");
    expect(app.api.editor.buffers().map((b) => b.name)).toEqual(["custom.sql"]);
  });
});






describe("final fix 3: a damaged file of saved Buffers is not thrown away", () => {
  test("the valid Buffers are shown, one warning toast names the file, and the first save keeps the original as .bad", async () => {
    const original = `${JSON.stringify({
      buffers: [
        { name: "a.sql", path: null, text: "select 'a'" },
        { name: "b", path: null, text: "select 'b'" },
        { name: "c", path: 7, text: "select 'c'" },
      ],
      active: 1,
    })}\n`;
    let file = "";
    app = await mount({
      seed: async (deps) => {
        file = join(deps.paths.buffersDir, "demo.json");
        await mkdir(deps.paths.buffersDir, { recursive: true });
        await Bun.write(file, original);
      },
    });
    await app.waitFor(() => app.api.session.status() === "connected");
    await app.waitFor(() => app.api.editor.buffers().length === 2);
    expect(app.api.editor.buffers().map((b) => b.name)).toEqual(["a.sql", "b"]);
    expect(app.api.editor.text()).toBe("select 'b'");

    const warnings = () => app.api.toast.items().filter((t) => t.message.startsWith("Some saved buffers in "));
    await app.waitFor(() => warnings().length > 0);
    expect(warnings().length).toBe(1);
    expect(warnings()[0]).toMatchObject({
      kind: "warning",
      message: `Some saved buffers in ${file} could not be read; the file was kept as ${file}.bad`,
    });
    expect(await Bun.file(file).text()).toBe(original);
    expect(await Bun.file(`${file}.bad`).exists()).toBe(false);

    app.api.editor.setText("select 'b2'");
    await app.settle();
    await app.advance(400);
    await app.waitFor(() => Bun.file(`${file}.bad`).size > 0);
    await app.api.editor.flush();

    expect(await Bun.file(`${file}.bad`).text()).toBe(original);
    const { stat } = await import("node:fs/promises");
    expect((await stat(`${file}.bad`)).mode & 0o777).toBe(0o600);
    expect(await loadBuffers(app.deps.paths, "demo")).toEqual({
      buffers: [
        { name: "a.sql", path: null, text: "select 'a'" },
        { name: "b", path: null, text: "select 'b2'" },
      ],
      active: 1,
    });
    await app.settle();
    expect(warnings().length).toBe(1);
  });

  test("a file that is not saved Buffers at all shows the default Buffer, warns once, and is kept as .bad at the first save", async () => {
    let file = "";
    app = await mount({
      seed: async (deps) => {
        file = join(deps.paths.buffersDir, "demo.json");
        await mkdir(deps.paths.buffersDir, { recursive: true });
        await Bun.write(file, "{ not json");
      },
    });
    await app.waitFor(() => app.api.session.status() === "connected");
    const warnings = () => app.api.toast.items().filter((t) => t.message.startsWith("Some saved buffers in "));
    await app.waitFor(() => warnings().length > 0);
    expect(app.api.editor.buffers().map((b) => b.name)).toEqual(["scratch"]);
    app.api.editor.setText("select 1");
    await app.api.editor.flush();
    expect(await Bun.file(`${file}.bad`).text()).toBe("{ not json");
    expect((await loadBuffers(app.deps.paths, "demo"))!.buffers).toEqual([{ name: "scratch", path: null, text: "select 1" }]);
    expect(warnings().length).toBe(1);
  });

  test("a missing file gives no warning", async () => {
    await start("select 1");
    await app.api.editor.flush();
    expect(app.api.toast.items().filter((t) => t.message.startsWith("Some saved buffers in "))).toEqual([]);
  });
});
