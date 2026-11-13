import { describe, expect, test } from "bun:test";
import type { TurnView } from "../../context/agent";
import { printable } from "../../ui/printable";
import { errorAdvice, splitMessage, stepSummary, transcriptLines, wrapText } from "./transcript-model";

const claude = { label: "Claude Code", binary: "claude", installHint: "Install Claude Code: https://claude.com/claude-code" };

test("wrapText breaks on spaces and keeps paragraphs", () => {
  expect(wrapText("one two three four", 9)).toEqual(["one two", "three", "four"]);
  expect(wrapText("a\n\nb", 20)).toEqual(["a", "", "b"]);
  expect(wrapText("abcdefghijkl", 5)).toEqual(["abcde", "fghij", "kl"]);
  expect(wrapText("", 10)).toEqual([""]);
});

test("splitMessage separates fenced SQL", () => {
  expect(splitMessage("Try this:\n```sql\nselect 1;\n```\nDone.")).toEqual([
    { kind: "text", text: "Try this:" },
    { kind: "sql", text: "select 1;" },
    { kind: "text", text: "Done." },
  ]);
  expect(splitMessage("plain")).toEqual([{ kind: "text", text: "plain" }]);
  expect(splitMessage("```\nnot sql\n```")).toEqual([{ kind: "text", text: "```\nnot sql\n```" }]);
});

describe("stepSummary", () => {
  const query = (sql: string, result: string) => ({ action: { action: "query" as const, sql }, result });

  test("a query with rows", () => {
    expect(stepSummary(query("select count(*) as n from orders", '{"columns":["n"],"rows":[[12]],"truncated":false}'), 80))
      .toBe("▸ query  select count(*) as n from orders  → 1 row");
    expect(stepSummary(query("select 1", '{"columns":["a"],"rows":[[1],[2]],"truncated":true}'), 80)).toBe("▸ query  select 1  → 2+ rows");
  });

  test("a query that failed", () => {
    expect(stepSummary(query("delete from t", '{"error":"attempt to write a readonly database"}'), 80))
      .toBe("▸ query  delete from t  → error: attempt to write a readonly database");
  });

  test("long SQL is put on one line and cut to the width", () => {
    const line = stepSummary(query("select *\n  from orders\n  where status = 'paid' and total > 100", '{"columns":[],"rows":[],"truncated":false}'), 40);
    expect(line.length).toBeLessThanOrEqual(40);
    expect(line).toStartWith("▸ query  select * from orders");
    expect(line).toEndWith("…  → 0 rows");
  });

  test("describe", () => {
    expect(stepSummary({ action: { action: "describe", relations: ["orders", "customers"] }, result: "..." }, 80)).toBe("▸ describe  orders, customers");
  });
});

test("errorAdvice tells the user what to do", () => {
  expect(errorAdvice("auth", claude)).toBe("Run `claude` once in a terminal to log in, then try again.");
  expect(errorAdvice("quota", claude)).toBe("Claude Code has reached its usage limit. Try again later or switch provider with space p.");
  expect(errorAdvice("missing", claude)).toBe("Install Claude Code: https://claude.com/claude-code");
  expect(errorAdvice("timeout", claude)).toBe("Claude Code did not answer in time. Try again, or pick a faster model with space m.");
  expect(errorAdvice("cancelled", claude)).toBe("");
  expect(errorAdvice("protocol", claude)).toBe("The reply could not be understood. Try again, or pick another model with space m.");
  expect(errorAdvice("other", null)).toBe("");
});

