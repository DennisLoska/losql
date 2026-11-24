import { afterEach, describe, expect, test } from "bun:test";
import type {
  Connection,
  Driver,
  Relation,
  RelationDetails,
  RelationRef,
  Result,
  SchemaSnapshot,
} from "../../../core/db/types";
import { QueryError } from "../../../core/db/types";
import { mount, spanWith, type MountOptions, type TestApp } from "../../testing";
import { cellWidth } from "../../ui/cells";
import { wrapRanges } from "./StructureView";

let app: TestApp;
afterEach(async () => { await app?.dispose(); });

const mainRef = (name: string): RelationRef => ({ namespace: "main", name });

async function start(options: MountOptions = {}) {
  app = await mount(options);
  await app.waitFor(() => app.api.session.status() === "connected");
  await app.waitFor(() => app.api.session.schema() !== null);
}

const people = "select 'Ada' as name, 42 as answer union all select 'Linus', 7";

/** Run SQL through the Session and focus the Results Pane. */
async function run(...statements: string[]) {
  await app.api.session.run({ statements });
  app.api.focus.focus("results");
  await app.settle();
}

const structure = () => app.api.results.structure();
const copied = () => app.deps.written[app.deps.written.length - 1];
function copiedText(): string | undefined {
  const raw = copied();
  return raw === undefined ? undefined : Buffer.from(raw.slice(7, -1), "base64").toString("utf8");
}

async function waitReady() {
  await app.waitFor(() => app.api.results.structure()?.status === "ready");
  return app.api.results.structure()!;
}

function schemaWith(relations: Relation[], namespaces?: SchemaSnapshot["namespaces"]): SchemaSnapshot {
  return {
    dialect: "postgres",
    namespaces: namespaces ?? [{ name: "main", relations }],
  };
}

const ordersSchema = schemaWith([
  { name: "customers", kind: "table", columns: [{ name: "id", type: "integer", nullable: false, primaryKey: true }] },
  { name: "orders", kind: "table", columns: [] },
  { name: "products", kind: "table", columns: [] },
]);

function ordersDetails(overrides: Partial<RelationDetails> = {}): RelationDetails {
  return {
    namespace: "main",
    name: "orders",
    kind: "table",
    columns: [
      { name: "id", type: "integer", nullable: false, primaryKeyPosition: 1, references: [] },
      { name: "customer_id", type: "integer", nullable: false, references: [{ relation: "customers", column: "id" }] },
    ],
    indexes: [],
    constraints: [],
    definition: "CREATE TABLE orders (id integer primary key)",
    ...overrides,
  };
}

/** A Driver whose describeRelation calls stay pending until the test resolves them. */
function pendingDriver(schema: SchemaSnapshot) {
  interface Call {
    ref: RelationRef;
    signal?: AbortSignal;
    resolve: (details: RelationDetails | null) => void;
  }
  const calls: Call[] = [];
  const openSession = async (connection: Connection): Promise<Driver> => ({
    connection,
    run: async (): Promise<Result> => ({
      columns: [{ name: "x", type: "text" }],
      rows: [["1"]],
      truncated: false,
      affected: null,
      command: "SELECT",
      durationMs: 1,
    }),
    schema: async () => schema,
    describeRelation: (ref, options) =>
      new Promise<RelationDetails | null>((resolve) => {
        calls.push({ ref, signal: options?.signal, resolve });
      }),
    close: async () => {},
  });
  return { calls, openSession };
}

/** A Driver whose describeRelation resolves at once from a lookup table. */
function lookupDriver(schema: SchemaSnapshot, lookup: (ref: RelationRef) => RelationDetails | null) {
  const calls: RelationRef[] = [];
  const openSession = async (connection: Connection): Promise<Driver> => ({
    connection,
    run: async (): Promise<Result> => ({
      columns: [{ name: "x", type: "text" }],
      rows: [["1"]],
      truncated: false,
      affected: null,
      command: "SELECT",
      durationMs: 1,
    }),
    schema: async () => schema,
    describeRelation: async (ref) => {
      calls.push(ref);
      return lookup(ref);
    },
    close: async () => {},
  });
  return { calls, openSession };
}


describe("entering Structure from the Schema Pane", () => {
  test("S on a Relation opens Structure before any Run and focuses Results", async () => {
    await start();
    app.api.focus.focus("schema");
    await app.press("j");
    expect(app.api.schema.selectedRelation()).toEqual(mainRef("customers"));
    await app.press("S");
    await waitReady();
    expect(structure()!.ref).toEqual(mainRef("customers"));
    expect(app.api.focus.pane()).toBe("results");
    expect(app.api.session.shown()).toBeNull();
    const frame = app.frame();
    expect(frame).toContain("customers");
    expect(frame).toContain("Columns");
    expect(frame).toContain("5 cols");
  });

  test("S on a child column opens Structure for its parent Relation", async () => {
    await start();
    app.api.focus.focus("schema");
    await app.press("3jlj");
    const rows = app.api.schema.rows();
    expect(rows[app.api.schema.cursor()]!.kind).toBe("column");
    expect(app.api.schema.selectedRelation()).toEqual(mainRef("orders"));
    await app.press("S");
    await waitReady();
    expect(structure()!.ref).toEqual(mainRef("orders"));
  });

  test("selectedRelation is null on a namespace row", async () => {
    await start();
    app.api.focus.focus("schema");
    await app.press("gg");
    expect(app.api.schema.rows()[0]!.kind).toBe("namespace");
    expect(app.api.schema.selectedRelation()).toBeNull();
  });
});

