import { afterEach, describe, expect, test } from "bun:test";
import type { SchemaSnapshot } from "../../../core/db/types";
import { mount, type TestApp } from "../../testing";

let app: TestApp;
afterEach(async () => { await app?.dispose(); });

const col = (name: string) => ({ name, type: "int4", nullable: false, primaryKey: name === "id" });
const schema: SchemaSnapshot = {
  dialect: "postgres",
  namespaces: [
    {
      name: "public",
      relations: [
        { name: "Order Items", kind: "table", columns: [col("id")] },
        { name: "customers", kind: "table", columns: [col("id")] },
      ],
    },
  ],
};
// A Session that never touches the network: its Schema is the one above.
const openSession = async (connection: any) => ({
  connection,
  run: async () => ({ columns: [], rows: [], truncated: false, affected: 0, command: "SELECT", durationMs: 1 }),
  schema: async () => schema,
  close: async () => {},
});

async function start(text: string) {
  app = await mount({ connection: "postgres://localhost/dev", deps: { openSession } });
  await app.waitFor(() => app.api.session.schema() !== null);
  app.api.editor.setText(text);
  await app.settle();
}
const labels = () => app.api.editor.completion()?.items.map((i) => i.label) ?? null;

describe("completing inside a quoted name whose closing quote comes later replaces the whole name", () => {
  test('select * from "Or|der Items": typed, accepted, undone, repeated with .', async () => {
    const line = 'select * from "der Items"';
    await start(`${line}\n${line}`);
    // Typing `Or` after the quote makes the first row of the reproduction: `select * from "Or|der Items"`.
    await app.press('0f"aOr');
    expect(app.api.editor.text()).toBe(`select * from "Order Items"\n${line}`);
    await app.press("<C-n>");
    expect(labels()![0]).toBe("Order Items");
    await app.press("<CR>");
    expect(app.api.editor.text()).toBe(`select * from "Order Items"\n${line}`);
    await app.press("<Esc>");
    expect(app.api.editor.text()).toBe(`select * from "Order Items"\n${line}`);
    await app.press('j0f".');
    expect(app.api.editor.text()).toBe('select * from "Order Items"\nselect * from "Order Items"');
    await app.press("u");
    expect(app.api.editor.text()).toBe(`select * from "Order Items"\n${line}`);
    await app.press("u");
    expect(app.api.editor.text()).toBe(`${line}\n${line}`);
  });

  test('select * from "cus|tomers" where 1=1: typed, accepted, undone, repeated with .', async () => {
    const line = 'select * from "tomers" where 1=1';
    await start(`${line}\n${line}`);
    await app.press('0f"acus');
    expect(app.api.editor.text()).toBe(`select * from "customers" where 1=1\n${line}`);
    await app.press("<C-n>");
    expect(labels()![0]).toBe("customers");
    await app.press("<CR><Esc>");
    expect(app.api.editor.text()).toBe(`select * from "customers" where 1=1\n${line}`);
    await app.press('j0f".');
    expect(app.api.editor.text()).toBe('select * from "customers" where 1=1\nselect * from "customers" where 1=1');
    await app.press("u");
    expect(app.api.editor.text()).toBe(`select * from "customers" where 1=1\n${line}`);
    await app.press("u");
    expect(app.api.editor.text()).toBe(`${line}\n${line}`);
  });

  test("a name the insert typed in full is replaced with the completed name and its quote", async () => {
    // `"cus|xx"`: the rest of the old name is not part of any Relation's name and goes as well.
    const line = 'select * from "xx" where 1=1';
    await start(`${line}\n${line}`);
    await app.press('0f"acus<C-n><CR><Esc>');
    expect(app.api.editor.text()).toBe(`select * from "customers" where 1=1\n${line}`);
    await app.press('j0f".');
    expect(app.api.editor.text()).toBe('select * from "customers" where 1=1\nselect * from "customers" where 1=1');
    await app.press("uu");
    expect(app.api.editor.text()).toBe(`${line}\n${line}`);
  });
});

describe("accepting removes exactly the text from the cursor to the closing quote, however it is encoded", () => {
  const cases: [string, string][] = [
    ["a character outside the BMP", "\u{1F4E6}"],
    ["a letter with a combining mark", "é"],
    ["a flag (two code points outside the BMP)", "\u{1F1E9}\u{1F1EA}"],
    ["a ZWJ family", "\u{1F468}‍\u{1F469}‍\u{1F467}"],
  ];
  for (const [name, ch] of cases) {
    test(`${name} in the rest of the name: accepted, undone, repeated with .`, async () => {
      const line = `select * from "x${ch}er Items" where 1=1`;
      const done = 'select * from "Order Items" where 1=1';
      await start(`${line}\n${line}`);
      await app.press('0f"aOrd');
      await app.press("<C-n>");
      expect(labels()![0]).toBe("Order Items");
      await app.press("<CR>");
      expect(app.api.editor.text()).toBe(`${done}\n${line}`);
      await app.press("<Esc>");
      expect(app.api.editor.text()).toBe(`${done}\n${line}`);
      await app.press('j0f".');
      expect(app.api.editor.text()).toBe(`${done}\n${done}`);
      await app.press("u");
      expect(app.api.editor.text()).toBe(`${done}\n${line}`);
      await app.press("u");
      expect(app.api.editor.text()).toBe(`${line}\n${line}`);
    });
  }
});
