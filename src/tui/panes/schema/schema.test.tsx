import { afterEach, describe, expect, test } from "bun:test";
import { createSignal, Show } from "solid-js";
import { osc52 } from "../../../core/clipboard";
import type { Connection, Driver, Result, SchemaSnapshot } from "../../../core/db/types";
import type { ExecRequest, ExecResult } from "../../../core/exec";
import { readHistory } from "../../../core/state";
import { mount, type MountOptions, type TestApp } from "../../testing";
import { SchemaPane } from "./SchemaPane";

let app: TestApp;
afterEach(async () => { await app?.dispose(); });

async function start(options: MountOptions = {}) {
  app = await mount(options);
  await app.waitFor(() => app.api.session.schema() !== null);
  app.api.focus.focus("schema");
  await app.settle();
}
const labels = () => app.api.schema.rows().map((r) => r.label);
const current = () => app.api.schema.rows()[app.api.schema.cursor()]!;

describe("the tree", () => {
  test("lists the namespace and its Relations", async () => {
    await start();
    expect(labels()).toEqual(["main", "customers", "order_items", "orders", "products"]);
    for (const text of ["SCHEMA", "▾ main", "▸ customers", "▸ orders"]) expect(app.frame()).toContain(text);
    expect(app.api.schema.cursor()).toBe(0);
  });

  test("l expands, h collapses and then goes to the parent", async () => {
    await start();
    await app.press("jl");
    expect(labels().slice(0, 4)).toEqual(["main", "customers", "id", "name"]);
    expect(app.frame()).toContain("▾ customers");
    expect(app.frame()).toContain("integer pk");
    await app.press("l");
    expect(current().label).toBe("id");
    await app.press("h");
    expect(current().label).toBe("customers");
    await app.press("h");
    expect(labels()).toEqual(["main", "customers", "order_items", "orders", "products"]);
    await app.press("h");
    expect(current().label).toBe("main");
    await app.press("h");
    expect(labels()).toEqual(["main"]);
    await app.press("l");
    expect(labels().length).toBe(5);
  });

  test("foreign keys are shown", async () => {
    await start();
    await app.press("jjl");
    expect(app.frame()).toContain("integer → orders.id");
  });

  test("j, k, counts, gg and G move the cursor", async () => {
    await start();
    await app.press("3j");
    expect(current().label).toBe("orders");
    await app.press("k");
    expect(current().label).toBe("order_items");
    await app.press("G");
    expect(current().label).toBe("products");
    await app.press("jgg");
    expect(current().label).toBe("main");
    await app.press("k");
    expect(app.api.schema.cursor()).toBe(0);
  });

  test("a long tree scrolls with the cursor", async () => {
    const schema: SchemaSnapshot = {
      dialect: "postgres",
      namespaces: [{ name: "public", relations: Array.from({ length: 80 }, (_, i) => ({ name: `table_${String(i).padStart(2, "0")}`, kind: "table" as const, columns: [] })) }],
    };
    const openSession = async (connection: Connection): Promise<Driver> => ({
      connection, run: async () => { throw new Error("unused"); }, schema: async () => schema, close: async () => {},
    });
    await start({ connection: "postgres://localhost/dev", deps: { openSession } });
    expect(app.frame()).toContain("table_00");
    expect(app.frame()).not.toContain("table_79");
    await app.press("G");
    expect(app.frame()).toContain("table_79");
    expect(app.frame()).not.toContain("table_00");
  });

  test("without a Session it says so", async () => {
    app = await mount({ connection: null });
    expect(app.frame()).toContain("Not connected");
  });
});