describe("entering Structure through Commands and the picker", () => {
  test(":inspect resolves a bare and a qualified name", async () => {
    await start();
    await app.press(":inspect orders<CR>");
    await waitReady();
    expect(structure()!.ref).toEqual(mainRef("orders"));
    expect(app.api.focus.pane()).toBe("results");

    await app.press("q");
    expect(structure()).toBeNull();
    await app.press(":inspect main.orders<CR>");
    await waitReady();
    expect(structure()!.ref).toEqual(mainRef("orders"));
  });

  test(":inspect resolves an unambiguous name case-folded", async () => {
    await start();
    await app.press(":inspect Orders<CR>");
    await waitReady();
    expect(structure()!.ref).toEqual(mainRef("orders"));
  });

  test(":inspect reports an unknown name as a Command error", async () => {
    await start();
    await app.press(":inspect nope<CR>");
    await app.settle();
    expect(structure()).toBeNull();
    expect(app.api.status.message()?.kind).toBe("error");
    expect(app.api.status.message()?.text).toContain("nope");
  });

  test(":inspect reports an ambiguous bare name and accepts the qualified form", async () => {
    const namespaces: SchemaSnapshot["namespaces"] = [
      { name: "alpha", relations: [{ name: "users", kind: "table", columns: [] }] },
      { name: "beta", relations: [{ name: "users", kind: "table", columns: [] }] },
    ];
    const schema = schemaWith([], namespaces);
    const driver = lookupDriver(schema, (ref) => ordersDetails({ namespace: ref.namespace, name: "users" }));
    await start({ connection: "postgres://localhost/dev", deps: { openSession: driver.openSession } });
    await app.press(":inspect users<CR>");
    await app.settle();
    expect(structure()).toBeNull();
    expect(app.api.status.message()?.kind).toBe("error");
    expect(app.api.status.message()?.text).toContain("users");

    await app.press(":inspect alpha.users<CR>");
    await waitReady();
    expect(structure()!.ref).toEqual({ namespace: "alpha", name: "users" });
  });

  test("<leader> v s inspects the Schema selection", async () => {
    await start();
    app.api.focus.focus("schema");
    await app.press("j");
    await app.press("<Space>vs");
    await waitReady();
    expect(structure()!.ref).toEqual(mainRef("customers"));
    expect(app.api.focus.pane()).toBe("results");
  });

  test(":view structure routes through view.structure", async () => {
    await start();
    app.api.focus.focus("schema");
    await app.press("3j");
    await app.press(":view structure<CR>");
    await waitReady();
    expect(structure()!.ref).toEqual(mainRef("orders"));
  });

  test("a picker opens with qualified names and selects the filtered Relation", async () => {
    await start();
    await run("select 1 as one");
    await app.press("<Space>vs");
    expect(app.api.dialog.depth()).toBe(1);
    expect(app.frame()).toContain("main.orders");
    await app.press("products");
    await app.press("<CR>");
    await waitReady();
    expect(structure()!.ref).toEqual(mainRef("products"));
    expect(app.api.focus.pane()).toBe("results");
    expect(app.api.dialog.depth()).toBe(0);
  });

  test("the picker preselects the last inspected Relation and Escape dismisses it", async () => {
    await start();
    app.api.results.inspect(mainRef("orders"));
    await waitReady();
    await app.press("q");
    expect(structure()).toBeNull();
    await run("select 1 as one");
    const shown = app.api.session.shown();

    await app.press("<Space>vs");
    expect(app.api.dialog.depth()).toBe(1);
    const marked = app.frame().split("\n").find((line) => line.includes("●"));
    expect(marked).toBeDefined();
    expect(marked!).toContain("orders");

    await app.press("<Esc>");
    expect(app.api.dialog.depth()).toBe(0);
    expect(structure()).toBeNull();
    expect(app.api.session.shown()).toBe(shown);
  });
});

