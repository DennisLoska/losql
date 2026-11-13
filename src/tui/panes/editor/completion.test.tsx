import { afterEach, describe, expect, test } from "bun:test";
import { mount, spanWith, type MountOptions, type TestApp } from "../../testing";
import { placePopup } from "./Completion";
import { placePopupInBox } from "./Completion";

let app: TestApp;
afterEach(async () => { await app?.dispose(); });

async function start(text = "", options: MountOptions = {}) {
  app = await mount(options);
  await app.waitFor(() => app.api.session.schema() !== null);
  app.api.editor.setText(text);
  await app.settle();
}
const completion = () => app.api.editor.completion();
const labels = () => completion()?.items.map((i) => i.label) ?? null;

describe("completion", () => {
  test("ctrl+n in insert mode offers Relations for the word before the cursor", async () => {
    await start();
    await app.press("iselect * from cu<C-n>");
    expect(labels()![0]).toBe("customers");
    expect(completion()!.selected).toBe(0);
    expect(app.frame()).toContain("customers");
    expect(app.frame()).toContain("table");
    expect(app.api.editor.mode()).toBe("insert");
  });

  test("Enter accepts and stays in insert mode", async () => {
    await start();
    await app.press("iselect * from cu<C-n><CR>");
    expect(app.api.editor.text()).toBe("select * from customers");
    expect(completion()).toBeNull();
    expect(app.api.editor.mode()).toBe("insert");
    await app.press(" c");
    expect(app.api.editor.text()).toBe("select * from customers c");
  });

  test("Tab accepts too", async () => {
    await start();
    await app.press("ise<C-n><Tab>");
    expect(app.api.editor.text()).toBe("select");
  });

  test("ctrl+n and ctrl+p move through the items and wrap", async () => {
    await start();
    await app.press("iselect * from o<C-n>");
    const items = labels()!;
    expect(items.slice(0, 2)).toEqual(["order_items", "orders"]);
    await app.press("<C-n>");
    expect(completion()!.selected).toBe(1);
    await app.press("<C-p><C-p>");
    expect(completion()!.selected).toBe(items.length - 1);
    await app.press("<C-n><C-n><CR>");
    expect(app.api.editor.text()).toBe("select * from orders");
  });

  test("ctrl+p opens it as well, on the last item", async () => {
    await start();
    await app.press("iselect * from o<C-p>");
    expect(completion()!.selected).toBe(labels()!.length - 1);
    expect(app.api.dialog.depth()).toBe(0);
  });

  test("typing narrows the list and Backspace widens it", async () => {
    await start();
    await app.press("iselect * from o<C-n>");
    const before = labels()!.length;
    await app.press("rders");
    expect(labels()).toEqual(["orders"]);
    await app.press("<BS><BS><BS><BS><BS>");
    expect(labels()!.length).toBe(before);
    await app.press("<BS>");
    expect(completion()).toBeNull();
  });

  test("Escape closes the popup first and leaves insert mode second", async () => {
    await start();
    await app.press("iselect * from cu<C-n><Esc>");
    expect(completion()).toBeNull();
    expect(app.api.editor.mode()).toBe("insert");
    expect(app.api.editor.text()).toBe("select * from cu");
    await app.press("<Esc>");
    expect(app.api.editor.mode()).toBe("normal");
  });

  test("columns are offered after an alias and a dot", async () => {
    await start("select c. from customers c");
    await app.press("f.a<C-n>");
    expect(labels()).toEqual(["id", "name", "email", "country", "created_at"]);
    await app.press("<C-n><CR>");
    expect(app.api.editor.text()).toBe("select c.name from customers c");
  });

  test("with nothing to offer it says so", async () => {
    await start();
    await app.press("i<C-n>");
    expect(completion()).toBeNull();
    expect(app.api.status.message()).toEqual({ text: "No completions", kind: "info" });
    await app.press("zzzqqq<C-n>");
    expect(completion()).toBeNull();
  });

  test("an accepted completion is part of the insert session for undo", async () => {
    await start("x");
    await app.press("A from cu<C-n><CR><Esc>u");
    expect(app.api.editor.text()).toBe("x");
  });

  test("ctrl+p in normal mode still opens the palette", async () => {
    await start("select 1");
    await app.press("<C-p>");
    expect(completion()).toBeNull();
    expect(app.frame()).toContain("Commands");
  });

  test("the popup closes when the Pane loses focus or the Buffer changes", async () => {
    await start();
    await app.press("iselect * from cu<C-n>");
    app.api.focus.focus("results");
    await app.settle();
    expect(completion()).toBeNull();
  });

  test("the popup is opaque when the theme is Transparent", async () => {
    await start("", { config: { transparent: true } });
    await app.press("iselect * from cu<C-n>");
    expect(spanWith(app.spans(), "table")!.bg.toInts()[3]).toBe(255);
  });

  test("aligns the popup and accepts cleanly when an emoji precedes the word on the line", async () => {
    await start("/* 🚀 */ select * from cu");
    await app.press("A<C-n>");
    expect(labels()![0]).toBe("customers");
    const lines = app.frame().split("\n");
    const editorLine = lines[1]!;
    const popupLine = lines[2]!;
    const wordStartCell = Bun.stringWidth(editorLine.slice(0, editorLine.indexOf("cu")));
    const labelCell = Bun.stringWidth(popupLine.slice(0, popupLine.lastIndexOf("customers")));
    // CompletionPopup has 1 leading space padding before the label, so the box starts under "cu"
    expect(labelCell - 1).toBe(wordStartCell);

    await app.press("<CR><Esc>");
    expect(app.api.editor.text()).toBe("/* 🚀 */ select * from customers");
    await app.press("u");
    expect(app.api.editor.text()).toBe("/* 🚀 */ select * from cu");
  });

  test("moves above the cursor when at the bottom of the Pane and clamps within a narrow terminal", async () => {
    await start("select * from o\n".repeat(18) + "select * from cu", { width: 48, height: 14 });
    await app.press("GA<C-n>");
    expect(completion()).not.toBeNull();
    const frameLines = app.frame().split("\n");
    const cursorRow = frameLines.findIndex((l) => l.includes("select * from cu"));
    const popupRow = frameLines.findIndex((l) => l.includes("customers") && l.includes("table"));
    expect(cursorRow).toBeGreaterThan(0);
    expect(popupRow).toBeGreaterThanOrEqual(0);
    expect(popupRow).toBeLessThan(cursorRow);
  });

  test("recomputes or closes when the Schema snapshot refreshes and when Buffer text is replaced externally", async () => {
    await start();
    await app.press("iselect * from cu<C-n>");
    expect(completion()).not.toBeNull();
    app.api.editor.setText("select 1");
    await app.settle();
    expect(completion()).toBeNull();
  });

  test("sees the whole Statement under the cursor (~10,000 chars), ignores ; in strings/comments, and scopes aliases to the Statement under the cursor", async () => {
    const colLines = Array.from(
      { length: 145 },
      (_, i) => `  o.id, o.customer_id, o.total, o.status, o.placed_at /* col_${i} */`,
    ).join(",\n");
    const makeLongStmt = (selectLine: string) =>
      [
        selectLine,
        "  c.id",
        "from customers c",
        "join orders o on (",
        colLines,
        ") is not null",
        "where c.",
      ].join("\n");

    const stmt1 = makeLongStmt("select");
    expect(stmt1.length).toBeGreaterThan(9500);
    expect(stmt1.length).toBeLessThan(10500);
    expect(stmt1.indexOf("from customers c")).toBeGreaterThan(0);
    expect(stmt1.indexOf("from customers c")).toBeLessThan(200);

    // 1. First Statement, then ~10,000-char Statement with cursor at its end after `where c.`
    await start(`select 1;\n${stmt1}`);
    await app.press("GA<C-n>");
    expect(labels()).toEqual(["id", "name", "email", "country", "created_at"]);

    // 2. Same with `select 'a;b' /* ; */` at the start of that Statement
    const stmt2 = makeLongStmt("select 'a;b' /* ; */");
    expect(stmt2.indexOf("from customers c")).toBeLessThan(200);
    app.api.editor.setText(`select 1;\n${stmt2}`);
    await app.settle();
    await app.press("GA<C-n>");
    expect(labels()).toEqual(["id", "name", "email", "country", "created_at"]);

    // 3. Same Statement followed by another Statement that defines alias `c` for a different Relation (`orders`)
    app.api.editor.setText(`select 1;\n${stmt2};\nselect * from orders c;`);
    await app.settle();
    await app.press("Gk$i<C-n>");
    expect(labels()).toEqual(["id", "name", "email", "country", "created_at"]);
  });

  test("dot (.) repeats an insert session together with its accepted completion", async () => {
    await start("x\ny");
    await app.press("A, cu<C-n><CR><Esc>j.");
    expect(app.api.editor.text()).toBe("x, customers\ny, customers");
  });


  describe("names that need quotes", () => {
    const column = (name: string, type = "text") => ({ name, type, nullable: true, primaryKey: false });
    const quotingSchema = {
      dialect: "postgres" as const,
      namespaces: [
        {
          name: "public",
          relations: [
            { name: "user", kind: "table" as const, columns: [column("id", "int4"), column("case"), column("Created At")] },
            { name: "Order Items", kind: "table" as const, columns: [column("id", "int4"), column("Created At")] },
            { name: "Users", kind: "table" as const, columns: [column("id", "int4")] },
            { name: "customers", kind: "table" as const, columns: [column("id", "int4"), column("case"), column("Created At")] },
          ],
        },
        {
          name: "My Schema",
          relations: [{ name: "Order Items", kind: "table" as const, columns: [column("id", "int4")] }],
        },
      ],
    };
    const openSession = async (connection: any) => ({
      connection,
      run: async () => ({ columns: [], rows: [], truncated: false, affected: 0, command: "SELECT", durationMs: 1 }),
      schema: async () => quotingSchema,
      close: async () => {},
    });
    const startQuoting = (text = "") => start(text, { connection: "postgres://localhost/dev", deps: { openSession } });

    // Types `keys` in insert mode, opens the popup, moves to the item labelled `label` and accepts it.
    const accept = async (keys: string, label: string) => {
      await app.press(`${keys}<C-n>`);
      const index = labels()!.indexOf(label);
      expect(index).toBeGreaterThanOrEqual(0);
      await app.press("<C-n>".repeat(index) + "<CR><Esc>");
    };

    test("a Relation is written so that the database reads it as that name", async () => {
      await startQuoting();
      for (const [prefix, label, written] of [
        ["us", "user", 'select * from "user"'],
        ["Ord", "Order Items", 'select * from "Order Items"'],
        ["Use", "Users", 'select * from "Users"'],
        ["cust", "customers", "select * from customers"],
      ] as const) {
        app.api.editor.setText("");
        await accept(`iselect * from ${prefix}`, label);
        expect(app.api.editor.text()).toBe(written);
      }
    });

    test("a column is written so that the database reads it as that name, with and without a qualifier", async () => {
      await startQuoting();
      for (const [before, prefix, label, written] of [
        ["select ", "ca", "case", 'select "case" from customers'],
        ["select ", "i", "id", "select id from customers"],
        ["select ", "Cr", "Created At", 'select "Created At" from customers'],
        ["select o.", "ca", "case", 'select o."case" from customers o'],
        ["select o.", "i", "id", "select o.id from customers o"],
        ["select o.", "cr", "Created At", 'select o."Created At" from customers o'],
      ] as const) {
        const after = before === "select o." ? " from customers o" : " from customers";
        app.api.editor.setText(before + after);
        await app.settle();
        await accept(`${before === "select o." ? "0f.a" : "0f a"}${prefix}`, label);
        expect(app.api.editor.text()).toBe(written);
      }
      app.api.editor.setText('select * from "My Schema".');
      await app.settle();
      await accept("AOrd", "Order Items");
      expect(app.api.editor.text()).toBe('select * from "My Schema"."Order Items"');
    });

    test("inside a quote, with and without its closing quote, one pair of quotes is left around the name", async () => {
      await startQuoting();
      await accept('iselect * from "Ord', "Order Items");
      expect(app.api.editor.text()).toBe('select * from "Order Items"');

      app.api.editor.setText("");
      await accept('iselect * from "cu', "customers");
      expect(app.api.editor.text()).toBe('select * from "customers"');

      app.api.editor.setText('select * from ""');
      await app.settle();
      await accept("$iOrd", "Order Items");
      expect(app.api.editor.text()).toBe('select * from "Order Items"');

      app.api.editor.setText('select * from "" where id = 1');
      await app.settle();
      await accept('0f"aorder it', "Order Items");
      expect(app.api.editor.text()).toBe('select * from "Order Items" where id = 1');

      app.api.editor.setText('select o."" from customers o');
      await app.settle();
      await accept('0f"aCr', "Created At");
      expect(app.api.editor.text()).toBe('select o."Created At" from customers o');
    });

    test("typing on after accepting inside a closed quote continues after the closing quote", async () => {
      await startQuoting('select * from ""');
      await app.press("$iOrd<C-n><CR>");
      expect(app.api.editor.mode()).toBe("insert");
      await app.press(" x");
      expect(app.api.editor.text()).toBe('select * from "Order Items" x');
    });

    test("dot (.) repeats the quoted name that was inserted", async () => {
      await startQuoting("select * from \nselect * from ");
      await accept("ggAOrd", "Order Items");
      await app.press("j.");
      expect(app.api.editor.text()).toBe('select * from "Order Items"\nselect * from "Order Items"');

      app.api.editor.setText("select * from \nselect * from ");
      await app.settle();
      await accept('ggA"Ord', "Order Items");
      await app.press("j.");
      expect(app.api.editor.text()).toBe('select * from "Order Items"\nselect * from "Order Items"');

      // Accepted inside a closed quote, repeated inside another: one pair of quotes each time.
      app.api.editor.setText('select * from ""\nselect * from ""');
      await app.settle();
      await accept("gg$iOrd", "Order Items");
      await app.press("j$.");
      expect(app.api.editor.text()).toBe('select * from "Order Items"\nselect * from "Order Items"');
    });
  });

  const pgUrl = process.env.LOSQL_TEST_PG_URL;
  const pgTest = pgUrl ? test : test.skip;

  pgTest("on Postgres, each completed name in `select * from ` runs", async () => {
    const { openSession, parseConnection } = await import("../../../core/db/connection");
    const testSchema = `losql_f2_${Date.now().toString(36)}`;
    const sep = pgUrl!.includes("?") ? "&" : "?";
    const urlWithPath = `${pgUrl!}${sep}options=${encodeURIComponent(`-c search_path=${testSchema}`)}`;
    const setup = await openSession(parseConnection(urlWithPath));
    try {
      await setup.run(`create schema ${testSchema}`);
      await setup.run(`create table ${testSchema}."user" (id int primary key, "case" text, "Created At" text)`);
      await setup.run(`insert into ${testSchema}."user" values (1, 'c1', 'a')`);
      await setup.run(`create table ${testSchema}."Order Items" (id int primary key, "Created At" text)`);
      await setup.run(`insert into ${testSchema}."Order Items" values (2, 'b')`);
      await setup.run(`create table ${testSchema}."Users" (id int primary key)`);
      await setup.run(`insert into ${testSchema}."Users" values (3)`);
      await setup.run(`create table ${testSchema}.customers (id int primary key, "case" text, "Created At" text)`);
      await setup.run(`insert into ${testSchema}.customers values (4, 'c4', 'd')`);

      await start("", { connection: urlWithPath });
      await app.waitFor(() =>
        (app.api.session.schema()?.namespaces ?? []).some((ns) => ns.name === testSchema),
      );

      for (const [prefix, label, written, id] of [
        ["us", "user", 'select * from "user"', 1],
        ["Ord", "Order Items", 'select * from "Order Items"', 2],
        ["Use", "Users", 'select * from "Users"', 3],
        ["cust", "customers", "select * from customers", 4],
      ] as const) {
        app.api.editor.setText("select * from ");
        await app.settle();
        await app.press(`A${prefix}<C-n>`);
        const index = labels()!.indexOf(label);
        expect(index).toBeGreaterThanOrEqual(0);
        await app.press("<C-n>".repeat(index) + "<CR><Esc>");
        expect(app.api.editor.text()).toBe(written);
        await app.press("<CR>");
        await app.waitFor(() => app.api.session.shown()?.statement === written);
        const out = app.api.session.shown()!;
        expect(out.ok).toBe(true);
        if (out.ok) expect(String(out.result.rows[0]![0])).toBe(String(id));
      }
    } finally {
      await setup.run(`drop schema if exists ${testSchema} cascade`).catch(() => {});
      await setup.close();
    }
  });
});