describe("transcriptLines", () => {
  const turn = (extra: Partial<TurnView>): TurnView => ({
    id: 1, intent: "ask", text: "how many orders?", steps: [], status: "done", activity: null,
    message: null, errorKind: null, proposal: null, source: null, ...extra,
  });

  test("a finished Turn with a Step and a Proposal", () => {
    const lines = transcriptLines([turn({
      steps: [{ action: { action: "query", sql: "select count(*) from orders" }, result: '{"columns":["n"],"rows":[[12]],"truncated":false}' }],
      message: "There are 12 orders.",
      proposal: { id: 7, turnId: 1, sql: "select count(*)\nfrom orders", kind: "read" },
    })], 60, claude);
    expect(lines).toEqual([
      { kind: "label", who: "you", turnId: 1 },
      { kind: "text", text: "how many orders?", tone: "normal", turnId: 1 },
      { kind: "blank" },
      { kind: "label", who: "agent", turnId: 1 },
      { kind: "step", text: "▸ query  select count(*) from orders  → 1 row", turnId: 1 },
      { kind: "text", text: "There are 12 orders.", tone: "normal", turnId: 1 },
      { kind: "sql", text: "select count(*)", turnId: 1, proposalId: 7 },
      { kind: "sql", text: "from orders", turnId: 1, proposalId: 7 },
      { kind: "hint", text: "enter accept  r run  y yank", turnId: 1, proposalId: 7 },
      { kind: "blank" },
    ]);
  });

  test("a running Turn ends with its status line", () => {
    const lines = transcriptLines([turn({ status: "running", activity: "thinking" })], 60, claude);
    expect(lines[lines.length - 2]).toEqual({ kind: "status", activity: "thinking", turnId: 1 });
  });

  test("a failed Turn shows the error and the advice", () => {
    const lines = transcriptLines([turn({ status: "error", errorKind: "quota", message: "You've hit your usage limit" })], 60, claude);
    expect(lines.filter((l) => l.kind === "text").map((l) => l.kind === "text" && [l.tone, l.text])).toEqual([
      ["normal", "how many orders?"],
      ["error", "You've hit your usage limit"],
      ["muted", "Claude Code has reached its usage limit. Try again later or"],
      ["muted", "switch provider with space p."],
    ]);
  });

  test("a cancelled Turn says so, and fenced SQL in a message is shown as SQL", () => {
    const cancelled = transcriptLines([turn({ status: "cancelled", message: "the turn was cancelled" })], 60, claude);
    expect(cancelled).toContainEqual({ kind: "text", text: "Cancelled.", tone: "muted", turnId: 1 });
    const fenced = transcriptLines([turn({ message: "Like this:\n```sql\nselect 1\n```" })], 60, claude);
    expect(fenced).toContainEqual({ kind: "sql", text: "select 1", turnId: 1, proposalId: null });
  });

  test("long text is wrapped to the width", () => {
    const lines = transcriptLines([turn({ text: "word ".repeat(30).trim() })], 20, claude);
    for (const line of lines) if (line.kind === "text") expect(line.text.length).toBeLessThanOrEqual(20);
  });

  const deleteCancelledSql = [
    "BEGIN;",
    "DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE status = 'cancelled');",
    "DELETE FROM orders WHERE status = 'cancelled';",
    "COMMIT;",
  ].join("\n");

  function reconstructSqlLines(rows: { text: string }[]): string[] {
    const logical: string[] = [];
    for (const row of rows) {
      if (row.text.startsWith("↪ ")) {
        expect(logical.length).toBeGreaterThan(0);
        logical[logical.length - 1] += row.text.slice(2);
      } else {
        logical.push(row.text);
      }
    }
    return logical;
  }

  test("Proposal SQL lines wrap with ↪ continuation markers at widths 20, 30, 42 and 80 without losing any character", () => {
    const originalLines = deleteCancelledSql.split("\n");
    for (const width of [20, 30, 42, 80]) {
      const lines = transcriptLines(
        [turn({ proposal: { id: 9, turnId: 1, sql: deleteCancelledSql, kind: "write" } })],
        width,
        claude,
      );
      const sqlRows = lines.filter((l) => l.kind === "sql");
      for (const row of sqlRows) {
        expect(Bun.stringWidth(row.text)).toBeLessThanOrEqual(width);
      }
      if (width <= 42) {
        expect(sqlRows.some((r) => r.text.startsWith("↪ "))).toBe(true);
      }
      if (width === 42) {
        expect(sqlRows.map((r) => r.text)).toEqual([
          "BEGIN;",
          "DELETE FROM order_items WHERE order_id IN ",
          "↪ (SELECT id FROM orders WHERE status = ",
          "↪ 'cancelled');",
          "DELETE FROM orders WHERE status = ",
          "↪ 'cancelled';",
          "COMMIT;",
        ]);
      }
      expect(reconstructSqlLines(sqlRows)).toEqual(originalLines);
    }
  });

  test("runs of spaces in SQL are kept and trailing SQL appears on a continuation row", () => {
    const sneaky = `SELECT 1; ${" ".repeat(200)}drop table x`;
    const lines = transcriptLines(
      [turn({ proposal: { id: 10, turnId: 1, sql: sneaky, kind: "write" } })],
      42,
      claude,
    );
    const sqlRows = lines.filter((l) => l.kind === "sql");
    expect(sqlRows.length).toBeGreaterThan(1);
    expect(sqlRows[0]!.text.startsWith("↪ ")).toBe(false);
    for (let i = 1; i < sqlRows.length; i++) {
      expect(sqlRows[i]!.text.startsWith("↪ ")).toBe(true);
      expect(Bun.stringWidth(sqlRows[i]!.text)).toBeLessThanOrEqual(42);
    }
    expect(sqlRows.some((r) => r.text.startsWith("↪ ") && r.text.includes("drop table x"))).toBe(true);
    expect(reconstructSqlLines(sqlRows)).toEqual([sneaky]);
  });

  test("wide characters and emoji at the break position are never split", () => {
    // 19 single-cell ASCII chars followed by 2-cell wide char 漢 and 2-cell emoji 🚀 at width 20
    const wideSql = "SELECT '12345678901漢🚀漢字テスト🚀end';";
    const lines = transcriptLines(
      [turn({ proposal: { id: 11, turnId: 1, sql: wideSql, kind: "read" } })],
      20,
      claude,
    );
    const sqlRows = lines.filter((l) => l.kind === "sql");
    expect(sqlRows.length).toBeGreaterThan(1);
    for (const row of sqlRows) {
      expect(Bun.stringWidth(row.text)).toBeLessThanOrEqual(20);
      expect(row.text).not.toContain("\ufffd");
    }
    expect(sqlRows[0]!.text).toBe("SELECT '12345678901");
    expect(sqlRows[1]!.text.startsWith("↪ 漢🚀")).toBe(true);
    expect(reconstructSqlLines(sqlRows)).toEqual([wideSql]);
  });

  test("a Proposal of 300 short lines gives 60 SQL rows and the … N more rows row", () => {
    const threeHundred = Array.from({ length: 300 }, (_, i) => `SELECT ${i};`).join("\n");
    const lines = transcriptLines(
      [turn({ proposal: { id: 12, turnId: 1, sql: threeHundred, kind: "read" } })],
      42,
      claude,
    );
    const sqlRows = lines.filter((l) => l.kind === "sql");
    expect(sqlRows.length).toBe(60);
    expect(lines).toContainEqual({
      kind: "text",
      text: "… 240 more rows · enter opens the whole statement in the editor",
      tone: "muted",
      turnId: 1,
    });
  });

  test("fenced SQL inside a message wraps and caps at 60 rows the same way", () => {
    const originalLines = deleteCancelledSql.split("\n");
    for (const width of [20, 30, 42, 80]) {
      const lines = transcriptLines(
        [turn({ message: `Run this:\n\`\`\`sql\n${deleteCancelledSql}\n\`\`\`` })],
        width,
        claude,
      );
      const sqlRows = lines.filter((l) => l.kind === "sql");
      for (const row of sqlRows) {
        expect(row.proposalId).toBeNull();
        expect(Bun.stringWidth(row.text)).toBeLessThanOrEqual(width);
      }
      expect(reconstructSqlLines(sqlRows)).toEqual(originalLines);
    }

    const threeHundred = Array.from({ length: 300 }, (_, i) => `SELECT ${i};`).join("\n");
    const capped = transcriptLines(
      [turn({ message: `\`\`\`sql\n${threeHundred}\n\`\`\`` })],
      42,
      claude,
    );
    expect(capped.filter((l) => l.kind === "sql").length).toBe(60);
    expect(capped).toContainEqual({
      kind: "text",
      text: "… 240 more rows",
      tone: "muted",
      turnId: 1,
    });
  });

  test("cut fenced SQL in a message only counts the rows; a cut Proposal in the same turn still says enter opens it", () => {
    const threeHundred = Array.from({ length: 300 }, (_, i) => `SELECT ${i};`).join("\n");
    const twoHundred = Array.from({ length: 200 }, (_, i) => `SELECT ${i};`).join("\n");
    const lines = transcriptLines(
      [turn({ message: `\`\`\`sql\n${twoHundred}\n\`\`\``, proposal: { id: 7, turnId: 1, sql: threeHundred, kind: "read" } })],
      42,
      claude,
    );
    const markers = lines.filter((l) => l.kind === "text" && l.text.startsWith("… ")).map((l) => (l.kind === "text" ? l.text : ""));
    expect(markers).toEqual(["… 140 more rows", "… 240 more rows · enter opens the whole statement in the editor"]);
  });
});


