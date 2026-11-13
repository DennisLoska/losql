import { expect, test } from "bun:test";
import type { SchemaSnapshot } from "../../../core/db/types";
import {
  buildTree,
  defaultExpanded,
  formatColumnRow,
  peekSql,
  qualifiedName,
  quoteIdentifier,
  rowText,
  syncExpandedOnRefresh,
  truncateCells,
} from "./tree-model";

const schema: SchemaSnapshot = {
  dialect: "postgres",
  namespaces: [
    { name: "public", relations: [
      { name: "users", kind: "table", columns: [
        { name: "id", type: "int4", nullable: false, primaryKey: true },
        { name: "email", type: "text", nullable: true, primaryKey: false },
      ] },
      { name: "active_users", kind: "view", columns: [{ name: "id", type: "int4", nullable: true, primaryKey: false }] },
    ] },
    { name: "billing", relations: [
      { name: "Order Items", kind: "table", columns: [
        { name: "user_id", type: "int4", nullable: false, primaryKey: false, references: { relation: "public.users", column: "id" } },
      ] },
    ] },
  ],
};

const shape = (rows: ReturnType<typeof buildTree>) => rows.map((r) => `${"  ".repeat(r.depth)}${r.label}`);

test("namespaces start expanded and Relations collapsed", () => {
  const rows = buildTree(schema, defaultExpanded(schema), "");
  expect(shape(rows)).toEqual(["public", "  users", "  active_users (view)", "billing", "  Order Items"]);
  expect(rows[0]).toMatchObject({ kind: "namespace", id: "ns:public", expanded: true });
  expect(rows[1]).toMatchObject({ kind: "relation", id: "rel:public.users", expanded: false, namespace: "public" });
});

test("an expanded Relation lists its columns with detail", () => {
  const expanded = new Set([...defaultExpanded(schema), "rel:public.users", "rel:billing.Order Items"]);
  const rows = buildTree(schema, expanded, "");
  expect(shape(rows)).toEqual(["public", "  users", "    id", "    email", "  active_users (view)", "billing", "  Order Items", "    user_id"]);
  const details = rows.filter((r) => r.kind === "column").map((r) => r.kind === "column" && r.detail);
  expect(details).toEqual(["int4 pk", "text", "int4 → public.users.id"]);
  expect(rows[2]).toMatchObject({ kind: "column", id: "col:public.users.id" });
});

test("a collapsed namespace hides its Relations", () => {
  expect(shape(buildTree(schema, new Set(["ns:billing"]), ""))).toEqual(["public", "billing", "  Order Items"]);
});

test("a filter keeps matching Relations and their namespaces, whatever is collapsed", () => {
  expect(shape(buildTree(schema, new Set(), "user"))).toEqual(["public", "  users", "  active_users (view)"]);
  expect(shape(buildTree(schema, new Set(), "oi"))).toEqual(["billing", "  Order Items"]);
  expect(buildTree(schema, defaultExpanded(schema), "zzz")).toEqual([]);
});

test("identifiers are quoted only when needed", () => {
  expect(quoteIdentifier("users")).toBe("users");
  expect(quoteIdentifier("order_items2")).toBe("order_items2");
  expect(quoteIdentifier("Order Items")).toBe('"Order Items"');
  expect(quoteIdentifier("Users")).toBe('"Users"');
  expect(quoteIdentifier("order")).toBe('"order"');
  expect(quoteIdentifier('we"ird')).toBe('"we""ird"');
  expect(quoteIdentifier("2fast")).toBe('"2fast"');
});

test("qualified names leave out the default namespaces", () => {
  expect(qualifiedName("main", "orders")).toBe("orders");
  expect(qualifiedName("public", "users")).toBe("users");
  expect(qualifiedName("billing", "Order Items")).toBe('billing."Order Items"');
});

test("peekSql and rowText", () => {
  expect(peekSql("billing", "Order Items", 100)).toBe('select * from billing."Order Items" limit 100');
  const rows = buildTree(schema, new Set([...defaultExpanded(schema), "rel:billing.Order Items"]), "");
  expect(rows.map(rowText)).toEqual(["public", "users", "active_users", "billing", 'billing."Order Items"', "user_id"]);
});