describe("with the popup open, a key the popup does not own does what it does with the popup closed", () => {
  const observe = () => ({
    text: app.api.editor.text(),
    cursor: app.api.editor.cursor(),
    mode: app.api.editor.mode(),
    pane: app.api.focus.pane(),
    chord: app.api.keys.chord(),
    dialogs: app.api.dialog.depth(),
  });
  // From the same text and cursor, presses `key` with the popup closed or open and reports what follows.
  const after = async (key: string, popup: boolean) => {
    await start(" where id = 1");
    await app.press("iselect * from cu");
    if (popup) {
      await app.press("<C-n>");
      expect(completion()).not.toBeNull();
    }
    await app.press(key);
    return observe();
  };

  for (const key of ["<C-w>", "<C-h>", "<C-j>", "<C-k>", "<C-l>", "<C-u>", "<F1>", "<Left>", "<Right>", "<Home>", "<End>", "<BS>", "<Del>"]) {
    test(key, async () => {
      const closed = await after(key, false);
      await app.dispose();
      const open = await after(key, true);
      expect(open).toEqual(closed);
    });
  }

  test("the key after <C-w> is not swallowed", async () => {
    await start();
    await app.press("iselect * from cu<C-n><C-w>x");
    expect(app.api.editor.text()).toBe("select * from x");
    expect(app.api.keys.chord()).toBe("");
    expect(app.api.focus.pane()).toBe("editor");
    expect(app.api.editor.mode()).toBe("insert");
  });
});

