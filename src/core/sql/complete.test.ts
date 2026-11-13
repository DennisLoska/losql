import { describe, expect, test } from "bun:test";
import type { RelationColumn, SchemaSnapshot } from "../db/types";
import { complete, MAX_COMPLETIONS } from "./complete";

const col = (name: string): RelationColumn => ({ name, type: "text", nullable: true, primaryKey: false });
const schema: SchemaSnapshot = {
  dialect: "sqlite",
  namespaces: [{ name: "main", relations: [
    { name: "customers", kind: "table", columns: [col("id"), col("name"), col("email")] },
    { name: "orders", kind: "table", columns: [col("id"), col("customer_id"), col("status")] },
  ] }],
};

const at = (marked: string, s: SchemaSnapshot | null = schema) => {
  const offset = marked.indexOf("|");
  return complete(marked.replace("|", ""), offset, s);
};
const labels = (marked: string, s: SchemaSnapshot | null = schema) => at(marked, s).items.map((i) => i.label);

test("keywords by prefix, replacing from the start of the word", () => {
  const c = at("sel|");
  expect(c.from).toBe(0);
  expect(c.items[0]).toEqual({ label: "select", kind: "keyword" });
});

test("keyword case follows what was typed", () => {
  expect(labels("SEL|")[0]).toBe("SELECT");
});

test("relations by prefix", () => {
  const c = at("select * from cu|");
  expect(c.from).toBe(14);
  expect(c.items[0]).toEqual({ label: "customers", kind: "relation", detail: "table" });
});

test("columns after a relation name and a dot", () => {
  expect(labels("select customers.|")).toEqual(["id", "name", "email"]);
  expect(at("select customers.na|").items).toEqual([{ label: "name", kind: "column", detail: "text" }]);
});

test("columns after an alias and a dot", () => {
  const c = at("select o.st| from orders o");
  expect(c.from).toBe(9);
  expect(c.items.map((i) => i.label)).toEqual(["status"]);
  expect(labels("select c.| from orders o join customers as c on true")).toEqual(["id", "name", "email"]);
});

test("an unknown qualifier offers nothing", () => {
  expect(at("select zz.|").items).toEqual([]);
});

test("columns of the relations used in the statement come first for a bare prefix", () => {
  const items = at("select na| from customers").items;
  expect(items[0]).toEqual({ label: "name", kind: "column", detail: "customers" });
});

test("aliases are resolved within the current statement only", () => {
  expect(at("select 1 from orders o; select o.|").items).toEqual([]);
});

test("words already in the buffer are offered", () => {
  expect(labels("with recent_orders as (select 1) select * from rec|")).toContain("recent_orders");
});

test("nothing is offered without a prefix, inside a string, or inside a comment", () => {
  expect(at("select |").items).toEqual([]);
  expect(at("select 'sel|'").items).toEqual([]);
  expect(at("-- sel|").items).toEqual([]);
});

test("works without a schema", () => {
  expect(labels("sel|", null)).toContain("select");
  expect(at("select t.|", null).items).toEqual([]);
});

test("dot-qualified completion is not capped at MAX_COMPLETIONS while general completion is", () => {
  const colNames = Array.from({ length: 70 }, (_, i) => `c${i}`);
  const wideSchema: SchemaSnapshot = {
    dialect: "sqlite",
    namespaces: [{ name: "main", relations: [
      { name: "t", kind: "table", columns: colNames.map(col) },
    ] }],
  };
  expect(labels("select t.|", wideSchema)).toEqual(colNames);
  expect(labels("select c| from t", wideSchema)).toHaveLength(MAX_COMPLETIONS);
});

test("namespace-qualified relation resolves to that namespace", () => {
  const multiNsSchema: SchemaSnapshot = {
    dialect: "postgres",
    namespaces: [
      { name: "public", relations: [{ name: "users", kind: "table", columns: [col("pub_id")] }] },
      { name: "audit", relations: [{ name: "users", kind: "table", columns: [col("audit_id")] }] },
    ],
  };
  expect(labels("select u.| from audit.users u", multiNsSchema)).toEqual(["audit_id"]);
  expect(labels("select u.| from users u", multiNsSchema)).toEqual(["pub_id"]);
});