describe("Schema peek provenance", () => {
  test("a peek sets previewRelationRef and <leader> v s inspects it from Results", async () => {
    await start();
    app.api.focus.focus("schema");
    await app.press("j<CR>");
    await app.waitFor(() => app.api.session.shown() !== null);
    expect(app.api.session.previewRelationRef()).toEqual(mainRef("customers"));

    // A peek leaves the Schema focused; from Results the peeked Relation is what <leader> v s inspects.
    app.api.focus.focus("results");
    await app.settle();
    await app.press("<Space>vs");
    await waitReady();
    expect(structure()!.ref).toEqual(mainRef("customers"));
  });

  test("an arbitrary Run clears previewRelationRef so <leader> v s opens the picker", async () => {
    await start();
    app.api.focus.focus("schema");
    await app.press("j<CR>");
    await app.waitFor(() => app.api.session.shown() !== null);
    expect(app.api.session.previewRelationRef()).not.toBeNull();

    await run("select 1 as one");
    expect(app.api.session.previewRelationRef()).toBeNull();
    await app.press("<Space>vs");
    expect(app.api.dialog.depth()).toBe(1);
  });

  test("a hidden Run leaves shown and its provenance alone", async () => {
    await start();
    app.api.focus.focus("schema");
    await app.press("j<CR>");
    await app.waitFor(() => app.api.session.shown() !== null);
    const shown = app.api.session.shown();

    await app.api.session.run({ statements: ["select 42 as n"], show: false });
    expect(app.api.session.shown()).toBe(shown);
    expect(app.api.session.previewRelationRef()).toEqual(mainRef("customers"));
  });

  test("a failed peek clears previewRelationRef", async () => {
    const schema: SchemaSnapshot = {
      dialect: "postgres",
      namespaces: [{
        name: "main",
        relations: [
          { name: "customers", kind: "table", columns: [{ name: "id", type: "integer", nullable: false, primaryKey: true }] },
          { name: "ghost", kind: "table", columns: [{ name: "id", type: "integer", nullable: false, primaryKey: true }] },
        ],
      }],
    };
    const openSession = async (connection: Connection): Promise<Driver> => ({
      connection,
      run: async (statement) => {
        if (statement.includes("ghost")) throw new QueryError("permission denied");
        return { columns: [{ name: "id", type: "integer" }], rows: [[1]], truncated: false, affected: null, command: "SELECT", durationMs: 1 };
      },
      schema: async () => schema,
      close: async () => {},
    });
    await start({ connection: "postgres://localhost/dev", deps: { openSession } });
    app.api.focus.focus("schema");
    await app.press("j<CR>");
    await app.waitFor(() => app.api.session.previewRelationRef() !== null);
    expect(app.api.session.previewRelationRef()).toEqual(mainRef("customers"));

    await app.press("j<CR>");
    await app.waitFor(() => app.api.session.shown()?.ok === false);
    expect(app.api.session.previewRelationRef()).toBeNull();
  });

  test("a direct show() clears previewRelationRef, and a Session change clears it too", async () => {
    await start();
    app.api.focus.focus("schema");
    await app.press("j<CR>");
    await app.waitFor(() => app.api.session.previewRelationRef() !== null);

    app.api.session.show(null);
    await app.settle();
    expect(app.api.session.previewRelationRef()).toBeNull();

    await app.press("j<CR>");
    await app.waitFor(() => app.api.session.previewRelationRef() !== null);
    const before = app.api.session.sessionId();
    await app.api.session.connect(":memory:");
    await app.waitFor(() => app.api.session.sessionId() !== before);
    expect(app.api.session.previewRelationRef()).toBeNull();
  });
});

describe("Session identity and schema revisions", () => {
  test("sessionId advances when the Driver is replaced", async () => {
    await start();
    const before = app.api.session.sessionId();
    await app.api.session.connect(":memory:");
    await app.waitFor(() => app.api.session.sessionId() !== before);
    expect(app.api.session.sessionId()).toBeGreaterThan(before);
  });

  test("schemaRevision advances when a refresh commits and not on a plain Run", async () => {
    await start();
    const rev = app.api.session.schemaRevision();
    await app.api.session.refreshSchema();
    await app.waitFor(() => app.api.session.schemaRevision() > rev);
    const afterRefresh = app.api.session.schemaRevision();
    await app.api.session.run({ statements: ["select 1"] });
    await app.settle();
    expect(app.api.session.schemaRevision()).toBe(afterRefresh);
  });
});

describe("the Structure layout", () => {
  test("the header strip lists Structure and highlights it only in Structure", async () => {
    await start();
    await run(people);
    for (const label of ["Table", "JSON", "Record", "Structure"]) {
      expect(app.frame()).toContain(label);
    }
    expect(spanWith(app.spans(), "Structure")!.fg.toInts()).toEqual(
      app.api.theme.color("textMuted").toInts(),
    );
    app.api.results.inspect(mainRef("orders"));
    await waitReady();
    expect(spanWith(app.spans(), "Structure")!.fg.toInts()).toEqual(
      app.api.theme.color("primary").toInts(),
    );
  });

  test("the banner shows the Relation, its kind, counts and the switch and back keys", async () => {
    await start();
    app.api.results.inspect(mainRef("orders"));
    const state = await waitReady();
    expect(state.details!.kind).toBe("table");
    const frame = app.frame();
    expect(frame).toContain("orders");
    expect(frame).toContain("4 cols");
    expect(frame).toContain("0 idx");
    expect(frame).toContain("2 constraints");
    expect(frame).toContain("c switch");
    expect(frame).toContain("q back");
  });

  test("the section strip names Columns, Indexes, Constraints and Definition", async () => {
    await start();
    app.api.results.inspect(mainRef("orders"));
    await waitReady();
    const frame = app.frame();
    for (const label of ["Columns", "Indexes", "Constraints", "Definition"]) {
      expect(frame).toContain(label);
    }
  });

  test("Definition is not offered when the Relation has none", async () => {
    const details = ordersDetails({ definition: undefined });
    const driver = lookupDriver(ordersSchema, () => details);
    await start({ connection: "postgres://localhost/dev", deps: { openSession: driver.openSession } });
    app.api.results.inspect(mainRef("orders"));
    await waitReady();
    const frame = app.frame();
    expect(frame).toContain("Columns");
    expect(frame).not.toContain("Definition");
  });

  test("the Columns section draws its headers", async () => {
    await start();
    app.api.results.inspect(mainRef("orders"));
    await waitReady();
    const frame = app.frame();
    for (const label of ["Column", "Type", "Null", "Default", "Key"]) {
      expect(frame).toContain(label);
    }
    expect(frame).toContain("customer_id");
  });
});

