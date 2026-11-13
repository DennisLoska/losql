import { afterEach, describe, expect, test } from "bun:test";
import { measureEditText, TextBufferRenderable, type Renderable } from "@opentui/core";
import type { Cell, Connection, Driver, Relation, Result } from "../core/db/types";
import { AgentPane } from "./panes/agent/AgentPane";
import { ResultsPane } from "./panes/results/ResultsPane";
import { SchemaPane } from "./panes/schema/SchemaPane";
import { cellsWith, fakeClaude, mount, type MountOptions, type TestApp } from "./testing";

/** Texts on which Bun.stringWidth and the renderer disagree, and some on which they agree. */
const TEXTS = [
  "مَرْحَبًا",
  "שָׁלוֹם",
  "한국어".normalize("NFD"),
  "co­op­erate",
  "a\ud800b",
  "각",
  "👍🏽",
  "🇩🇪",
  "👨‍👩‍👧",
  "日本語",
  "é",
  "1️⃣",
  "plain",
];

let app: TestApp | undefined;
afterEach(async () => {
  await app?.dispose();
  app = undefined;
});

/** A Session whose Driver returns fixed rows; nothing is looked up or opened. */
function fixed(columns: string[], rows: Cell[][]): Partial<MountOptions> {
  const result: Result = {
    columns: columns.map((name) => ({ name, type: "text" })), rows, truncated: false, affected: null, command: "SELECT", durationMs: 3,
  };
  const openSession = async (connection: Connection): Promise<Driver> => ({
    connection, run: async () => result, schema: async () => ({ dialect: "postgres", namespaces: [] }), close: async () => {},
  });
  return { connection: "postgres://localhost/dev", deps: { openSession } };
}

describe("the Results table draws columns where it measured them", () => {
  // At width 40 the first column must leave room for the second, so its texts are repeated twice (no cut);
  // at 80 and 120 they are repeated nine times, so the longer ones are cut at the column's 40 cells.
  for (const [width, repeat] of [[40, 2], [80, 9], [120, 9]] as const) {
    test(`a marker column starts at the same x in every row at Pane width ${width}`, async () => {
      const rows: Cell[][] = [];
      for (const text of TEXTS) rows.push([text, `MK${String(rows.length).padStart(2, "0")}`]);
      for (const text of TEXTS) rows.push([text.repeat(repeat), `MK${String(rows.length).padStart(2, "0")}`]);
      app = await mount({ ...fixed(["text", "marker"], rows), width, height: rows.length + 8, ui: () => <ResultsPane /> });
      await app.waitFor(() => app!.api.session.status() === "connected");
      await app.api.session.run({ statements: ["select 1"] });
      app.api.focus.focus("results");
      await app.settle();
      const xs = rows.map((_, i) => {
        const at = cellsWith(app!.setup, `MK${String(i).padStart(2, "0")}`);
        return at.length === 1 ? at[0]!.x : -1;
      });
      const plain = xs[TEXTS.length - 1]!;
      expect(plain).toBeGreaterThan(0);
      expect(xs.map((x, i) => `${JSON.stringify(rows[i]![0]).slice(0, 24)} ${x}`)).toEqual(
        rows.map((row) => `${JSON.stringify(row[0]).slice(0, 24)} ${plain}`),
      );
    });
  }
});

/** The longest text any drawn text element holds: what the renderer was handed. */
function longestText(root: Renderable): number {
  let longest = 0;
  const walk = (node: Renderable) => {
    if (node instanceof TextBufferRenderable) longest = Math.max(longest, node.plainText.length);
    for (const child of node.getChildren()) walk(child as Renderable);
  };
  walk(root);
  return longest;
}