test("an alias in the current statement takes precedence over a relation of the same name", () => {
  expect(labels("select orders.| from customers orders")).toEqual(["id", "name", "email"]);
});

test("comma-separated from list, update with alias, and insert into record referenced relations", () => {
  expect(labels("select c.| from orders o, customers c")).toEqual(["id", "name", "email"]);
  expect(labels("update orders o set o.|")).toEqual(["id", "customer_id", "status"]);
  expect(at("insert into customers (em|)").items[0]).toEqual({
    label: "email",
    kind: "column",
    detail: "customers",
  });
});

test("nothing is offered inside a quoted identifier, while a quoted qualifier before a dot resolves", () => {
  expect(at('select "sel|').items).toEqual([]);
  expect(at('select "sel|" from customers').items).toEqual([]);
  expect(labels('select "orders".| from orders')).toEqual(["id", "customer_id", "status"]);
});

test("general completion orders groups (column, relation, keyword, word) and deduplicates labels across groups", () => {
  const groupSchema: SchemaSnapshot = {
    dialect: "sqlite",
    namespaces: [
      {
        name: "main",
        relations: [
          {
            name: "catalog",
            kind: "table",
            // "ca_col" is only a column; "catalog" collides with relation; "case" collides with keyword; "ca_buf" collides with buffer word
            columns: [col("ca_col"), col("catalog"), col("case"), col("ca_buf")],
          },
          {
            name: "ca_rel",
            kind: "view",
            columns: [col("id")],
          },
        ],
      },
    ],
  };

  const res = at("select ca_buf, ca_word, ca| from catalog", groupSchema);
  const kinds = res.items.map((item) => item.kind);
  expect(kinds).toContain("column");
  expect(kinds).toContain("relation");
  expect(kinds).toContain("keyword");
  expect(kinds).toContain("word");

  // Verify non-decreasing group rank: column (0) -> relation (1) -> keyword (2) -> word (3)
  const rank = { column: 0, relation: 1, keyword: 2, word: 3 } as const;
  for (let i = 1; i < res.items.length; i++) {
    expect(rank[res.items[i]!.kind]).toBeGreaterThanOrEqual(rank[res.items[i - 1]!.kind]);
  }

  // Labels offered by an earlier group are not offered again by a later group
  const lowerLabels = res.items.map((item) => item.label.toLowerCase());
  expect(new Set(lowerLabels).size).toBe(lowerLabels.length);
  expect(res.items.find((i) => i.label === "catalog")?.kind).toBe("column");
  expect(res.items.find((i) => i.label === "case")?.kind).toBe("column");
  expect(res.items.find((i) => i.label === "ca_buf")?.kind).toBe("column");
  expect(res.items.find((i) => i.label === "ca_rel")?.kind).toBe("relation");
  expect(res.items.find((i) => i.label === "cast")?.kind).toBe("keyword");
  expect(res.items.find((i) => i.label === "ca_word")?.kind).toBe("word");
});

test("an alias of something that is not a known relation shadows a relation of the same name", () => {
  expect(at("select orders.| from cte orders").items).toEqual([]);
  expect(at("select orders.| from (select 1 as a) orders").items).toEqual([]);
  expect(labels("select o.| from orders o")).toEqual(["id", "customer_id", "status"]);
});

test("a doubly qualified reference resolves through its namespace only", () => {
  const multiNsSchema: SchemaSnapshot = {
    dialect: "postgres",
    namespaces: [
      { name: "public", relations: [{ name: "users", kind: "table", columns: [col("pub_id")] }] },
      { name: "audit", relations: [{ name: "users", kind: "table", columns: [col("audit_id")] }] },
    ],
  };
  expect(labels("select audit.users.|", multiNsSchema)).toEqual(["audit_id"]);
  expect(labels("select public.users.|", multiNsSchema)).toEqual(["pub_id"]);
  expect(labels("select missing.users.|", multiNsSchema)).toEqual([]);
});

