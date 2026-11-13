import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandEnv } from "../../core/config";
import type { Connection } from "../../core/db/types";
import { mount, type MountOptions, type TestApp } from "../testing";
import { connectionChoices, displayUrl, findSqliteFiles, openConnections } from "./connections";

let app: TestApp;
afterEach(async () => { await app?.dispose(); });

const savedConfig = async () => JSON.parse(await Bun.file(app.deps.paths.configFile).text());
const connected = (id: string) => app.waitFor(() => app.api.session.connection()?.id === id);

describe("building the list", () => {
  test("displayUrl hides passwords", () => {
    expect(displayUrl("postgres://app:s3cret@db.example.com/shop")).toBe("postgres://app@db.example.com:5432/shop");
    expect(displayUrl("postgres://app:${PGPASSWORD}@localhost/dev")).toBe("postgres://app@localhost:5432/dev");
    expect(displayUrl("demo")).toBe("demo");
    expect(displayUrl("not a url at all")).toBe("not a url at all");
  });

  test("findSqliteFiles lists database files of the directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "losql-files-"));
    await mkdir(join(dir, "sub"));
    for (const name of ["b.sqlite3", "a.db", "notes.txt", "c.SQLITE", "d.db3", "sub/e.db"]) await Bun.write(join(dir, name), "");
    expect(await findSqliteFiles(dir)).toEqual(["a.db", "b.sqlite3", "c.SQLITE", "d.db3"]);
    expect(await findSqliteFiles(join(dir, "missing"))).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  test("connectionChoices orders saved, detected and other entries", () => {
    const choices = connectionChoices({
      saved: [{ name: "dev", url: "postgres://app:pw@localhost/dev" }],
      env: { DATABASE_URL: "postgres://u:pw@h/prod" },
      files: ["app.db"],
    });
    expect(choices.map((c) => [c.category, c.kind, c.title, c.target])).toEqual([
      ["Saved", "saved", "dev", "dev"],
      ["Detected", "env", "DATABASE_URL", "postgres://u:pw@h/prod"],
      ["Detected", "file", "app.db", "app.db"],
      ["Other", "enter", "Enter a URL or file path", null],
      ["Other", "demo", "Explore the demo database", "demo"],
    ]);
    expect(choices.map((c) => c.description).join(" ")).not.toContain("pw");
    expect(choices[0]!.description).toBe("postgres://app@localhost:5432/dev");
    expect(connectionChoices({ saved: [], env: { DATABASE_URL: "" }, files: [] }).map((c) => c.kind)).toEqual(["enter", "demo"]);
  });
});

describe("the Connections dialog", () => {
  const start = async (options: MountOptions = {}) => {
    app = await mount({ connection: null, ...options });
  };

  test("opens at start when there is no Connection", async () => {
    await start();
    expect(app.api.dialog.depth()).toBe(1);
    for (const text of ["Connections", "Enter a URL or file path", "Explore the demo database"]) expect(app.frame()).toContain(text);
  });

  test("the demo database can be opened", async () => {
    await start();
    await app.press("demo<CR>");
    await connected("demo");
    expect(app.api.dialog.depth()).toBe(0);
    expect(app.frame()).toContain("demo · sqlite");
  });

  test("Escape leaves the application without a Connection", async () => {
    await start();
    await app.press("<Esc>");
    expect(app.api.dialog.depth()).toBe(0);
    expect(app.api.session.status()).toBe("none");
  });

  test("saved Connections are listed without their password and can be opened", async () => {
    await start({ config: { connections: [{ name: "shop", url: "demo" }, { name: "prod", url: "postgres://app:hunter2@db/prod" }] } });
    expect(app.frame()).toContain("shop");
    expect(app.frame()).toContain("postgres://app@db:5432/prod");
    expect(app.frame()).not.toContain("hunter2");
    await app.press("shop<CR>");
    await app.waitFor(() => app.api.session.connection()?.name === "shop");
    expect(app.api.dialog.depth()).toBe(0);
  });

  test("a failed connection shows the message and keeps the dialog open", async () => {
    await start({ config: { connections: [{ name: "broken", url: "/nonexistent/dir/x.db" }] } });
    await app.press("broken<CR>");
    await app.waitFor(() => app.frame().includes("no such file"));
    expect(app.api.dialog.depth()).toBe(1);
    expect(app.api.session.status()).toBe("none");
    await app.press("<C-u>demo<CR>");
    await connected("demo");
  });

  test("SQLite files of the working directory are offered", async () => {
    await start({
      seed: async (deps) => {
        const db = new Database(join(deps.cwd, "app.db"));
        db.run("create table t (a integer)");
        db.close();
      },
    });
    expect(app.frame()).toContain("app.db");
    await app.press("app.db<CR>");
    await app.waitFor(() => app.api.session.connection()?.name === "app.db");
    expect(app.api.session.connection()!.display).toBe(join(app.deps.cwd, "app.db"));
  });

  test("entering a URL connects and offers to save it", async () => {
    await start();
    await app.press("enter<CR>");
    expect(app.frame()).toContain("URL or file path");
    await app.press("ftp://nope<CR>");
    await app.waitFor(() => app.frame().includes("unsupported connection"));
    await app.press("<C-u>:memory:<CR>");
    await connected("memory");
    expect(app.frame()).toContain("Save this connection?");
    await app.press("scratchpad<CR>");
    await app.waitFor(() => app.api.dialog.depth() === 0);
    expect((await savedConfig()).connections).toEqual([{ name: "scratchpad", url: ":memory:" }]);
  });

  test("an empty name skips saving", async () => {
    await start();
    await app.press("enter<CR>");
    await app.press(":memory:<CR>");
    await connected("memory");
    await app.press("<CR>");
    await app.waitFor(() => app.api.dialog.depth() === 0);
    expect(app.api.config.config().connections).toEqual([]);
  });

  test("ctrl+d deletes a saved Connection after confirmation", async () => {
    await start({ config: { connections: [{ name: "shop", url: "demo" }, { name: "other", url: ":memory:" }] } });
    await app.press("<C-d>");
    expect(app.frame()).toContain('Delete "shop"?');
    await app.press("n");
    expect(app.api.config.config().connections.length).toBe(2);
    await app.press("<C-d>y");
    await app.waitFor(() => app.api.config.config().connections.length === 1);
    expect(app.api.config.config().connections[0]!.name).toBe("other");
    expect(app.api.dialog.depth()).toBe(1);
    expect(app.frame()).not.toContain("shop");
  });

  test("ctrl+e edits a saved Connection", async () => {
    await start({ config: { connections: [{ name: "shop", url: "demo" }] } });
    await app.press("<C-e>");
    expect(app.frame()).toContain("Name");
    await app.press("2<CR>");
    expect(app.frame()).toContain("URL or file path");
    await app.press("<C-u>:memory:<CR>");
    await app.waitFor(() => app.api.config.config().connections[0]?.url === ":memory:");
    expect(app.api.config.config().connections).toEqual([{ name: "shop2", url: ":memory:" }]);
    expect(app.api.session.status()).toBe("none");
  });

  test("ctrl+d and ctrl+e do nothing on entries that are not saved", async () => {
    await start();
    await app.press("demo<C-d><C-e>");
    expect(app.api.dialog.depth()).toBe(1);
  });
});

describe("opening it later", () => {
  test("the Leader, :connections and :connect without an argument open it and mark the current Connection", async () => {
    app = await mount({ config: { connections: [{ name: "shop", url: "demo" }] }, connection: "shop", deps: { env: { DATABASE_URL: "postgres://u:pw@h/prod" } } });
    await app.waitFor(() => app.api.session.status() === "connected");
    expect(app.api.dialog.depth()).toBe(0);
    await app.press("<Space>c");
    expect(app.frame()).toContain("Connections");
    expect(app.frame()).toContain("●");
    expect(app.frame()).toContain("DATABASE_URL");
    expect(app.frame()).not.toContain("u:pw");
    await app.press("<Esc>:connections<CR>");
    expect(app.api.dialog.depth()).toBe(1);
    await app.press("<Esc>:connect<CR>");
    expect(app.api.dialog.depth()).toBe(1);
  });

  test("environment secrets in saved Connections never appear in choices, list, edit, delete or failed connect", async () => {
    const env = { PGPASSWORD: "hunter2", DATABASE_URL: "postgres://u:hunter2@h/d" };
    const saved = [
      { name: "valid", url: "postgres://app:${PGPASSWORD}@db/x" },
      { name: "nohost", url: "postgres://app:${PGPASSWORD}" },
      { name: "bare", url: "app:${PGPASSWORD}" },
      { name: "fullenv", url: "${DATABASE_URL}" },
    ];
    const choices = connectionChoices({ saved, env, files: [] });
    for (const c of choices) {
      expect(c.title).not.toContain("hunter2");
      expect(c.description).not.toContain("hunter2");
      if (c.kind === "saved") {
        expect(c.target ?? "").not.toContain("hunter2");
      }
    }
    expect(choices.find((c) => c.title === "nohost")?.description).toBe("postgres://app:${PGPASSWORD}");
    expect(choices.find((c) => c.title === "bare")?.description).toBe("app:${PGPASSWORD}");
    expect(choices.find((c) => c.title === "fullenv")?.description).toBe("${DATABASE_URL}");

    // A connect fails at once, as one to a host that does not resolve would: no host name is looked
    // up. Its error holds the full URL with the secret, as a Driver, a wrapper or a library might
    // write it; the Session hides the password before the message reaches the dialog.
    const tried: string[] = [];
    const openSession = async (connection: Connection): Promise<never> => {
      const url = expandEnv(connection.url, env);
      tried.push(url);
      throw new Error(`could not connect to ${url}: getaddrinfo ENOTFOUND`);
    };
    app = await mount({
      connection: null,
      config: { connections: saved },
      deps: { env, openSession },
    });
    // At start the application connects to DATABASE_URL by itself; it opens the dialog once that failed.
    await app.waitFor(() => tried.length === 1 && app.api.dialog.depth() === 1 && app.frame().includes("nohost"));
    expect(app.frame()).not.toContain("hunter2");

    // Edit prompt on nohost
    await app.press("<C-n><C-e>");
    expect(app.frame()).toContain("Name");
    expect(app.frame()).not.toContain("hunter2");
    await app.press("<CR>");
    expect(app.frame()).toContain("URL or file path");
    expect(app.frame()).toContain("postgres://app:${PGPASSWORD}");
    expect(app.frame()).not.toContain("hunter2");
    await app.press("<Esc>");

    // Delete prompt on nohost
    await app.press("<C-d>");
    expect(app.frame()).toContain('Delete "nohost"?');
    expect(app.frame()).not.toContain("hunter2");
    await app.press("n");

    // Failed connect on nohost, bare, fullenv, valid
    for (const name of ["nohost", "bare", "fullenv", "valid"]) {
      await app.press(`<C-u>${name}<CR>`);
      await app.waitFor(() => app.frame().includes("unsupported") || app.frame().includes("connect") || app.frame().includes("failed") || app.frame().includes("ECONNREFUSED") || app.frame().includes("ENOTFOUND") || app.frame().includes("error") || app.frame().includes("postgres"));
      expect(app.frame()).not.toContain("hunter2");
    }
    // Each connect that reached the Driver had the secret in its URL.
    expect(tried.length).toBeGreaterThan(1);
    for (const url of tried) expect(url).toContain("hunter2");
  });

  test("renaming one of two hand-written entries a and \" a\" to a is refused and the file is unchanged", async () => {
    const initial = [
      { name: "a", url: "demo" },
      { name: " a", url: ":memory:" },
    ];
    app = await mount({ connection: null, config: { connections: initial } });
    const initialFileText = await Bun.file(app.deps.paths.configFile).text();
    await app.waitFor(() => app.api.dialog.depth() === 1);
    // The second entry is the one with the leading space.
    await app.press("<C-n><C-e>");
    expect(app.frame()).toContain("Name");
    await app.press("<C-u>a<CR>");
    await app.waitFor(() => app.frame().includes('A connection named "a" already exists'));
    expect(app.api.config.config().connections).toEqual(initial);
    expect(await Bun.file(app.deps.paths.configFile).text()).toBe(initialFileText);
  });

  test("saving under a name that is already taken is refused for add and rename, while keeping own name works", async () => {
    const initial = [
      { name: "shop", url: "demo" },
      { name: "analytics", url: ":memory:" },
    ];
    app = await mount({
      connection: null,
      config: { connections: initial },
    });
    const initialFileText = await Bun.file(app.deps.paths.configFile).text();

    // 1. Add with an already-taken name ("  shop  ") -> refused, prompt stays open with typed text
    await app.press("enter<CR>");
    await app.press(":memory:<CR>");
    await connected("memory");
    expect(app.frame()).toContain("Save this connection?");
    await app.press("  shop  <CR>");
    await app.waitFor(() => app.frame().includes('A connection named "shop" already exists'));
    expect(app.frame()).toContain("Save this connection?");
    expect(app.frame()).toContain("  shop  ");
    expect(app.api.config.config().connections).toEqual(initial);
    expect(await Bun.file(app.deps.paths.configFile).text()).toBe(initialFileText);
    // Cancel saving and reopen Connections dialog
    await app.press("<Esc>");
    await app.waitFor(() => app.api.dialog.depth() === 0);

    await app.press("<Space>c");
    expect(app.api.dialog.depth()).toBe(1);

    // 2. Rename "shop" onto "analytics" -> refused, prompt stays open with typed text
    await app.press("<C-e>");
    expect(app.frame()).toContain("Name");
    await app.press("<C-u> analytics <CR>");
    await app.waitFor(() => app.frame().includes('A connection named "analytics" already exists'));
    expect(app.frame()).toContain("Name");
    expect(app.frame()).toContain(" analytics ");
    expect(app.api.config.config().connections).toEqual(initial);
    expect(await Bun.file(app.deps.paths.configFile).text()).toBe(initialFileText);

    // 3. Keeping "shop"'s own name while changing its URL works
    await app.press("<C-u>shop<CR>");
    expect(app.frame()).toContain("URL or file path");
    await app.press("<C-u>:memory:<CR>");
    await app.waitFor(() => app.api.config.config().connections[0]?.url === ":memory:");
    expect(app.api.config.config().connections).toEqual([
      { name: "shop", url: ":memory:" },
      { name: "analytics", url: ":memory:" },
    ]);
  });

  test("a name longer than 64 characters or with control characters is refused, and existing bad names are listed safely and can be connected, edited and deleted", async () => {
    const longExisting = `long_${"a".repeat(70)}`;
    const ctrlExisting = "bad\x07\nname";
    const urlExisting = "postgres://admin:supersecret@db.internal/prod";
    const saved = [
      { name: urlExisting, url: "demo" },
      { name: ctrlExisting, url: ":memory:" },
      { name: longExisting, url: "demo" },
    ];

    const choices = connectionChoices({ saved, env: {}, files: [] });
    expect(choices[0]!.title).toBe("postgres://admin@db.internal/prod");
    expect(choices[0]!.title).not.toContain("supersecret");
    expect(choices[0]!.target).toBe(urlExisting);
    expect(choices[1]!.title).toBe("bad\ufffd name");
    expect(choices[1]!.target).toBe(ctrlExisting);

    app = await mount({
      connection: null,
      config: { connections: saved },
    });
    expect(app.frame()).not.toContain("supersecret");
    expect(app.frame()).toContain("postgres://admin@db.internal/prod");

    // Existing saved Connection with URL-with-password name can be connected to
    await app.press("<CR>");
    await app.waitFor(() => app.api.session.status() === "connected");
    expect(app.api.dialog.depth()).toBe(0);

    // Reopen Connections dialog
    await app.press("<Space>c");
    expect(app.api.dialog.depth()).toBe(1);

    // Try adding with > 64 chars and with control char
    await app.press("enter<CR>");
    await app.press(":memory:<CR>");
    await connected("memory");
    expect(app.frame()).toContain("Save this connection?");
    await app.press(`${"x".repeat(65)}<CR>`);
    await app.waitFor(() => app.frame().includes("A name can have at most 64 characters"));
    expect(app.frame()).toContain("Save this connection?");
    app.api.keys.paste("has\nnewline");
    await app.press("<CR>");
    await app.press("<C-u>");
    // Test control char via edit initial or direct validate on edit
    await app.press("<Esc>");
    await app.waitFor(() => app.api.dialog.depth() === 0);

    await app.press("<Space>c");
    // Move to ctrlExisting (second saved entry, after urlExisting which is current)
    await app.press("<C-n><C-e>");
    expect(app.frame()).toContain("Name");
    // Submit initial name which has \x07\n -> refused with control characters notice
    await app.press("<CR>");
    await app.waitFor(() => app.frame().includes("A name cannot contain control characters"));
    expect(app.frame()).toContain("Name");
    // Type a 65-char name -> refused with 64 characters notice
    await app.press(`<C-u>${"y".repeat(65)}<CR>`);
    await app.waitFor(() => app.frame().includes("A name can have at most 64 characters"));
    // Type a valid 64-char name -> succeeds
    const valid64 = "z".repeat(64);
    await app.press(`<C-u>${valid64}<CR>`);
    expect(app.frame()).toContain("URL or file path");
    await app.press("<CR>");
    await app.waitFor(() => app.api.config.config().connections[1]?.name === valid64);

    // Delete longExisting (filter to it, then <C-d>)
    await app.press("long_<C-d>");
    expect(app.frame()).toContain("Delete");
    await app.press("y");
    await app.waitFor(() => app.api.config.config().connections.length === 2);
    expect(app.api.config.config().connections.map((c) => c.name)).toEqual([urlExisting, valid64]);
  });

  test("uses 'Could not save config: <reason>' when saving fails on add", async () => {
    app = await mount({ connection: null });
    app.api.config.set = () => Promise.reject(new Error("disk is full"));
    await app.press("enter<CR>");
    await app.press(":memory:<CR>");
    await connected("memory");
    await app.press("scratchpad<CR>");
    await app.waitFor(() => app.api.dialog.depth() === 0);
    expect(app.api.toast.items().some((t) => t.message === "Could not save config: disk is full")).toBe(true);
  });
});

describe("Task 22 review: the Connections dialog", () => {
  test("openConnections returns the first call's promise while the dialog is open", async () => {
    app = await mount();
    const p1 = openConnections(app.api);
    const p2 = openConnections(app.api);
    expect(p2).toBe(p1);
    await app.settle();
    expect(app.api.dialog.depth()).toBe(1);
    await app.press(":connections<CR>");
    expect(app.api.dialog.depth()).toBe(1);
    await app.press("<Esc>");
    expect(await p1).toBe(false);
    expect(app.api.dialog.depth()).toBe(0);
    const p3 = openConnections(app.api);
    expect(p3).not.toBe(p1);
    await app.settle();
    expect(app.api.dialog.depth()).toBe(1);
  });

  const dupConfig = {
    connections: [
      { name: "dup", url: ":memory:" },
      { name: "dup", url: "demo" },
      { name: "z", url: ":memory:" },
    ],
  };

  test("deleting the second of two Connections with one name keeps the first", async () => {
    app = await mount({ connection: null, config: dupConfig });
    await app.press("<C-n><C-d>");
    expect(app.frame()).toContain('Delete "dup"?');
    await app.press("y");
    await app.waitFor(() => app.api.config.config().connections.length === 2);
    expect(app.api.config.config().connections).toEqual([
      { name: "dup", url: ":memory:" },
      { name: "z", url: ":memory:" },
    ]);
    expect((await savedConfig()).connections).toEqual([
      { name: "dup", url: ":memory:" },
      { name: "z", url: ":memory:" },
    ]);
  });

  test("editing the second of two Connections with one name changes only its URL", async () => {
    app = await mount({ connection: null, config: dupConfig });
    await app.press("<C-n><C-e>");
    expect(app.frame()).toContain("Name");
    await app.press("<CR>");
    expect(app.frame()).toContain("URL or file path");
    expect(app.frame()).toContain("> demo");
    await app.press("<C-u>other.db<CR>");
    await app.waitFor(() => app.api.config.config().connections[1]?.url === "other.db");
    expect(app.api.config.config().connections).toEqual([
      { name: "dup", url: ":memory:" },
      { name: "dup", url: "other.db" },
      { name: "z", url: ":memory:" },
    ]);
  });

  test("connecting to the second of two Connections with one name uses its URL", async () => {
    app = await mount({ connection: null, config: dupConfig });
    await app.press("<C-n><CR>");
    await connected("demo");
    expect(app.api.dialog.depth()).toBe(0);
  });

  test("the first of two Connections with one name is still reached by its name", async () => {
    app = await mount({ connection: null, config: dupConfig });
    await app.press("<CR>");
    await app.waitFor(() => app.api.session.connection()?.name === "dup");
    expect(app.api.session.connection()?.id).not.toBe("demo");
    expect(app.frame()).toContain("No tables");
  });

  test("the name limit counts characters, not code units", async () => {
    app = await mount({ connection: null });
    await app.press("enter<CR>");
    await app.press(":memory:<CR>");
    await connected("memory");
    expect(app.frame()).toContain("Save this connection?");
    app.api.keys.paste("😀".repeat(65));
    await app.press("<CR>");
    await app.waitFor(() => app.frame().includes("A name can have at most 64 characters"));
    await app.press("<C-u>");
    app.api.keys.paste("😀".repeat(64));
    await app.press("<CR>");
    await app.waitFor(() => app.api.dialog.depth() === 0);
    expect(app.api.config.config().connections).toEqual([{ name: "😀".repeat(64), url: ":memory:" }]);
  });
});

test("the Connections dialog draws its rows at its own width from the first frame", async () => {
  app = await mount({
    width: 140,
    height: 40,
    connection: "demo",
    config: { connections: [{ name: "warehouse", url: "postgres://reporting@analytics-warehouse.internal.example.com:6543/quarterly_reporting" }] },
  });
  const rowsOf = (frame: string) => frame.split("\n").filter((l) => l.includes("warehouse") || l.includes("Enter a URL"));
  void openConnections(app.api);
  await app.setup.renderOnce();
  const first = rowsOf(app.frame());
  await app.settle();
  expect(first.length).toBe(2);
  expect(first).toEqual(rowsOf(app.frame()));
});