describe("Structure sections and navigation", () => {
  test("1 to 4 select sections and Tab and Shift+Tab wrap around them", async () => {
    await start();
    app.api.results.inspect(mainRef("orders"));
    await waitReady();
    expect(structure()!.section).toBe("columns");

    await app.press("2");
    expect(structure()!.section).toBe("indexes");
    await app.press("3");
    expect(structure()!.section).toBe("constraints");
    await app.press("4");
    expect(structure()!.section).toBe("definition");
    await app.press("1");
    expect(structure()!.section).toBe("columns");

    await app.press("<Tab>");
    expect(structure()!.section).toBe("indexes");
    await app.press("<Tab>");
    expect(structure()!.section).toBe("constraints");
    await app.press("<Tab>");
    expect(structure()!.section).toBe("definition");
    await app.press("<Tab>");
    expect(structure()!.section).toBe("columns");

    await app.press("<S-Tab>");
    expect(structure()!.section).toBe("definition");
    await app.press("<S-Tab>");
    expect(structure()!.section).toBe("constraints");
  });

  test("Tab switches sections instead of cycling the Result view", async () => {
    await start();
    await run(people);
    app.api.results.inspect(mainRef("orders"));
    await waitReady();
    await app.press("<Tab>");
    expect(structure()!.section).toBe("indexes");
    expect(app.api.results.view()).toBe("table");
  });

  test("the grid cursor scrolls past the viewport with G, gg and moves with vim keys", async () => {
    const columns = Array.from({ length: 30 }, (_, i) => ({
      name: `col_${String(i + 1).padStart(2, "0")}`,
      type: "text",
      nullable: true,
      references: [],
      ...(i === 0 ? { primaryKeyPosition: 1 } : {}),
    }));
    const details = ordersDetails({ name: "wide", columns });
    const schema = schemaWith([{ name: "wide", kind: "table", columns: [] }]);
    const driver = lookupDriver(schema, () => details);
    await start({ connection: "postgres://localhost/dev", deps: { openSession: driver.openSession } });
    app.api.results.inspect({ namespace: "main", name: "wide" });
    await waitReady();

    const selection = app.api.theme.color("selection").toInts();
    expect(spanWith(app.spans(), "col_01")!.bg.toInts()).toEqual(selection);

    await app.press("G");
    expect(app.frame()).toContain("col_30");
    expect(spanWith(app.spans(), "col_30")!.bg.toInts()).toEqual(selection);
    expect(app.frame()).not.toContain("col_01");

    await app.press("gg");
    expect(spanWith(app.spans(), "col_01")!.bg.toInts()).toEqual(selection);

    await app.press("j");
    expect(spanWith(app.spans(), "col_02")!.bg.toInts()).toEqual(selection);
    await app.press("k");
    expect(spanWith(app.spans(), "col_01")!.bg.toInts()).toEqual(selection);

    await app.press("$");
    expect(spanWith(app.spans(), "PK")!.bg.toInts()).toEqual(selection);
    await app.press("0");
    expect(spanWith(app.spans(), "col_01")!.bg.toInts()).toEqual(selection);

    await app.press("<C-d>");
    expect(spanWith(app.spans(), "col_01")?.bg.toInts()).not.toEqual(selection);
    await app.press("<C-u>");
    expect(spanWith(app.spans(), "col_01")!.bg.toInts()).toEqual(selection);
  });

  test("Enter toggles the full-value detail bar for the selected cell", async () => {
    const full = `DEFAULT_${"x".repeat(50)}`;
    const details = ordersDetails({
      name: "defaulted",
      columns: [{ name: "token", type: "text", nullable: true, defaultValue: full, references: [] }],
    });
    const schema = schemaWith([{ name: "defaulted", kind: "table", columns: [] }]);
    const driver = lookupDriver(schema, () => details);
    await start({ connection: "postgres://localhost/dev", deps: { openSession: driver.openSession } });
    app.api.results.inspect({ namespace: "main", name: "defaulted" });
    await waitReady();

    expect(app.frame()).not.toContain(full);
    await app.press("<CR>");
    expect(app.frame()).toContain(full);
    await app.press("<CR>");
    expect(app.frame()).not.toContain(full);
  });

  test("y yanks the selected cell value", async () => {
    await start();
    app.api.results.inspect(mainRef("orders"));
    await waitReady();
    await app.press("y");
    expect(copiedText()).toBe("id");
  });

  test("y in the Definition section yanks the whole definition", async () => {
    const definition = "CREATE TABLE defined_table (\n  a integer\n)";
    const details = ordersDetails({ name: "defined_table", definition });
    const schema = schemaWith([{ name: "defined_table", kind: "table", columns: [] }]);
    const driver = lookupDriver(schema, () => details);
    await start({ connection: "postgres://localhost/dev", deps: { openSession: driver.openSession } });
    app.api.results.inspect({ namespace: "main", name: "defined_table" });
    await waitReady();
    await app.press("4");
    expect(app.frame()).toContain("CREATE TABLE defined_table");
    await app.press("y");
    expect(copiedText()).toBe(definition);
  });

  test("R reloads the Structure", async () => {
    const driver = lookupDriver(ordersSchema, () => ordersDetails());
    await start({ connection: "postgres://localhost/dev", deps: { openSession: driver.openSession } });
    app.api.results.inspect(mainRef("orders"));
    await waitReady();
    const before = driver.calls.length;
    expect(before).toBeGreaterThanOrEqual(1);
    await app.press("R");
    await app.waitFor(() => driver.calls.length > before);
    await waitReady();
    expect(app.frame()).toContain("customer_id");
  });

  test("c opens the shared Relation picker and switches the target", async () => {
    await start();
    app.api.results.inspect(mainRef("orders"));
    await waitReady();
    await app.press("c");
    expect(app.api.dialog.depth()).toBe(1);
    await app.press("products");
    await app.press("<CR>");
    await waitReady();
    expect(structure()!.ref).toEqual(mainRef("products"));
    expect(app.api.dialog.depth()).toBe(0);
  });

  test("q and Escape restore the prior Result view, focus and the same shown outcome", async () => {
    await start();
    await run(people);
    await app.press("<Tab>");
    expect(app.api.results.view()).toBe("json");
    const shown = app.api.session.shown();

    app.api.results.inspect(mainRef("orders"));
    await waitReady();
    await app.press("q");
    expect(structure()).toBeNull();
    expect(app.api.results.view()).toBe("json");
    expect(app.api.focus.pane()).toBe("results");
    expect(app.api.session.shown()).toBe(shown);

    app.api.results.inspect(mainRef("orders"));
    await waitReady();
    await app.press("<Esc>");
    expect(structure()).toBeNull();
    expect(app.api.results.view()).toBe("json");
    expect(app.api.session.shown()).toBe(shown);
  });

  test("q restores the Pane that was focused before Structure", async () => {
    await start();
    app.api.focus.focus("schema");
    await app.settle();
    await app.press("j");
    await app.press("S");
    await waitReady();
    expect(app.api.focus.pane()).toBe("results");
    await app.press("q");
    expect(structure()).toBeNull();
    expect(app.api.focus.pane()).toBe("schema");
  });

  test("the explicit view Commands exit Structure into Table, JSON and Record", async () => {
    await start();
    await run(people);

    app.api.results.inspect(mainRef("orders"));
    await waitReady();
    await app.press("<Space>vt");
    expect(structure()).toBeNull();
    expect(app.api.results.view()).toBe("table");

    app.api.results.inspect(mainRef("orders"));
    await waitReady();
    await app.press("<Space>vj");
    expect(structure()).toBeNull();
    expect(app.api.results.view()).toBe("json");

    app.api.results.inspect(mainRef("orders"));
    await waitReady();
    await app.press("<Space>vr");
    expect(structure()).toBeNull();
    expect(app.api.results.view()).toBe("record");
  });
});