test("expanding one node reuses row objects of other nodes and does not rebuild columns of collapsed Relations", () => {
  const expanded1 = defaultExpanded(schema);
  const rows1 = buildTree(schema, expanded1, "");
  const expanded2 = new Set([...expanded1, "rel:public.users"]);
  const rows2 = buildTree(schema, expanded2, "");

  // Namespace 'public', 'active_users', 'billing', and 'Order Items' keep the exact same object identity
  expect(rows2[0]).toBe(rows1[0]);
  expect(rows2[4]).toBe(rows1[2]);
  expect(rows2[5]).toBe(rows1[3]);
  expect(rows2[6]).toBe(rows1[4]);
});

test("quoteIdentifier, qualifiedName and peekSql quote reserved words, upper-case names, spaces and quotes", () => {
  expect(quoteIdentifier("user")).toBe('"user"');
  expect(quoteIdentifier("both")).toBe('"both"');
  expect(quoteIdentifier("Users")).toBe('"Users"');
  expect(quoteIdentifier("order items")).toBe('"order items"');
  expect(quoteIdentifier('a"b')).toBe('"a""b"');

  expect(qualifiedName("public", "user")).toBe('"user"');
  expect(qualifiedName("main", "both")).toBe('"both"');
  expect(qualifiedName("public", "Users")).toBe('"Users"');
  expect(qualifiedName("public", "order items")).toBe('"order items"');
  expect(qualifiedName("public", 'a"b')).toBe('"a""b"');
  expect(qualifiedName("user", "both")).toBe('"user"."both"');

  expect(peekSql("public", "user", 100)).toBe('select * from "user" limit 100');
  expect(peekSql("main", "user", 100)).toBe('select * from "user" limit 100');
});

const pgUrl = process.env.LOSQL_TEST_PG_URL;
const pgTest = pgUrl ? test : test.skip;

pgTest("peekSql runs and returns the table's own row for every word in Postgres pg_get_keywords() with catcode in ('R', 'T')", async () => {
  const { openSession, parseConnection } = await import("../../../core/db/connection");
  const testSchema = `losql_t19_kw_${Date.now().toString(36)}`;
  const sep = pgUrl!.includes("?") ? "&" : "?";
  const urlWithPath = `${pgUrl!}${sep}options=${encodeURIComponent(`-c search_path=${testSchema},public`)}`;
  const driver = await openSession(parseConnection(urlWithPath));
  try {
    const kwRes = await driver.run(
      "select word from pg_get_keywords() where catcode in ('R', 'T') order by word",
    );
    const words = kwRes.rows.map((r) => String(r[0]));
    expect(words.length).toBeGreaterThan(80);

    await driver.run(`create schema ${testSchema}`);

    for (const word of words) {
      const quoted = `"${word.replace(/"/g, '""')}"`;
      await driver.run(`create table ${testSchema}.${quoted} (marker text)`);
      await driver.run(`insert into ${testSchema}.${quoted} values ('row:${word}')`);
    }

    for (const word of words) {
      // Unqualified peek (since testSchema is first in search_path, like default 'public')
      const sqlDefault = peekSql("public", word, 100);
      const resDefault = await driver.run(sqlDefault, { readOnly: true });
      expect(resDefault.columns.map((c) => c.name)).toEqual(["marker"]);
      expect(resDefault.rows).toEqual([[`row:${word}`]]);
    }
  } finally {
    await driver.run(`drop schema if exists ${testSchema} cascade`).catch(() => {});
    await driver.close();
  }
});