describe("`.` after an accepted completion never deletes text that was not typed in the repeated insert", () => {
  test("A<C-n><CR><Esc>j. on a word typed before the insert", async () => {
    await start("from cu\nfrom y\nz");
    await app.press("A<C-n>");
    expect(labels()![0]).toBe("customers");
    await app.press("<CR><Esc>j.");
    expect(app.api.editor.text()).toBe("from customers\nfrom ystomers\nz");
    await app.press("u");
    expect(app.api.editor.text()).toBe("from customers\nfrom y\nz");
    await app.press("u");
    expect(app.api.editor.text()).toBe("from cu\nfrom y\nz");
  });

  test("with a name that needs quotes, begun before the insert", async () => {
    const schema = {
      dialect: "postgres" as const,
      namespaces: [
        {
          name: "public",
          relations: [
            { name: "Order Items", kind: "table" as const, columns: [{ name: "id", type: "int4", nullable: false, primaryKey: true }] },
          ],
        },
      ],
    };
    const openSession = async (connection: any) => ({
      connection,
      run: async () => ({ columns: [], rows: [], truncated: false, affected: 0, command: "SELECT", durationMs: 1 }),
      schema: async () => schema,
      close: async () => {},
    });
    await start('select * from "Or\nselect * from "Ab', { connection: "postgres://localhost/dev", deps: { openSession } });
    await app.press("ggAd<C-n>");
    expect(labels()).toEqual(["Order Items"]);
    await app.press("<CR><Esc>");
    expect(app.api.editor.text()).toBe('select * from "Order Items"\nselect * from "Ab');
    // The insert typed `d` after `"Or`: `.` writes `d`, deletes it again and writes the rest of the
    // name; `"Ab`, which the insert did not type, stays.
    await app.press("j.");
    expect(app.api.editor.text()).toBe('select * from "Order Items"\nselect * from "Abder Items"');
    await app.press("u");
    expect(app.api.editor.text()).toBe('select * from "Order Items"\nselect * from "Ab');
  });
});