describe("async safety on Structure loads", () => {
  test("a target switch aborts the old load and ignores its late completion", async () => {
    const driver = pendingDriver(ordersSchema);
    await start({ connection: "postgres://localhost/dev", deps: { openSession: driver.openSession } });

    app.api.results.inspect(mainRef("orders"));
    await app.settle();
    expect(driver.calls.length).toBe(1);
    expect(structure()!.status).toBe("loading");

    app.api.results.inspect(mainRef("products"));
    await app.settle();
    expect(driver.calls.length).toBe(2);
    expect(driver.calls[0]!.signal?.aborted).toBe(true);

    driver.calls[0]!.resolve(ordersDetails());
    await app.settle();
    expect(structure()!.ref).toEqual(mainRef("products"));
    expect(structure()!.status).toBe("loading");
    expect(structure()!.details).toBeNull();

    driver.calls[1]!.resolve(ordersDetails({ name: "products" }));
    await waitReady();
    expect(structure()!.details!.name).toBe("products");
  });

  test("q aborts the load and ignores its late completion", async () => {
    const driver = pendingDriver(ordersSchema);
    await start({ connection: "postgres://localhost/dev", deps: { openSession: driver.openSession } });

    app.api.results.inspect(mainRef("orders"));
    await app.settle();
    expect(driver.calls.length).toBe(1);

    await app.press("q");
    expect(structure()).toBeNull();
    expect(driver.calls[0]!.signal?.aborted).toBe(true);

    driver.calls[0]!.resolve(ordersDetails());
    await app.settle();
    expect(structure()).toBeNull();
    expect(app.frame()).not.toContain("customer_id");
  });

  test("a Session replacement aborts the load and ignores its late completion", async () => {
    const driver = pendingDriver(ordersSchema);
    await start({ connection: "postgres://localhost/dev", deps: { openSession: driver.openSession } });

    app.api.results.inspect(mainRef("orders"));
    await app.settle();
    expect(driver.calls.length).toBe(1);
    const before = app.api.session.sessionId();

    await app.api.session.connect(":memory:");
    await app.waitFor(() => app.api.session.sessionId() !== before);
    expect(driver.calls[0]!.signal?.aborted).toBe(true);

    driver.calls[0]!.resolve(ordersDetails());
    await app.settle();
    expect(structure()?.details?.name ?? null).not.toBe("orders");
    expect(app.frame()).not.toContain("customer_id");
  });

  test("a committed refresh re-fetches the Relation and keeps the active section", async () => {
    const driver = lookupDriver(ordersSchema, () => ordersDetails());
    await start({ connection: "postgres://localhost/dev", deps: { openSession: driver.openSession } });
    app.api.results.inspect(mainRef("orders"));
    await waitReady();
    await app.press("2");
    expect(structure()!.section).toBe("indexes");

    const before = driver.calls.length;
    await app.api.session.refreshSchema();
    await app.waitFor(() => driver.calls.length > before);
    await waitReady();
    expect(structure()!.section).toBe("indexes");
    expect(structure()!.ref).toEqual(mainRef("orders"));
  });

  test("a dropped Relation after a refresh reports it and offers the picker", async () => {
    let drop = false;
    const driver = lookupDriver(ordersSchema, () => (drop ? null : ordersDetails()));
    await start({ connection: "postgres://localhost/dev", deps: { openSession: driver.openSession } });
    app.api.results.inspect(mainRef("orders"));
    await waitReady();

    drop = true;
    await app.api.session.refreshSchema();
    await app.waitFor(() => structure()?.status === "missing");
    const frame = app.frame();
    expect(frame).toContain("Relation no longer exists");
    expect(frame).toContain("press c to pick another");
  });
});