const quotingSchema: SchemaSnapshot = {
  dialect: "postgres",
  namespaces: [
    {
      name: "public",
      relations: [
        { name: "user", kind: "table", columns: [col("id"), col("case"), col("Created At")] },
        { name: "Order Items", kind: "table", columns: [col("id"), col("Created At")] },
        { name: "Users", kind: "table", columns: [col("id")] },
        { name: "customers", kind: "table", columns: [col("id"), col("case"), col("Created At")] },
      ],
    },
    {
      name: "My Schema",
      relations: [
        { name: "Order Items", kind: "table", columns: [col("id"), col("case"), col("Created At")] },
        { name: "orders", kind: "table", columns: [col("id")] },
      ],
    },
  ],
};
const qat = (marked: string) => at(marked, quotingSchema);
const item = (marked: string, label: string) => qat(marked).items.find((i) => i.label === label);

test("a Relation whose name needs quotes carries the quoted name to insert; its label stays the raw name", () => {
  expect(item("select * from us|", "user")).toEqual({ label: "user", insert: '"user"', kind: "relation", detail: "table" });
  expect(item("select * from us|", "Users")).toEqual({ label: "Users", insert: '"Users"', kind: "relation", detail: "table" });
  expect(item("select * from ord|", "Order Items")).toEqual({
    label: "Order Items",
    insert: '"Order Items"',
    kind: "relation",
    detail: "table",
  });
  const plain = item("select * from cu|", "customers")!;
  expect(plain).toEqual({ label: "customers", kind: "relation", detail: "table" });
  expect("insert" in plain).toBe(false);
  expect(qat("select * from us|").from).toBe(14);
  expect(qat("select * from us|").to).toBeUndefined();
});

test("a column whose name needs quotes carries the quoted name to insert, and case is offered once, as a column", () => {
  expect(item("select ca| from customers", "case")).toEqual({ label: "case", insert: '"case"', kind: "column", detail: "customers" });
  expect(qat("select ca| from customers").items.filter((i) => i.label.toLowerCase() === "case")).toHaveLength(1);
  expect(item("select i| from customers", "id")).toEqual({ label: "id", kind: "column", detail: "customers" });
  expect(item("select cr| from customers", "Created At")).toEqual({
    label: "Created At",
    insert: '"Created At"',
    kind: "column",
    detail: "customers",
  });
  expect(item("select CR| from customers", "Created At")?.insert).toBe('"Created At"');
});

test("after a qualifier only the completed part is written, and quoted when it needs it", () => {
  const cols = qat('select o.| from "Order Items" o');
  expect(cols.from).toBe(9);
  expect(cols.items).toEqual([
    { label: "id", kind: "column", detail: "text" },
    { label: "Created At", insert: '"Created At"', kind: "column", detail: "text" },
  ]);
  expect(qat("select c.ca| from customers c").items).toEqual([
    { label: "case", insert: '"case"', kind: "column", detail: "text" },
  ]);
  expect(qat('select "My Schema"."Order Items".|').items).toEqual([
    { label: "id", kind: "column", detail: "text" },
    { label: "case", insert: '"case"', kind: "column", detail: "text" },
    { label: "Created At", insert: '"Created At"', kind: "column", detail: "text" },
  ]);
});

test("a qualifier that names a namespace offers the Relations of that namespace", () => {
  const rels = qat('select * from "My Schema".|');
  expect(rels.from).toBe(26);
  expect(rels.items).toEqual([
    { label: "Order Items", insert: '"Order Items"', kind: "relation", detail: "table" },
    { label: "orders", kind: "relation", detail: "table" },
  ]);
  expect(qat('select * from "My Schema".ord|').items.map((i) => i.label)).toEqual(["Order Items", "orders"]);
  expect(qat("select * from public.us|").items).toEqual([
    { label: "user", insert: '"user"', kind: "relation", detail: "table" },
    { label: "Users", insert: '"Users"', kind: "relation", detail: "table" },
  ]);
  // An alias or a Relation of that name still takes precedence.
  expect(qat("select public.| from customers public").items.map((i) => i.label)).toEqual(["id", "case", "Created At"]);
});

