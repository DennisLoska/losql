import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeClaude } from "../core/agent/testing";
import { type CliDeps, runAsk } from "./commands";

let dir: string;
let dbFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "losql-ask-"));
  dbFile = join(dir, "shop.db");
  const db = new Database(dbFile);
  db.run("create table orders (id integer primary key, note text)");
  for (let i = 1; i <= 12; i++) db.run("insert into orders (id, note) values (?, ?)", [i, `order ${i}`]);
  db.close();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const orderCount = () => {
  const db = new Database(dbFile, { readonly: true });
  const n = (db.query("select count(*) as n from orders").get() as { n: number }).n;
  db.close();
  return n;
};

async function ask(reply: string, run: boolean): Promise<{ code: number; stdout: string; stderr: string }> {
  const fake = fakeClaude([reply]);
  let stdout = "";
  let stderr = "";
  const deps: CliDeps = {
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    stdin: async () => "",
    env: { LOSQL_CONFIG_DIR: join(dir, "config"), LOSQL_STATE_DIR: join(dir, "state") },
    home: dir,
    cwd: dir,
    exec: fake.exec,
    which: fake.which,
  };
  const code = await runAsk({ kind: "ask", connection: dbFile, provider: "claude", run, question: "q" }, deps);
  return { code, stdout, stderr };
}

describe("ask: the SQL of a reply is printed and run as the database reads it", () => {
  for (const [name, sep] of [
    ["a U+2028", "\u2028"],
    ["a U+2029", "\u2029"],
    ["a lone CR", "\r"],
  ] as const) {
    test(`${name} in the SQL is a line break in the output, and --run filters by the where clause`, async () => {
      const del = await ask(
        JSON.stringify({ action: "answer", message: "Remove one.", sql: `delete from orders -- cleanup${sep}where id = 1` }),
        false,
      );
      expect(del.code).toBe(0);
      expect(del.stdout).toBe("delete from orders -- cleanup\nwhere id = 1\n");

      // ask --run runs read-only, so a delete is refused by the database and nothing changes.
      await expect(
        ask(
          JSON.stringify({ action: "answer", message: "Remove one.", sql: `delete from orders -- cleanup${sep}where id = 1` }),
          true,
        ),
      ).rejects.toThrow("readonly");
      expect(orderCount()).toBe(12);

      // A read shows that the where clause after the separator is code, not part of the comment.
      const read = await ask(
        JSON.stringify({ action: "answer", message: "One.", sql: `select count(*) as n from orders -- note${sep}where id = 1` }),
        true,
      );
      expect(read.code).toBe(0);
      expect(read.stdout).toBe("select count(*) as n from orders -- note\nwhere id = 1\n n \n---\n 1 \n(1 row)\n");
    });
  }
});