describe("Drivers without describeRelation", () => {
  test("the snapshot columns are shown and Indexes and Constraints say they are unavailable", async () => {
    const snapshot: SchemaSnapshot = {
      dialect: "postgres",
      namespaces: [{
        name: "main",
        relations: [{
          name: "legacy",
          kind: "table",
          columns: [
            { name: "id", type: "integer", nullable: false, primaryKey: true },
            { name: "label", type: "text", nullable: true, primaryKey: false },
          ],
        }],
      }],
    };
    const openSession = async (connection: Connection): Promise<Driver> => ({
      connection,
      run: async (): Promise<Result> => ({
        columns: [{ name: "x", type: "text" }],
        rows: [["1"]],
        truncated: false,
        affected: null,
        command: "SELECT",
        durationMs: 1,
      }),
      schema: async () => snapshot,
      close: async () => {},
    });
    await start({ connection: "postgres://localhost/dev", deps: { openSession } });

    app.api.results.inspect(mainRef("legacy"));
    const state = await waitReady();
    expect(state.details!.columns.map((column) => column.name)).toEqual(["id", "label"]);
    expect(state.details!.indexes).toBeUndefined();
    expect(state.details!.constraints).toBeUndefined();
    expect(app.frame()).toContain("label");

    await app.press("2");
    expect(app.frame()).toMatch(/unavailable/i);
    await app.press("3");
    expect(app.frame()).toMatch(/unavailable/i);
    expect(app.frame()).not.toContain("Definition");
  });

  test("a confirmed empty Indexes list is not shown as unavailable", async () => {
    await start();
    app.api.results.inspect(mainRef("orders"));
    await waitReady();
    expect(structure()!.details!.indexes).toEqual([]);
    await app.press("2");
    expect(app.frame()).not.toMatch(/unavailable/i);
  });
});