test("inside an open double quote the raw name filters without regard to case and is written in one pair of quotes", () => {
  const ord = qat('select * from "Ord|');
  expect(ord.from).toBe(14);
  expect(ord.to).toBeUndefined();
  expect(ord.items).toEqual([
    { label: "Order Items", insert: '"Order Items"', kind: "relation", detail: "table" },
    { label: "orders", insert: '"orders"', kind: "relation", detail: "table" },
  ]);
  expect(qat('select * from "order it|').items.map((i) => i.label)).toEqual(["Order Items"]);
  expect(qat('select * from "Order Items|').items.map((i) => i.label)).toEqual(["Order Items"]);
  expect(qat('select * from "us|').items.map((i) => i.label)).toEqual(["Users", "user"]);
  // A plain name is quoted too, as the quote is already open.
  expect(qat('select * from "cu|').items).toEqual([
    { label: "customers", insert: '"customers"', kind: "relation", detail: "table" },
  ]);
  // Only names: no keyword and no word from the buffer.
  expect(qat('select * from "sel|').items).toEqual([]);
  expect(qat('select "ca| from customers').items).toEqual([
    { label: "case", insert: '"case"', kind: "column", detail: "customers" },
  ]);
});

test("inside a quote whose closing quote follows the cursor, accepting also replaces that closing quote", () => {
  const closed = qat('select * from "Ord|"');
  expect(closed.from).toBe(14);
  expect(closed.to).toBe(19);
  expect(closed.items[0]!.insert).toBe('"Order Items"');
  const closedMore = qat('select * from "Ord|" where id = 1');
  expect(closedMore.to).toBe(19);
  // The cursor after the closing quote is not inside the quote.
  expect(qat('select * from "Ord"|').items).toEqual([]);
  // A quote that closes later on the line is replaced as well: the name runs to it.
  expect(qat('select * from "Or|d"').to).toBe(19);
});

/** The text after accepting the first item, or the item labelled `label`. */
const accepted = (marked: string, s: SchemaSnapshot = quotingSchema, label?: string) => {
  const offset = marked.indexOf("|");
  const text = marked.replace("|", "");
  const c = complete(text, offset, s);
  const it = label === undefined ? c.items[0] : c.items.find((i) => i.label === label);
  if (!it) throw new Error(`nothing offered for ${marked}`);
  return text.slice(0, c.from) + (it.insert ?? it.label) + text.slice(c.to ?? offset);
};