describe("the Record view draws a bounded part of a one-line value", () => {
  for (const [name, unit] of [["ASCII", "x"], ["é日", "é日"]] as const) {
    test(`a one-line value of 50 MB (${name}) opens and moves with text bounded by the Pane's width; y copies all of it`, async () => {
      const big = unit.repeat((50 * 1024 * 1024) / unit.length);
      big.charCodeAt(big.length - 1);
      let copied = "";
      const base = fixed(["id", "big", "tail"], [[1, big, "end"]]);
      app = await mount({
        ...base,
        width: 100,
        deps: {
          ...base.deps,
          which: (bin) => (bin === "wl-copy" ? "/usr/bin/wl-copy" : null),
          exec: async (request) => {
            copied = request.stdin ?? "";
            return { code: 0, stdout: "", stderr: "", timedOut: false, aborted: false };
          },
        },
      });
      await app.waitFor(() => app!.api.session.status() === "connected");
      await app.api.session.run({ statements: ["select 1"] });
      app.api.focus.focus("results");
      await app.settle();
      const t0 = performance.now();
      await app.press("<CR>");
      const openMs = performance.now() - t0;
      expect(app.api.results.view()).toBe("record");
      expect(longestText(app.setup.renderer.root)).toBeLessThanOrEqual(4 * 100);
      const row = app.frame().split("\n").find((line) => line.includes("big"))!;
      expect(row.trimEnd().endsWith("…")).toBe(true);
      const t1 = performance.now();
      await app.press("j");
      const jMs = performance.now() - t1;
      expect(longestText(app.setup.renderer.root)).toBeLessThanOrEqual(4 * 100);
      await app.press("y");
      expect(copied.length).toBe(big.length);
      expect(copied === big).toBe(true);
      console.log(`Record view, 50 MB one-line ${name} value: open ${openMs.toFixed(1)} ms, j ${jMs.toFixed(1)} ms`);
    });
  }
});

/** The drawn width of a text under the test renderer's rule: only used to build a plain text as wide. */
const drawn = (text: string) => measureEditText(text, { widthMethod: "unicode" });
const tag = (prefix: string, i: number) => `${prefix}${String(i).padStart(3, "0")}`;
/** The x of the one place `marker` is drawn, or -1 when it is not drawn exactly once. */
const xOf = (marker: string) => {
  const at = cellsWith(app!.setup, marker);
  return at.length === 1 ? at[0]!.x : -1;
};

test("a select dialog row with such a title shows its hint and description where a plain title as wide has them", async () => {
  app = await mount({ ui: () => <text>base</text>, width: 60, height: 50 });
  const pairs: { text: string; plain: string; id: number }[] = [];
  TEXTS.forEach((t, i) => {
    for (let k = 1; k <= 8; k++) pairs.push({ text: t.repeat(k), plain: "x".repeat(drawn(t.repeat(k))), id: i * 10 + k });
  });
  const frameWidth = app.setup.renderer.currentRenderBuffer.width;
  const got: string[] = [];
  const want: string[] = [];
  // A dialog shows a dozen rows at a time: six pairs of a text and its plain reference per dialog.
  for (let start = 0; start < pairs.length; start += 6) {
    const group = pairs.slice(start, start + 6);
    const options = group.flatMap((p) => [
      { title: p.text, value: `t${p.id}`, hint: tag("H", p.id), description: tag("D", p.id) },
      { title: p.plain, value: `p${p.id}`, hint: tag("G", p.id), description: tag("E", p.id) },
    ]);
    void app.api.dialog.select({ title: "Pick", options });
    await app.settle();
    for (const p of group) {
      const [h, d, g, e] = [xOf(tag("H", p.id)), xOf(tag("D", p.id)), xOf(tag("G", p.id)), xOf(tag("E", p.id))];
      expect(h === -1 || h + 4 <= frameWidth).toBe(true);
      got.push(`${JSON.stringify(p.text).slice(0, 30)} hint@${h}` + (h === -1 ? "" : ` description@${d}`));
      want.push(`${JSON.stringify(p.text).slice(0, 30)} hint@${g}` + (h === -1 ? "" : ` description@${e}`));
    }
    await app.press("<Esc>");
  }
  expect(got).toEqual(want);
});