describe("Structure bounds across reloads, resizes and long values", () => {
  const threeColumns = (name: string) => [
    { name: "id", type: "integer", nullable: false, primaryKeyPosition: 1, references: [] },
    { name: "middle_col", type: "text", nullable: true, references: [] },
    { name: name, type: "text", nullable: true, references: [] },
  ];

  test("a shrinking reload clamps the grid cursor, keeps the highlight and status and y copies the clamped row", async () => {
    let shrunk = false;
    const details = () =>
      shrunk
        ? ordersDetails({ columns: [{ name: "only_col", type: "integer", nullable: false, references: [] }] })
        : ordersDetails({ columns: threeColumns("last_col") });
    const driver = lookupDriver(ordersSchema, () => details());
    await start({ connection: "postgres://localhost/dev", deps: { openSession: driver.openSession } });
    app.api.results.inspect(mainRef("orders"));
    await waitReady();

    await app.press("G");
    expect(app.api.status.current().position).toBe("3:1");

    shrunk = true;
    const before = driver.calls.length;
    await app.press("R");
    await app.waitFor(() => driver.calls.length > before);
    await waitReady();
    await app.settle();

    const selection = app.api.theme.color("selection").toInts();
    expect(spanWith(app.spans(), "only_col")!.bg.toInts()).toEqual(selection);
    expect(app.api.status.current().position).toBe("1:1");
    await app.press("y");
    await app.waitFor(() => copiedText() === "only_col");
    expect(copiedText()).toBe("only_col");
  });

  test("a shrinking committed refresh clamps the cursor and the open detail follows the clamped row", async () => {
    let shrunk = false;
    const driver = lookupDriver(ordersSchema, () =>
      ordersDetails({ columns: shrunk ? threeColumns("tail_col").slice(0, 2) : threeColumns("tail_col") }),
    );
    await start({ connection: "postgres://localhost/dev", deps: { openSession: driver.openSession } });
    app.api.results.inspect(mainRef("orders"));
    await waitReady();
    await app.press("G<CR>");
    expect(app.frame()).toContain("Column: tail_col");

    shrunk = true;
    const before = driver.calls.length;
    await app.api.session.refreshSchema();
    await app.waitFor(() => driver.calls.length > before);
    await waitReady();
    await app.settle();
    expect(app.api.status.current().position).toBe("2:1");
    expect(app.frame()).toContain("Column: middle_col");
  });

  const longColumns = Array.from({ length: 300 }, (_, i) => `col_${String(i + 1).padStart(3, "0")} integer`);
  const longDefinition = `CREATE TABLE long_def (${longColumns.join(", ")}, final_marker_col text)`;
  const visibleCols = () =>
    [...app.frame().matchAll(/col_(\d{3})/g)].map((match) => Number(match[1]));

  async function openDefinition(definition: () => string) {
    const schema = schemaWith([{ name: "long_def", kind: "table", columns: [] }]);
    const driver = lookupDriver(schema, () => ordersDetails({ name: "long_def", definition: definition() }));
    await start({ connection: "postgres://localhost/dev", deps: { openSession: driver.openSession } });
    app.api.results.inspect({ namespace: "main", name: "long_def" });
    await waitReady();
    await app.press("4");
    expect(structure()!.section).toBe("definition");
    return driver;
  }

  test("a long single-line definition wraps and scrolls with j, G and gg to its closing token", async () => {
    await openDefinition(() => longDefinition);
    expect(app.frame()).toContain("CREATE TABLE long_def");
    expect(app.frame()).not.toContain("final_marker_col");

    await app.press("j");
    expect(app.frame()).not.toContain("CREATE TABLE long_def");

    await app.press("G");
    expect(app.frame()).toContain("final_marker_col");
    expect(app.frame()).not.toContain("CREATE TABLE long_def");

    await app.press("gg");
    expect(app.frame()).toContain("CREATE TABLE long_def");
  });

  test("a definition split by bare carriage returns scrolls to its last line", async () => {
    const definition = Array.from({ length: 80 }, (_, i) => `line_${String(i + 1).padStart(3, "0")}`).join("\r");
    await openDefinition(() => definition);
    expect(app.frame()).toContain("line_001");
    expect(app.frame()).not.toContain("line_080");
    await app.press("G");
    expect(app.frame()).toContain("line_080");
    expect(app.frame()).not.toContain("line_001");
  });

  test("the definition scroll is clamped when a reload shortens it", async () => {
    let short = false;
    const driver = await openDefinition(() =>
      short ? "CREATE TABLE long_def (short_marker integer)" : longDefinition,
    );
    await app.press("G");
    expect(app.frame()).toContain("final_marker_col");

    short = true;
    const before = driver.calls.length;
    await app.press("R");
    await app.waitFor(() => driver.calls.length > before);
    await waitReady();
    await app.settle();
    expect(app.frame()).toContain("short_marker");
    await app.press("k");
    expect(app.frame()).toContain("short_marker");
  });

  test("the definition scroll is clamped when the viewport grows taller", async () => {
    await openDefinition(() => longDefinition);
    await app.press("G");
    expect(app.frame()).toContain("final_marker_col");
    const firstBefore = Math.min(...visibleCols());

    await app.resize(120, 60);
    await app.settle();
    expect(app.frame()).toContain("final_marker_col");
    expect(Math.min(...visibleCols())).toBeLessThan(firstBefore);

    // Clamped at the end: one k shows exactly one earlier row instead of doing nothing visible.
    const firstAtEnd = Math.min(...visibleCols());
    await app.press("k");
    expect(Math.min(...visibleCols())).toBeLessThan(firstAtEnd);
  });

  test("Enter on a long CHECK clips the detail and j, G and gg scroll it to the end of the expression", async () => {
    const states = Array.from({ length: 80 }, (_, i) => `'state_${String(i + 1).padStart(3, "0")}'`);
    const check = `CHECK (status IN (${states.join(", ")}))`;
    const details = ordersDetails({
      name: "checked",
      constraints: [{ name: "status_check", kind: "CHECK", columns: ["status"], definition: check }],
    });
    const schema = schemaWith([{ name: "checked", kind: "table", columns: [] }]);
    const driver = lookupDriver(schema, () => details);
    await start({ connection: "postgres://localhost/dev", deps: { openSession: driver.openSession } });
    app.api.results.inspect({ namespace: "main", name: "checked" });
    await waitReady();
    await app.press("3");
    expect(structure()!.section).toBe("constraints");

    await app.press("<CR>");
    expect(app.frame()).toContain("Name: status_check");
    expect(app.frame()).not.toContain("state_080");
    expect(app.frame()).toMatch(/detail 1–\d+\/\d+ · j\/k scroll · esc close/);

    await app.press("j");
    expect(app.frame()).not.toContain("Name: status_check");
    expect(app.frame()).toMatch(/detail 2–/);

    await app.press("G");
    expect(app.frame()).toContain("state_080'))");
    const match = app.frame().match(/detail \d+–(\d+)\/(\d+)/)!;
    expect(match[1]).toBe(match[2]);

    await app.press("gg");
    expect(app.frame()).toContain("Name: status_check");

    await app.press("<Esc>");
    expect(app.frame()).not.toContain("j/k scroll");
    expect(structure()).not.toBeNull();
  });

  test("at 80x24 a long CHECK detail keeps its scroll hint visible and G reaches the end", async () => {
    const states = Array.from({ length: 80 }, (_, i) => `'state_${String(i + 1).padStart(3, "0")}'`);
    const check = `CHECK (status IN (${states.join(", ")}))`;
    const details = ordersDetails({
      name: "checked",
      constraints: [{ name: "status_check", kind: "CHECK", columns: ["status"], definition: check }],
    });
    const schema = schemaWith([{ name: "checked", kind: "table", columns: [] }]);
    const driver = lookupDriver(schema, () => details);
    await start({ width: 80, height: 24, connection: "postgres://localhost/dev", deps: { openSession: driver.openSession } });
    app.api.results.inspect({ namespace: "main", name: "checked" });
    await waitReady();
    await app.press("3");
    expect(structure()!.section).toBe("constraints");

    await app.press("<CR>");
    expect(app.frame()).toContain("Name: status_check");
    expect(app.frame()).toMatch(/detail 1–\d+\/\d+ · j\/k scroll · esc close/);

    await app.press("G");
    expect(app.frame()).toContain("state_080'))");
    expect(app.frame()).toMatch(/detail \d+–\d+\/\d+ · j\/k scroll/);
    const match = app.frame().match(/detail \d+–(\d+)\/(\d+)/)!;
    expect(match[1]).toBe(match[2]);
  });

  test("at 80x24 every field of a Columns row detail is reachable, Key included", async () => {
    const driver = lookupDriver(ordersSchema, () => ordersDetails());
    await start({ width: 80, height: 24, connection: "postgres://localhost/dev", deps: { openSession: driver.openSession } });
    app.api.results.inspect(mainRef("orders"));
    await waitReady();

    await app.press("<CR>");
    expect(app.frame()).toContain("Column: id");
    await app.press("G");
    expect(app.frame()).toContain("Key: PK");
    const seen = new Set<string>();
    await app.press("gg");
    for (let i = 0; i < 6; i++) {
      for (const label of ["Column:", "Type:", "Null:", "Default:", "Key:"]) {
        if (app.frame().includes(label)) seen.add(label);
      }
      await app.press("j");
    }
    expect([...seen].sort()).toEqual(["Column:", "Default:", "Key:", "Null:", "Type:"]);
  });
});

describe("wrapRanges", () => {
  function check(text: string, width: number) {
    const rows = wrapRanges(text, width);
    for (const row of rows) expect(cellWidth(text.slice(row.start, row.end))).toBeLessThanOrEqual(width);
    expect(rows.map((row) => text.slice(row.start, row.end)).join("")).toBe(text);
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.start).toBe(rows[i - 1]!.end);
  }

  test("a wide grapheme after a space break never overflows the width", () => {
    check(" abc字", 4);
  });

  test("rows stay within the width for wide graphemes after a break, across widths", () => {
    for (let w = 4; w <= 20; w++) {
      check("a " + "b".repeat(w - 2) + "漢", w);
      check("a " + "b".repeat(w - 2) + "🚀", w);
      check(" " + "b".repeat(w - 1) + "漢", w);
      check(" " + "b".repeat(w - 1) + "🚀", w);
    }
  });
});