describe("where the offered words come from", () => {
  // A word of another Statement, then filler, then the Statement being typed.
  const buffer = (length: number) => {
    const head = "select zebrafield from t;\n-- ";
    const tail = "\nselect * from zeb";
    const text = head + "x".repeat(length - head.length - tail.length) + tail;
    expect(text.length).toBe(length);
    return text;
  };

  test("a word of another Statement is offered in a Buffer of 4,000 characters", async () => {
    await start(buffer(4000));
    await app.press("GA<C-n>");
    expect(labels()).toContain("zebrafield");
  });

  test("and not in a Buffer of 5,000 characters, where words come from the Statement under the cursor", async () => {
    await start(buffer(5000));
    await app.press("GA<C-n>");
    expect(labels() ?? []).not.toContain("zebrafield");
    app.api.editor.setText(buffer(5000).replace("\nselect * from zeb", "\nselect * from zebrafield where zeb"));
    await app.settle();
    await app.press("GA<C-n>");
    expect(labels()).toContain("zebrafield");
  });
});

describe("the popup never covers the line being typed", () => {
  // Checks one placement against the rule; returns the first item shown.
  const check = (
    terminal: { width: number; height: number },
    cursorRow: number,
    anchorCol: number,
    itemCount: number,
    selected: number,
    previousFirst: number,
    width = 24,
    area = { top: 0, bottom: terminal.height, left: 0, right: terminal.width },
  ): number => {
    const p = placePopup({ cursorRow, anchorCol, itemCount, selected, previousFirst, width, terminal, area });
    const freeAbove = cursorRow;
    const freeBelow = terminal.height - cursorRow - 1;
    if (freeAbove === 0 && freeBelow === 0) {
      expect(p).toBeNull();
      return 0;
    }
    if (p === null) throw new Error(`no popup: ${JSON.stringify({ terminal, cursorRow, itemCount })}`);
    const ok =
      p.rows >= 1 &&
      p.rows <= Math.min(8, itemCount) &&
      (p.top + p.rows <= cursorRow || p.top > cursorRow) &&
      p.top >= 0 &&
      p.top + p.rows <= terminal.height &&
      p.left >= 0 &&
      p.width >= 1 &&
      p.left + p.width <= terminal.width &&
      p.first >= 0 &&
      p.first + p.rows <= itemCount &&
      selected >= p.first &&
      selected < p.first + p.rows &&
      // the whole popup where it fits; else as many rows as fit on the larger free side
      p.rows === Math.min(Math.min(8, itemCount), Math.max(freeAbove, freeBelow));
    if (!ok) {
      throw new Error(`bad placement ${JSON.stringify(p)} for ${JSON.stringify({ terminal, cursorRow, anchorCol, itemCount, selected })}`);
    }
    return p.first;
  };

  test("for terminals from 20 by 4 to 140 by 40, every cursor row, 1 to 60 items, the selection moving down and up", () => {
    for (const width of [20, 47, 140]) {
      for (let height = 4; height <= 40; height++) {
        const terminal = { width, height };
        for (let row = 0; row < height; row++) {
          for (let items = 1; items <= 60; items++) {
            let first = 0;
            for (let sel = 0; sel < items; sel++) first = check(terminal, row, width - 3, items, sel, first);
            for (let sel = items - 1; sel >= 0; sel--) first = check(terminal, row, 0, items, sel, first);
          }
        }
      }
    }
  });

  test("for terminals from 20 to 140 columns, every cursor column, and a popup wider than the terminal", () => {
    for (let width = 20; width <= 140; width++) {
      for (const height of [4, 8, 40]) {
        const terminal = { width, height };
        for (let col = 0; col < width; col++) {
          for (const row of [0, 1, height - 1]) {
            for (const items of [1, 8, 60]) {
              check(terminal, row, col, items, items - 1, 0);
              check(terminal, row, col, items, 0, 0, 60);
              check(terminal, row, col, items, 0, 0, 200, { top: 1, bottom: height - 1, left: 2, right: width - 2 });
            }
          }
        }
      }
    }
  });

  test("a 20 by 8 terminal with 30 items: the popup lies on the larger free side of the cursor's row", () => {
    const terminal = { width: 20, height: 8 };
    const area = { top: 0, bottom: 8, left: 0, right: 20 };
    const at = (cursorRow: number) =>
      placePopup({ cursorRow, anchorCol: 0, itemCount: 30, selected: 0, previousFirst: 0, width: 24, terminal, area })!;
    expect(at(0)).toMatchObject({ top: 1, rows: 7 });
    expect(at(3)).toMatchObject({ top: 4, rows: 4 });
    expect(at(4)).toMatchObject({ top: 0, rows: 4 });
    expect(at(7)).toMatchObject({ top: 0, rows: 7 });
  });

  test("where neither side has a free row, no popup is placed", () => {
    const p = placePopup({
      cursorRow: 0, anchorCol: 0, itemCount: 5, selected: 0, previousFirst: 0, width: 24,
      terminal: { width: 40, height: 1 }, area: { top: 0, bottom: 1, left: 0, right: 40 },
    });
    expect(p).toBeNull();
  });

  test("in the Pane, a 20 by 8 terminal: the line being typed stays visible", async () => {
    await start("", { width: 20, height: 8 });
    await app.press("is<C-n>");
    expect(labels()!.length).toBeGreaterThan(8);
    const lines = app.frame().split("\n");
    const typed = lines.findIndex((l) => /^\s*1 s\s*$/.test(l));
    expect(typed).toBeGreaterThanOrEqual(0);
    const popupRow = lines.findIndex((l) => l.includes(labels()![0]!));
    expect(popupRow).toBe(typed + 1);
  });
});