describe("inside a quoted name whose closing quote comes later on the line, accepting replaces the whole name", () => {
  test("the rows of the reproduction", () => {
    expect(accepted('select * from "Or|der Items"')).toBe('select * from "Order Items"');
    expect(accepted('select * from "cus|tomers" where 1=1')).toBe('select * from "customers" where 1=1');
    expect(accepted('select * from "Or|"')).toBe('select * from "Order Items"');
    expect(accepted('select * from "Or|')).toBe('select * from "Order Items"');
    expect(accepted('select * from "Or| where "id" = 1')).toBe('select * from "Order Items" where "id" = 1');
    expect(qat('select * from "Or|der Items"').to).toBe(27);
    expect(qat('select * from "cus|tomers" where 1=1').to).toBe(25);
    // An even number of quotes after the cursor: the quote is still open, as before.
    expect(qat('select * from "Or| where "id" = 1').to).toBeUndefined();
    expect(qat('select * from "Or|').to).toBeUndefined();
  });

  test("a doubled quote inside the name counts as two and changes nothing", () => {
    const s: SchemaSnapshot = {
      dialect: "postgres",
      namespaces: [{ name: "public", relations: [{ name: 'a"bcd', kind: "table", columns: [col("id")] }] }],
    };
    expect(accepted('select * from "a""b|c" where 1=1', s)).toBe('select * from "a""bcd" where 1=1');
    expect(accepted('select * from "a|""bc" where 1=1', s)).toBe('select * from "a""bcd" where 1=1');
    expect(accepted('select * from "a""b|', s)).toBe('select * from "a""bcd"');
  });

  test("the cursor directly after the opening quote", () => {
    // Nothing typed and no qualifier: nothing is offered (as for an empty word), so nothing is replaced.
    expect(qat('select * from "|der Items"').items).toEqual([]);
    expect(qat('select * from "|der Items"').to).toBeUndefined();
    // After a qualifier the names are offered, and the whole quoted name is replaced.
    const c = qat('select * from "My Schema"."|der Items" where 1=1');
    expect(c.from).toBe(26);
    expect(c.to).toBe(37);
    expect(accepted('select * from "My Schema"."|der Items" where 1=1', quotingSchema, "Order Items")).toBe(
      'select * from "My Schema"."Order Items" where 1=1',
    );
    expect(accepted('select o."|xx" from customers o', quotingSchema, "Created At")).toBe(
      'select o."Created At" from customers o',
    );
  });

  test("two quoted names on the line, the cursor in the first and in the second", () => {
    expect(accepted('select "ca|se", "Created At" from customers', quotingSchema, "case")).toBe(
      'select "case", "Created At" from customers',
    );
    expect(accepted('select "ca|xx", "Created At" from customers', quotingSchema, "case")).toBe(
      'select "case", "Created At" from customers',
    );
    expect(accepted('select "case", "Cr|xx At" from customers', quotingSchema, "Created At")).toBe(
      'select "case", "Created At" from customers',
    );
  });

  test("after a qualifier", () => {
    expect(accepted('select * from "My Schema"."Or|der Items"', quotingSchema, "Order Items")).toBe(
      'select * from "My Schema"."Order Items"',
    );
    expect(accepted('select * from "My Schema"."Or|der Items" where 1=1', quotingSchema, "Order Items")).toBe(
      'select * from "My Schema"."Order Items" where 1=1',
    );
  });

  test("a line break after the cursor before any quote: the quote is still open", () => {
    const c = qat('select * from "Or|der\nItems"');
    expect(c.items.map((i) => i.label)).toContain("Order Items");
    expect(c.to).toBeUndefined();
    expect(qat('select * from "Or|der\r\nItems"').to).toBeUndefined();
  });
});

test("inside a quote after a qualifier, only the completed part is written", () => {
  const col = qat('select o."cr| from customers o');
  expect(col.from).toBe(9);
  expect(col.items).toEqual([{ label: "Created At", insert: '"Created At"', kind: "column", detail: "text" }]);
  expect(qat('select o."cr| from customers o where o.id = "x"').items.map((i) => i.label)).toEqual(["Created At"]);
  const nsRel = qat('select * from "My Schema"."ord|');
  expect(nsRel.from).toBe(26);
  expect(nsRel.items.map((i) => [i.label, i.insert])).toEqual([
    ["Order Items", '"Order Items"'],
    ["orders", '"orders"'],
  ]);
});

describe("a double quote directly after the cursor closes the name, whatever follows on the line", () => {
  test("the rows of the reproduction", () => {
    expect(accepted('select * from "Or|", "cus')).toBe('select * from "Order Items", "cus');
    expect(accepted('select * from "Or|" -- 5" pipe')).toBe('select * from "Order Items" -- 5" pipe');
    expect(accepted(`select * from "Or|" where note = 'say "hi'`)).toBe(
      `select * from "Order Items" where note = 'say "hi'`,
    );
    expect(qat('select * from "Or|", "cus').to).toBe(18);
  });

  test("a doubled pair directly after the cursor: the count decides, as before", () => {
    // Three quotes after the cursor (odd): the name closes at the one after the doubled pair.
    expect(qat('"Or|""x"').to).toBe(7);
    // Two quotes after the cursor (even, one doubled pair): the quote is still open.
    expect(qat('"Or|""x').to).toBeUndefined();
  });
});