test("syncExpandedOnRefresh preserves expanded state across refreshes, expands new namespaces, drops removed ones, and resets on a new Connection", () => {
  const prevSchema: SchemaSnapshot = {
    dialect: "postgres",
    namespaces: [
      {
        name: "public",
        relations: [
          { name: "users", kind: "table", columns: [] },
          { name: "orders", kind: "table", columns: [] },
        ],
      },
      {
        name: "billing",
        relations: [{ name: "invoices", kind: "table", columns: [] }],
      },
    ],
  };

  // Start with public expanded, billing collapsed, rel:public.orders and rel:billing.invoices expanded
  const prevExpanded = new Set([
    "ns:public",
    "rel:public.orders",
    "rel:billing.invoices",
  ]);

  // 1. A row inserted before the cursor's relation, cursor's relation removed, a namespace removed, a new namespace added
  const nextSchema: SchemaSnapshot = {
    dialect: "postgres",
    namespaces: [
      {
        name: "public",
        relations: [
          { name: "accounts", kind: "table", columns: [] },
          { name: "users", kind: "table", columns: [] },
          // "orders" removed
        ],
      },
      // "billing" removed
      {
        name: "analytics",
        relations: [{ name: "events", kind: "table", columns: [] }],
      },
    ],
  };

  const synced = syncExpandedOnRefresh(
    prevSchema,
    nextSchema,
    new Set([...prevExpanded, "rel:public.users"]),
  );
  // public stays expanded, new namespace analytics starts expanded, billing and removed relations are dropped, rel:public.users is kept
  expect(synced).toEqual(new Set(["ns:public", "ns:analytics", "rel:public.users"]));

  // If a previously collapsed namespace stays in nextSchema, it remains collapsed
  const nextWithCollapsedBilling: SchemaSnapshot = {
    dialect: "postgres",
    namespaces: [
      { name: "public", relations: [{ name: "users", kind: "table", columns: [] }] },
      { name: "billing", relations: [{ name: "invoices", kind: "table", columns: [] }] },
    ],
  };
  expect(
    syncExpandedOnRefresh(prevSchema, nextWithCollapsedBilling, prevExpanded),
  ).toEqual(new Set(["ns:public", "rel:billing.invoices"]));

  // When prevSchema is null (initial load / new Connection), all namespaces are expanded and stale relation ids are dropped
  expect(
    syncExpandedOnRefresh(null, prevSchema, new Set(["rel:public.orders"])),
  ).toEqual(new Set(["ns:public", "ns:billing"]));
});

test("truncateCells cuts between grapheme clusters for ASCII, wide characters, emoji sequences and combining marks at widths 1..40", () => {
  expect(truncateCells("abcdef", 0)).toBe("");
  expect(truncateCells("abcdef", 1)).toBe("…");
  expect(truncateCells("abcdef", 4)).toBe("abc…");
  expect(truncateCells("abcdef", 6)).toBe("abcdef");

  const samples = [
    "plain_ascii_identifier_name_1234567890",
    "日本語のテーブル名_カラム名_テスト_12345",
    "thumbs_👍🏽_👍🏽_👍🏽_flag_🇩🇪_🇩🇪_family_👨‍👩‍👧_👨‍👩‍👧",
    "e\u0301a\u0300o\u0302u\u0308_combining_marks_e\u0301a\u0300o\u0302",
    "👍🏽🇩🇪👨‍👩‍👧漢字e\u0301👍🏽🇩🇪👨‍👩‍👧",
  ];

  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

  for (const sample of samples) {
    const clusters = Array.from(segmenter.segment(sample), (s) => s.segment);
    const fullW = Bun.stringWidth(sample);
    for (let w = 1; w <= 40; w++) {
      const res = truncateCells(sample, w);
      const resW = Bun.stringWidth(res);
      expect(resW).toBeLessThanOrEqual(w);
      if (fullW <= w) {
        expect(res).toBe(sample);
      } else {
        expect(res.endsWith("…")).toBe(true);
        const prefix = res.slice(0, -1);
        // Prefix must be an exact concatenation of the first k grapheme clusters
        let acc = "";
        let k = 0;
        while (k < clusters.length && acc.length < prefix.length) {
          acc += clusters[k]!;
          k++;
        }
        expect(prefix).toBe(acc);
        // And adding the next grapheme cluster would exceed target (w - 1)
        if (k < clusters.length) {
          expect(Bun.stringWidth(acc + clusters[k]!)).toBeGreaterThan(w - 1);
        }
      }
    }
  }
});

test("formatColumnRow respects width budget for wide characters, emoji sequences and combining marks at widths 1..40", () => {
  const cases: [string, string][] = [
    ["col_👍🏽_🇩🇪_👨‍👩‍👧", "int4 pk → orders.id"],
    ["名前_漢字_カラム", "varchar → 顧客.id"],
    ["e\u0301a\u0300_col", "timestamptz pk"],
    ["👍🏽🇩🇪👨‍👩‍👧", ""],
  ];

  for (const [rawLabel, rawDetail] of cases) {
    for (let avail = 1; avail <= 40; avail++) {
      const { label, detail } = formatColumnRow(rawLabel, rawDetail, avail);
      const contentBudget = Math.max(0, avail - 4);
      const totalUsed = Bun.stringWidth(label) + Bun.stringWidth(detail);
      expect(totalUsed).toBeLessThanOrEqual(contentBudget);
      if (contentBudget === 0) {
        expect(label).toBe("");
        expect(detail).toBe("");
      } else {
        expect(label.length).toBeGreaterThan(0);
      }
    }
  }
});