describe("pasted text with Windows line ends lands where the engine thinks it does", () => {
  test("12, li, a paste of a CRLF b, then X", async () => {
    await start("12");
    await app.press("li");
    app.api.keys.paste("a\r\nb");
    await app.settle();
    expect(app.api.editor.text()).toBe("1a\nb2");
    expect(app.api.editor.cursor()).toEqual({ row: 1, col: 1 });
    await app.press("X");
    expect(app.api.editor.text()).toBe("1a\nbX2");
  });

  test("three CRLF lines and a lone CR pasted in the middle of a line, then typing, then u", async () => {
    await start("abcdef");
    await app.press("3li");
    app.api.keys.paste("one\r\ntwo\r\nthree\r\nfour\rfive");
    await app.settle();
    expect(app.api.editor.text()).toBe("abcone\ntwo\nthree\nfour\nfivedef");
    expect(app.api.editor.cursor()).toEqual({ row: 4, col: 4 });
    await app.press("XY");
    expect(app.api.editor.text()).toBe("abcone\ntwo\nthree\nfour\nfiveXYdef");
    expect(app.api.editor.cursor()).toEqual({ row: 4, col: 6 });
    await app.press("<Esc>u");
    expect(app.api.editor.text()).toBe("abcdef");
  });

  test("in normal mode as well", async () => {
    await start("12");
    app.api.keys.paste("a\r\nb");
    await app.settle();
    expect(app.api.editor.text()).toBe("1a\nb2");
    await app.press("u");
    expect(app.api.editor.text()).toBe("12");
  });
});