function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("a Proposal is shown with exactly the line breaks of its SQL", () => {
  const proposalTurn = (sql: string): TurnView => ({
    id: 1, intent: "ask", text: "q", steps: [], status: "done", activity: null,
    message: null, errorKind: null, proposal: { id: 3, turnId: 1, sql, kind: "write" }, source: null,
  });
  const sqlRowsOf = (sql: string, width: number) =>
    transcriptLines([proposalTurn(sql)], width, claude).filter(
      (l): l is Extract<typeof l, { kind: "sql" }> => l.kind === "sql",
    );
  const joinRows = (rows: { text: string; continuation?: boolean }[]): string[] => {
    const out: string[] = [];
    for (const row of rows) {
      if (row.continuation === true) {
        expect(row.text.startsWith("↪ ")).toBe(true);
        out[out.length - 1] += row.text.slice(2);
      } else {
        out.push(row.text);
      }
    }
    return out;
  };

  test("U+2028, U+2029, a lone CR, U+0085, U+000B and U+000C never start a row", () => {
    for (const sep of ["\u2028", "\u2029", "\r", "\u0085", "\u000b", "\u000c"]) {
      const rows = sqlRowsOf(`delete from orders -- cleanup${sep}where id = 1`, 80);
      expect(rows.length).toBe(1);
      expect(rows[0]!.text).toContain("cleanup");
      expect(rows[0]!.text).toContain("where id = 1");
    }
    expect(sqlRowsOf("delete from orders -- cleanup\nwhere id = 1", 80).map((r) => r.text)).toEqual([
      "delete from orders -- cleanup",
      "where id = 1",
    ]);
  });

  test("property: over 2,000 seeded SQL texts with every line and paragraph separator and the C0 and C1 controls, the rows of each SQL line join to that line", () => {
    const controls: string[] = [];
    for (let c = 0; c <= 0x1f; c++) controls.push(String.fromCharCode(c));
    controls.push("\u007f");
    for (let c = 0x80; c <= 0x9f; c++) controls.push(String.fromCharCode(c));
    const alphabet = [
      ...controls, "\u2028", "\u2029", "\r\n", "\n", "\n",
      "a", "b", "z", "1", " ", " ", " ", "-", "'", ";", "↪", "↪ ", "漢", "🚀", "é", "select ", "where ",
    ];
    const rand = seeded(20261112);
    for (let n = 0; n < 2000; n++) {
      const len = 1 + Math.floor(rand() * 40);
      let sql = "";
      for (let i = 0; i < len; i++) sql += alphabet[Math.floor(rand() * alphabet.length)]!;
      const width = 8 + Math.floor(rand() * 60);
      const rows = sqlRowsOf(sql, width);
      const expected = sql.split("\n").map((line) => printable(line));
      expect(joinRows(rows)).toEqual(expected);
      for (const row of rows) {
        const shown = row.continuation === true || !row.text.startsWith("↪") ? row.text : `\\u21AA${row.text.slice(1)}`;
        if (Bun.stringWidth(shown) > width) {
          // Only a single grapheme wider than the whole width may overflow.
          const body = row.continuation === true ? row.text.slice(2) : row.text;
          expect([...new Intl.Segmenter().segment(body)].length).toBe(1);
        }
      }
    }
  });

  test("the model says which rows are continuations: a real line starting with ↪ is not one", () => {
    const rows = sqlRowsOf("select 1 as a -- note\n↪ ; select 2", 80);
    expect(rows).toEqual([
      { kind: "sql", text: "select 1 as a -- note", turnId: 1, proposalId: 3 },
      { kind: "sql", text: "↪ ; select 2", turnId: 1, proposalId: 3 },
    ]);
    expect(rows.every((r) => r.continuation === undefined)).toBe(true);

    const wrapped = sqlRowsOf("select 1 -- a_very_long_comment_that_continues_onto_the_next_row", 30);
    expect(wrapped.length).toBeGreaterThan(1);
    expect(wrapped[0]!.continuation).toBeUndefined();
    for (const row of wrapped.slice(1)) expect(row.continuation).toBe(true);
  });

  test("the six cells of the written-out ↪ count against the width", () => {
    const line = `↪${"x".repeat(19)}`;
    const rows = sqlRowsOf(line, 20);
    expect(rows.length).toBe(2);
    expect(Bun.stringWidth(`\\u21AA${rows[0]!.text.slice(1)}`)).toBeLessThanOrEqual(20);
    expect(rows[1]!.continuation).toBe(true);
    expect(joinRows(rows)).toEqual([line]);
  });
});