describe("actions", () => {
  test("Enter peeks at a Relation without touching the Buffer or the history", async () => {
    await start({ config: { results: { peekRows: 3 } } });
    const before = app.api.editor.text();
    await app.press("j<CR>");
    await app.waitFor(() => app.api.session.shown() !== null);
    const outcome = app.api.session.shown()!;
    expect(outcome.statement).toBe("select * from customers limit 3");
    expect(outcome.ok && outcome.result.rows.length).toBe(3);
    expect(app.api.editor.text()).toBe(before);
    expect(app.api.focus.pane()).toBe("schema");
    expect(await readHistory(app.deps.paths)).toEqual([]);
  });

  test("Enter on a column peeks at its Relation, and on a namespace toggles it", async () => {
    await start();
    await app.press("jlj<CR>");
    await app.waitFor(() => app.api.session.shown() !== null);
    expect(app.api.session.shown()!.statement).toBe("select * from customers limit 100");
    await app.press("gg<CR>");
    expect(labels()).toEqual(["main"]);
  });

  test("a peek is read-only and quotes names", async () => {
    const seen: [string, boolean | undefined][] = [];
    const result: Result = { columns: [{ name: "x", type: "int4" }], rows: [], truncated: false, affected: null, command: "SELECT", durationMs: 1 };
    const schema: SchemaSnapshot = { dialect: "postgres", namespaces: [{ name: "billing", relations: [{ name: "Order Items", kind: "table", columns: [] }] }] };
    const openSession = async (connection: Connection): Promise<Driver> => ({
      connection,
      run: async (statement, options) => { seen.push([statement, options?.readOnly]); return result; },
      schema: async () => schema,
      close: async () => {},
    });
    await start({ connection: "postgres://localhost/dev", deps: { openSession } });
    await app.press("j<CR>");
    await app.waitFor(() => seen.length > 0);
    expect(seen).toEqual([['select * from billing."Order Items" limit 100', true]]);
  });

  test("i inserts the name into the editor and focuses it", async () => {
    await start();
    app.api.editor.setText("select * from ");
    app.api.focus.focus("editor");
    await app.press("$<C-w>hjji");
    expect(app.api.editor.text()).toBe("select * from order_items");
    expect(app.api.focus.pane()).toBe("editor");
  });

  test("y yanks the name", async () => {
    await start();
    await app.press("jy");
    expect(app.deps.written).toEqual([osc52("customers")]);
    await app.press("ljy");
    expect(app.deps.written[1]).toBe(osc52("id"));
  });

  test("/ filters, and Escape clears the filter", async () => {
    await start();
    await app.press("/ord<CR>");
    expect(app.api.schema.filter()).toBe("ord");
    expect(labels()).toEqual(["main", "orders", "order_items"]);
    expect(app.frame()).toContain("/ord");
    await app.press("<Esc>");
    expect(app.api.schema.filter()).toBe("");
    expect(labels().length).toBe(5);
  });

  test("R reloads the schema", async () => {
    await start();
    await app.api.session.driver()!.run("create table zebra (x integer)");
    await app.press("R");
    await app.waitFor(() => labels().includes("zebra"));
  });

  test("the tree follows a new Session", async () => {
    await start();
    await app.api.session.connect(":memory:");
    await app.waitFor(() => labels().length === 1);
    expect(app.frame()).toContain("No tables");
  });

  test("sanitises control characters on screen, cuts wide names at character boundaries, and scales to 5,000 Relations", async () => {
    let collapsedColumnReads = 0;
    const relations = Array.from({ length: 5000 }, (_, i) => {
      const cols = Array.from({ length: 20 }, (__, c) => ({
        name: c === 0 ? `col\x1b_${c}_🚀_🚀_🚀` : `col_${c}`,
        type: c === 0 ? "int4\x07" : "text",
        nullable: true,
        primaryKey: c === 0,
      }));
      if (i === 0) {
        return {
          name: "bad\x07\ntable_🚀_🚀_🚀_🚀",
          kind: "table" as const,
          columns: cols,
        };
      }
      return {
        name: `table_${String(i).padStart(4, "0")}`,
        kind: "table" as const,
        get columns() {
          collapsedColumnReads++;
          return cols;
        },
      };
    });
    const bigSchema: SchemaSnapshot = {
      dialect: "postgres",
      namespaces: [{ name: "public", relations }],
    };
    const openSession = async (connection: Connection): Promise<Driver> => ({
      connection,
      run: async () => {
        throw new Error("unused");
      },
      schema: async () => bigSchema,
      close: async () => {},
    });

    await start({ connection: "postgres://localhost/dev", deps: { openSession } });
    const rowsInitial = app.api.schema.rows();
    expect(rowsInitial.length).toBe(5001);
    expect(collapsedColumnReads).toBe(0);

    app.api.keys.dispatch({ name: "j", text: "j" });
    await app.setup.renderOnce();
    await app.settle();
    const rowsAfterMove = app.api.schema.rows();
    // Moving the cursor does not rebuild the tree array or touch collapsed columns
    expect(rowsAfterMove).toBe(rowsInitial);
    expect(collapsedColumnReads).toBe(0);

    app.api.keys.dispatch({ name: "l", text: "l" });
    await app.setup.renderOnce();
    await app.settle();
    const rowsAfterExpand = app.api.schema.rows();
    expect(rowsAfterExpand.length).toBe(5021);
    // Expanding the first Relation reuses row objects for the namespace and all 4,999 other Relations, without reading their columns
    expect(rowsAfterExpand[0]).toBe(rowsInitial[0]);
    expect(rowsAfterExpand[22]).toBe(rowsInitial[2]);
    expect(rowsAfterExpand[5020]).toBe(rowsInitial[5000]);
    expect(collapsedColumnReads).toBe(0);

    const frame = app.frame();
    expect(frame).not.toContain("\x07");
    expect(frame).not.toContain("\x1b");
    expect(frame).toContain("\ufffd");
    // No lone surrogates in the rendered frame
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(frame)).toBe(false);

    await app.press("/table_2500");
    app.api.keys.dispatch({ name: "enter" });
    await app.setup.renderOnce();
    await app.settle();

    expect(app.api.schema.filter()).toBe("table_2500");
    const rowsAfterFilter = app.api.schema.rows();
    expect(rowsAfterFilter.some((r) => r.label === "table_2500")).toBe(true);
    // Filtering reuses the cached namespace and Relation row objects and never reads collapsed columns
    expect(rowsAfterFilter[0]).toBe(rowsInitial[0]);
    expect(rowsAfterFilter[1]).toBe(rowsInitial[2501]);
    expect(collapsedColumnReads).toBe(0);
  });

  test("<C-d>, <C-u>, statusline segment, and schema refresh preservation/clamping", async () => {
    let currentSchema: SchemaSnapshot = {
      dialect: "postgres",
      namespaces: [
        {
          name: "public",
          relations: Array.from({ length: 40 }, (_, i) => ({
            name: `tbl_${String(i).padStart(2, "0")}`,
            kind: "table" as const,
            columns: [{ name: "id", type: "int4", nullable: false, primaryKey: true }],
          })),
        },
      ],
    };
    const openSession = async (connection: Connection): Promise<Driver> => ({
      connection,
      run: async () => {
        throw new Error("unused");
      },
      schema: async () => currentSchema,
      close: async () => {},
    });

    await start({ connection: "postgres://localhost/dev", deps: { openSession } });
    expect(app.api.status.current()).toEqual({ mode: "NORMAL", pending: "", position: "1/41" });

    await app.press("3");
    expect(app.api.status.current().pending).toBe("3");
    await app.press("j");
    expect(app.api.status.current()).toEqual({ mode: "NORMAL", pending: "", position: "4/41" });

    await app.press("<C-d>");
    const afterDown = app.api.schema.cursor();
    expect(afterDown).toBeGreaterThan(4);
    await app.press("<C-u>");
    expect(app.api.schema.cursor()).toBe(3);

    // Expand tbl_02 and refresh with a new table inserted before it
    await app.press("l");
    const row3 = app.api.schema.rows()[3]!;
    expect(row3.kind === "relation" && row3.expanded).toBe(true);

    currentSchema = {
      dialect: "postgres",
      namespaces: [
        {
          name: "public",
          relations: [
            { name: "aaa_first", kind: "table", columns: [] },
            ...currentSchema.namespaces[0]!.relations,
          ],
        },
      ],
    };
    await app.press("R");
    await app.waitFor(() => app.api.schema.rows().some((r) => r.label === "aaa_first"));
    // tbl_02 stays expanded and cursor tracks tbl_02 at its new index (4)
    const curRow = current();
    expect(curRow.label).toBe("tbl_02");
    expect(curRow.kind === "relation" && curRow.expanded).toBe(true);

    // Refresh to a tiny schema where tbl_02 no longer exists -> cursor and scroll clamp safely
    await app.press("G");
    currentSchema = {
      dialect: "postgres",
      namespaces: [
        {
          name: "public",
          relations: [{ name: "only_one", kind: "table", columns: [] }],
        },
      ],
    };
    await app.press("R");
    await app.waitFor(() => app.api.schema.rows().length === 2);
    expect(app.api.schema.cursor()).toBe(1);
    expect(current().label).toBe("only_one");
  });

  test("under a filter, <CR>, h and l on a namespace row do nothing and leave the tree as it was after the filter is cleared", async () => {
    await start();
    const before = labels();
    expect(before).toEqual(["main", "customers", "order_items", "orders", "products"]);

    await app.press("/ord<CR>");
    expect(app.api.schema.filter()).toBe("ord");
    expect(labels()).toEqual(["main", "orders", "order_items"]);
    expect(app.api.schema.cursor()).toBe(1);

    // Move to the namespace row ("main")
    await app.press("gg");
    expect(app.api.schema.cursor()).toBe(0);
    expect(current().label).toBe("main");

    // <CR> on namespace does nothing
    await app.press("<CR>");
    expect(app.api.schema.cursor()).toBe(0);
    expect(labels()).toEqual(["main", "orders", "order_items"]);

    // h on namespace does nothing
    await app.press("h");
    expect(app.api.schema.cursor()).toBe(0);
    expect(labels()).toEqual(["main", "orders", "order_items"]);

    // l on namespace does nothing
    await app.press("l");
    expect(app.api.schema.cursor()).toBe(0);
    expect(labels()).toEqual(["main", "orders", "order_items"]);

    // Clear filter: tree is as it was before the filter
    await app.press("<Esc>");
    expect(app.api.schema.filter()).toBe("");
    expect(labels()).toEqual(before);
  });

  test("a filter that matches nothing shows 'No matches for \"<filter>\"' and Escape clears it", async () => {
    await start();
    await app.press("/zzz_none<CR>");
    expect(app.api.schema.filter()).toBe("zzz_none");
    expect(app.api.schema.rows()).toEqual([]);
    expect(app.frame()).toContain('No matches for "zzz_none"');

    await app.press("<Esc>");
    expect(app.api.schema.filter()).toBe("");
    expect(app.frame()).not.toContain('No matches for "zzz_none"');
    expect(labels()).toEqual(["main", "customers", "order_items", "orders", "products"]);
  });

  test("switching Connection clears the filter and the remembered cursor row", async () => {
    const schema1: SchemaSnapshot = {
      dialect: "postgres",
      namespaces: [
        {
          name: "public",
          relations: [
            { name: "customers", kind: "table", columns: [] },
            { name: "order_items", kind: "table", columns: [] },
            { name: "orders", kind: "table", columns: [] },
            { name: "products", kind: "table", columns: [] },
          ],
        },
      ],
    };
    const schema2: SchemaSnapshot = {
      dialect: "postgres",
      namespaces: [
        {
          name: "public",
          relations: [
            { name: "alpha", kind: "table", columns: [] },
            { name: "beta", kind: "table", columns: [] },
            { name: "orders", kind: "table", columns: [] },
          ],
        },
      ],
    };
    const openSession = async (connection: Connection): Promise<Driver> => ({
      connection,
      run: async () => {
        throw new Error("unused");
      },
      schema: async () => (connection.id.includes("dbb") ? schema2 : schema1),
      close: async () => {},
    });

    await start({ connection: "postgres://localhost/dba", deps: { openSession } });
    // Move cursor to "orders" (row 3) and set a filter
    await app.press("/ord<CR>");
    expect(app.api.schema.filter()).toBe("ord");
    expect(current().label).toBe("orders");

    await app.api.session.connect("postgres://localhost/dbb");
    await app.waitFor(() => app.api.session.schema() === schema2);
    await app.settle();

    expect(app.api.schema.filter()).toBe("");
    expect(labels()).toEqual(["public", "alpha", "beta", "orders"]);
    expect(app.api.schema.cursor()).toBe(0);
  });

  test("when loading the Schema fails, the Pane shows 'Schema could not be loaded', the error message, and 'R retries', and R recovers", async () => {
    let calls = 0;
    const recoveredSchema: SchemaSnapshot = {
      dialect: "postgres",
      namespaces: [
        {
          name: "public",
          relations: [{ name: "recovered_table", kind: "table", columns: [] }],
        },
      ],
    };
    const openSession = async (connection: Connection): Promise<Driver> => ({
      connection,
      run: async () => {
        throw new Error("unused");
      },
      schema: async () => {
        calls++;
        if (calls === 1) {
          throw new Error("permission denied\x07 for schema");
        }
        return recoveredSchema;
      },
      close: async () => {},
    });

    app = await mount({ connection: "postgres://localhost/dev", deps: { openSession } });
    await app.waitFor(() => app.api.session.schemaError() !== null);
    app.api.focus.focus("schema");
    await app.settle();

    const frame = app.frame();
    expect(frame).not.toContain("loading schema");
    expect(frame).toContain("Schema could not be loaded");
    expect(frame).toContain("permission denied\ufffd for schema");
    expect(frame).toContain("R retries");

    await app.press("R");
    await app.waitFor(() => app.api.session.schema() === recoveredSchema);
    await app.settle();

    expect(app.api.session.schemaError()).toBeNull();
    expect(labels()).toEqual(["public", "recovered_table"]);
    expect(app.frame()).toContain("recovered_table");
    expect(app.frame()).not.toContain("Schema could not be loaded");
  });

  test("overlapping refreshes via R twice show the newer snapshot when the second resolves first", async () => {
    let calls = 0;
    let resolveFirst!: (s: SchemaSnapshot) => void;
    let resolveSecond!: (s: SchemaSnapshot) => void;

    const initialSchema: SchemaSnapshot = {
      dialect: "postgres",
      namespaces: [{ name: "public", relations: [{ name: "initial_rel", kind: "table", columns: [] }] }],
    };
    const firstSchema: SchemaSnapshot = {
      dialect: "postgres",
      namespaces: [{ name: "public", relations: [{ name: "older_rel", kind: "table", columns: [] }] }],
    };
    const secondSchema: SchemaSnapshot = {
      dialect: "postgres",
      namespaces: [{ name: "public", relations: [{ name: "newer_rel", kind: "table", columns: [] }] }],
    };

    const openSession = async (connection: Connection): Promise<Driver> => ({
      connection,
      run: async () => {
        throw new Error("unused");
      },
      schema: async () => {
        calls++;
        if (calls === 1) return initialSchema;
        if (calls === 2) {
          return new Promise<SchemaSnapshot>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return new Promise<SchemaSnapshot>((resolve) => {
          resolveSecond = resolve;
        });
      },
      close: async () => {},
    });

    await start({ connection: "postgres://localhost/dev", deps: { openSession } });
    expect(labels()).toEqual(["public", "initial_rel"]);

    // Press R twice
    await app.press("R");
    await app.press("R");
    expect(calls).toBe(3);

    // Second refresh resolves first
    resolveSecond(secondSchema);
    await app.waitFor(() => labels().includes("newer_rel"));
    expect(labels()).toEqual(["public", "newer_rel"]);

    // First refresh resolves afterwards -> tree keeps the newer snapshot
    resolveFirst(firstSchema);
    await app.settle();
    expect(labels()).toEqual(["public", "newer_rel"]);
    expect(app.frame()).toContain("newer_rel");
    expect(app.frame()).not.toContain("older_rel");
  });

  test("a failed copy says Could not copy: <reason> on the status line", async () => {
    await start({
      deps: {
        write: () => {
          throw new Error("terminal write failed");
        },
        which: (bin) => (bin === "xclip" ? "/usr/bin/xclip" : null),
        exec: async () => ({
          code: null,
          stdout: "",
          stderr: "",
          timedOut: true,
          aborted: false,
        }),
      },
    });
    await app.press("jy");
    await app.waitFor(() => app.api.status.message() !== null);
    expect(app.api.status.message()).toEqual({
      text: "Could not copy: xclip timed out",
      kind: "error",
    });
  });

  test("a successful copy writes to the clipboard and leaves the status line clear", async () => {
    await start();
    await app.press("jy");
    expect(app.deps.written).toEqual([osc52("customers")]);
    expect(app.api.status.message()).toBeNull();
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

test("a failed copy that finishes after the Schema Pane is gone changes nothing", async () => {
  const [shown, setShown] = createSignal(true);
  const tool = heldFailingTool("xclip");
  app = await mount({
    deps: {
      write: () => {
        throw new Error("terminal write failed");
      },
      which: (bin) => (bin === "xclip" ? "/usr/bin/xclip" : null),
      exec: tool.exec,
    },
    ui: () => (
      <Show when={shown()}>
        <SchemaPane />
      </Show>
    ),
  });
  await app.waitFor(() => app.api.session.schema() !== null);
  app.api.focus.focus("schema");
  await app.settle();
  await app.press("jy");
  expect(tool.calls).toEqual(["/usr/bin/xclip"]);
  setShown(false);
  await app.settle();
  tool.release();
  await app.settle();
  expect(app.api.status.message()).toBeNull();
});