describe("the popup's rows stay inside the Editor Pane's box", () => {
  // The row of the frame where the selected item's label is drawn highlighted, or -1.
  const selectedRow = (): number => {
    const c = completion()!;
    const label = c.items[c.selected]!.label;
    const selection = app.api.theme.color("selection").toInts();
    const lines = app.spans().lines;
    for (let row = 0; row < lines.length; row++) {
      for (const span of lines[row]!.spans) {
        if (!span.text.startsWith(` ${label}`)) continue;
        const after = span.text.slice(label.length + 1);
        if (after !== "" && !/^\s/.test(after)) continue;
        if (JSON.stringify(span.bg.toInts()) === JSON.stringify(selection)) return row;
      }
    }
    return -1;
  };
  const resultsHeaderRow = (): number => app.frame().split("\n").findIndex((l) => l.includes("RESULTS"));

  async function twentyCtrlN() {
    for (let i = 0; i < 20; i++) {
      await app.press("<C-n>");
      expect(completion()).not.toBeNull();
      const header = resultsHeaderRow();
      expect(header).toBeGreaterThan(0);
      const row = selectedRow();
      expect(row).toBeGreaterThanOrEqual(0);
      expect(row).toBeLessThan(header);
    }
  }

  test("at 80 by 24 with the Results Pane shown, cursor on line 7: every selected item is on a row above the Results Pane", async () => {
    await start("\n".repeat(6), { width: 80, height: 24 });
    await app.press("Giselect * from c<C-n>");
    expect(labels()!.length).toBeGreaterThan(8);
    expect(selectedRow()).toBeGreaterThanOrEqual(0);
    await twentyCtrlN();
  });

  test("the same after a resize to 60 by 16 with the popup open", async () => {
    await start("\n".repeat(6), { width: 80, height: 24 });
    await app.press("Giselect * from c<C-n>");
    await app.resize(60, 16);
    await app.settle();
    expect(completion()).not.toBeNull();
    await twentyCtrlN();
  });

  test("the pure adapter: boxes 3 to 40 rows high at row offsets 0 to 10 in a terminal of 50 rows", () => {
    const terminal = { width: 80, height: 50 };
    const failures: string[] = [];
    for (let height = 3; height <= 40; height++) {
      for (let offset = 0; offset <= 10; offset++) {
        const area = { top: offset, bottom: offset + height, left: 2, right: 70 };
        for (let cursorRow = area.top; cursorRow < area.bottom; cursorRow++) {
          for (let items = 1; items <= 60; items++) {
            let previousFirst = 0;
            for (let selected = 0; selected < items; selected++) {
              const p = placePopupInBox({
                cursorRow, anchorCol: 10, itemCount: items, selected, previousFirst, width: 24, terminal, area,
              });
              const where = `box ${height}@${offset} cursor ${cursorRow} items ${items} selected ${selected}`;
              if (p === null) { failures.push(`${where}: no popup`); continue; }
              previousFirst = p.first;
              if (p.rows < 1) failures.push(`${where}: ${p.rows} rows`);
              if (cursorRow >= p.top && cursorRow < p.top + p.rows) failures.push(`${where}: covers the cursor's row`);
              if (p.top < area.top || p.top + p.rows > area.bottom) failures.push(`${where}: rows ${p.top}..${p.top + p.rows} outside the box`);
              if (selected < p.first || selected >= p.first + p.rows) failures.push(`${where}: selection not visible`);
              if (failures.length > 20) throw new Error(failures.join("\n"));
            }
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