test("a Schema Pane column row with such a name cuts it so the type starts where it does for a plain name", async () => {
  const relation: Relation = {
    name: "t",
    kind: "table",
    columns: TEXTS.map((t, i) => ({ name: t.repeat(30), type: tag("T", i), nullable: true, primaryKey: false })),
  };
  const openSession = async (connection: Connection): Promise<Driver> => ({
    connection, run: async () => { throw new Error("unused"); },
    schema: async () => ({ dialect: "postgres", namespaces: [{ name: "public", relations: [relation] }] }),
    close: async () => {},
  });
  app = await mount({ connection: "postgres://localhost/dev", deps: { openSession }, width: 40, height: 30, ui: () => <SchemaPane /> });
  await app.waitFor(() => app!.api.session.schema() !== null);
  app.api.focus.focus("schema");
  await app.press("jl");
  const plainX = xOf(tag("T", TEXTS.length - 1));
  expect(plainX).toBeGreaterThan(0);
  for (let i = 0; i < TEXTS.length; i++) {
    const x = xOf(tag("T", i));
    // A cut can end one cell short when the next cluster is two cells wide; it never ends past the plain one.
    expect([TEXTS[i], x <= plainX && x >= plainX - 1]).toEqual([TEXTS[i], true]);
  }
});

describe("the status line", () => {
  for (let i = 0; i < TEXTS.length - 1; i++) {
    const name = TEXTS[i]!;
    test(`with the Connection name ${JSON.stringify(name)} lays out as with a plain name as wide`, async () => {
      const layout = async (connection: string) => {
        app = await mount({ connection, config: { connections: [{ name: connection, url: "demo" }] }, width: 40, height: 8 });
        await app.waitFor(() => app!.api.session.status() === "connected");
        const out: string[] = [];
        for (let width = 36; width <= 72; width += 2) {
          await app.resize(width, 8);
          const at = (marker: string) => cellsWith(app!.setup, marker).map((p) => p.x).join(",");
          out.push(`${width}: sqlite@${at("sqlite")} 1:1@${at("1:1")} agent@${at("no agent")} menu@${at("menu")}`);
        }
        await app.dispose();
        app = undefined;
        return out;
      };
      const plain = await layout("x".repeat(drawn(name)));
      expect(await layout(name)).toEqual(plain);
    });
  }
});

test("a line of the Agent transcript with such a text wraps where a plain line as wide does", async () => {
  const lines: string[] = [];
  TEXTS.forEach((t, i) => {
    for (const k of [1, 3, 5]) {
      const text = t.repeat(k);
      lines.push(`${text} ${tag("M", i * 10 + k)}`);
      lines.push(`${"x".repeat(drawn(text))} ${tag("R", i * 10 + k)}`);
    }
  });
  const fake = fakeClaude([JSON.stringify({ action: "answer", message: lines.join("\n\n") })]);
  app = await mount({
    width: 40, height: 420, config: { agent: { provider: "claude" } }, deps: { which: fake.which, exec: fake.exec }, ui: () => <AgentPane />,
  });
  await app.waitFor(() => app!.api.session.status() === "connected" && app!.api.agent.providers().length === 4);
  await app.api.agent.ask({ intent: "ask", text: "show" });
  await app.waitFor(() => app!.api.agent.turns()[0]?.status !== "running");
  const frameWidth = app.setup.renderer.currentRenderBuffer.width;
  const where = (marker: string) => cellsWith(app!.setup, marker);
  const got: string[] = [];
  const want: string[] = [];
  TEXTS.forEach((t, i) => {
    for (const k of [1, 3, 5]) {
      const m = where(tag("M", i * 10 + k));
      const r = where(tag("R", i * 10 + k));
      expect([t, k, m.length, r.length]).toEqual([t, k, 1, 1]);
      expect(m[0]!.x + 3 <= frameWidth).toBe(true);
      got.push(`${JSON.stringify(t)}×${k} x=${m[0]!.x}`);
      want.push(`${JSON.stringify(t)}×${k} x=${r[0]!.x}`);
    }
  });
  expect(got).toEqual(want);
});
