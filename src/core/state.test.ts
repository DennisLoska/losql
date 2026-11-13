import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths, type Paths } from "./paths";
import {
  appendHistory, DEFAULT_STATE, HISTORY_LIMIT, keepDamagedBuffers, loadBuffers, loadState, readHistory, readState, saveBuffers, saveState,
  stateWarnings,
} from "./state";

let dir: string;
let paths: Paths;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "losql-state-"));
  paths = resolvePaths({ LOSQL_CONFIG_DIR: join(dir, "c"), LOSQL_STATE_DIR: join(dir, "s") }, dir);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

test("state defaults when the file is missing or broken", async () => {
  expect(await loadState(paths)).toEqual(DEFAULT_STATE);
  expect(DEFAULT_STATE).toEqual({ onboarded: false, lastConnection: null, providerTests: {} });
  await Bun.write(paths.stateFile, "garbage");
  expect(await loadState(paths)).toEqual(DEFAULT_STATE);
});

test("state round-trips", async () => {
  const state = { onboarded: true, lastConnection: "dev", providerTests: { claude: { ok: true, at: "2026-11-11T10:00:00Z", message: "replied in 1.2s" } } };
  await saveState(paths, state);
  expect(await loadState(paths)).toEqual(state);
});

test("history is returned newest first and can be filtered by connection", async () => {
  await appendHistory(paths, { ts: "2026-11-11T10:00:00Z", connection: "a", sql: "select 1", ok: true, rows: 1, ms: 2 });
  await appendHistory(paths, { ts: "2026-11-11T10:00:01Z", connection: "b", sql: "select 2", ok: false, rows: null, ms: 3 });
  await appendHistory(paths, { ts: "2026-11-11T10:00:02Z", connection: "a", sql: "select 3", ok: true, rows: 1, ms: 1 });
  expect((await readHistory(paths)).map((e) => e.sql)).toEqual(["select 3", "select 2", "select 1"]);
  expect((await readHistory(paths, "a")).map((e) => e.sql)).toEqual(["select 3", "select 1"]);
});

test("history skips unreadable lines and is trimmed to the limit", async () => {
  const lines = Array.from({ length: HISTORY_LIMIT + 10 }, (_, i) =>
    JSON.stringify({ ts: "t", connection: "a", sql: `select ${i}`, ok: true, rows: 1, ms: 1 }));
  await Bun.write(paths.historyFile, lines.join("\n") + "\nnot json\n");
  const entries = await readHistory(paths);
  expect(entries.length).toBe(HISTORY_LIMIT);
  expect(entries[0]!.sql).toBe(`select ${HISTORY_LIMIT + 9}`);
  const kept = (await Bun.file(paths.historyFile).text()).trim().split("\n");
  expect(kept.length).toBe(HISTORY_LIMIT);
});

test("buffers round-trip per connection", async () => {
  expect(await loadBuffers(paths, "dev")).toBeNull();
  await saveBuffers(paths, "dev", [{ name: "scratch", path: null, text: "select 1;" }, { name: "a.sql", path: "/tmp/a.sql", text: "" }], 1);
  expect(await loadBuffers(paths, "dev")).toEqual({
    buffers: [{ name: "scratch", path: null, text: "select 1;" }, { name: "a.sql", path: "/tmp/a.sql", text: "" }],
    active: 1,
  });
  expect(await loadBuffers(paths, "other")).toBeNull();
});

test("loadBuffers clamps a bad active to 0 and returns null for an empty list", async () => {
  await saveBuffers(paths, "empty", [], 0);
  expect(await loadBuffers(paths, "empty")).toBeNull();

  const buf = [{ name: "scratch", path: null, text: "select 1;" }];
  for (const badActive of [99, -1, -3.5, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await saveBuffers(paths, "bad", buf, badActive);
    expect(await loadBuffers(paths, "bad")).toEqual({ buffers: buf, active: 0 });
  }
});

test("buffers round-trip safely for special, long, and lone-surrogate connection ids", async () => {
  const { readdir, stat } = await import("node:fs/promises");
  const ids = ["../../evil", "..", "a/b", "é".repeat(300), "x\ud800y"];
  for (const id of ids) {
    const buf = [{ name: "scratch", path: null, text: `select '${id.length}';` }];
    await saveBuffers(paths, id, buf, 0);
    expect(await loadBuffers(paths, id)).toEqual({ buffers: buf, active: 0 });

    const bufferEntries = await readdir(paths.buffersDir);
    expect(bufferEntries.length).toBeGreaterThan(0);
    for (const entry of bufferEntries) {
      expect(entry.endsWith(".json")).toBe(true);
      const st = await stat(join(paths.buffersDir, entry));
      expect(st.isFile()).toBe(true);
    }
    expect(await readdir(dir)).toEqual(["s"]);
    expect(await readdir(paths.stateDir)).toEqual(["buffers"]);
  }
});

test.skipIf(process.getuid?.() === 0)("readHistory returns newest entries even when trimming rewrite fails", async () => {
  const { chmod } = await import("node:fs/promises");
  const lines = Array.from({ length: HISTORY_LIMIT + 5 }, (_, i) =>
    JSON.stringify({ ts: "t", connection: "a", sql: `select ${i}`, ok: true, rows: 1, ms: 1 }));
  await Bun.write(paths.historyFile, lines.join("\n") + "\n");
  await chmod(paths.stateDir, 0o500);
  try {
    const entries = await readHistory(paths);
    expect(entries.length).toBe(HISTORY_LIMIT);
    expect(entries[0]!.sql).toBe(`select ${HISTORY_LIMIT + 4}`);
  } finally {
    await chmod(paths.stateDir, 0o700);
  }
});

describe("final fix 3: a damaged file of saved Buffers", () => {
  const good = [{ name: "a.sql", path: null, text: "select 1" }, { name: "b", path: "/tmp/b.sql", text: "select 2" }];
  const file = () => join(paths.buffersDir, "dev.json");
  const write = async (text: string) => {
    await mkdir(paths.buffersDir, { recursive: true });
    await writeFile(file(), text);
  };
  const damaged = () => ({ file: file(), message: `Some saved buffers in ${file()} could not be read; the file was kept as ${file()}.bad` });

  test("a file that does not exist is not damaged", async () => {
    expect(await loadBuffers(paths, "dev")).toBeNull();
  });

  test("not JSON: no Buffers, damaged", async () => {
    await write("{ not json");
    expect(await loadBuffers(paths, "dev")).toEqual({ buffers: [], active: 0, damaged: damaged() });
  });

  test("JSON of another shape: no Buffers, damaged", async () => {
    for (const text of ["[1, 2]", '{"buffers": "x"}', "null", '"text"', '{"active": 0}']) {
      await write(text);
      expect(await loadBuffers(paths, "dev")).toEqual({ buffers: [], active: 0, damaged: damaged() });
    }
  });

  test("one bad entry among good ones: the good ones are kept, damaged", async () => {
    await write(JSON.stringify({ buffers: [good[0], { name: "c", path: 7, text: "select 3" }, good[1]], active: 2 }));
    expect(await loadBuffers(paths, "dev")).toEqual({ buffers: good, active: 1, damaged: damaged() });
    await write(JSON.stringify({ buffers: [good[0], good[1], { name: 3, path: null, text: "" }], active: 2 }));
    expect(await loadBuffers(paths, "dev")).toEqual({ buffers: good, active: 0, damaged: damaged() });
  });

  test("all entries bad: no Buffers, damaged", async () => {
    await write(JSON.stringify({ buffers: [{ name: "x" }, 4, null], active: 0 }));
    expect(await loadBuffers(paths, "dev")).toEqual({ buffers: [], active: 0, damaged: damaged() });
  });

  test("an empty file: no Buffers, damaged", async () => {
    await write("");
    expect(await loadBuffers(paths, "dev")).toEqual({ buffers: [], active: 0, damaged: damaged() });
  });

  test("a directory in the file's place: no Buffers, damaged", async () => {
    await mkdir(file(), { recursive: true });
    expect(await loadBuffers(paths, "dev")).toEqual({ buffers: [], active: 0, damaged: damaged() });
  });

  test("a valid file is not damaged, and a saved empty list is still no Buffers", async () => {
    await saveBuffers(paths, "dev", good, 1);
    expect(await loadBuffers(paths, "dev")).toEqual({ buffers: good, active: 1 });
    await saveBuffers(paths, "dev", [], 0);
    expect(await loadBuffers(paths, "dev")).toBeNull();
  });

  test("keepDamagedBuffers keeps the original as .bad with mode 0600, replacing an older .bad file", async () => {
    await write("{ damaged");
    await writeFile(`${file()}.bad`, "older");
    await chmod(file(), 0o644);
    await keepDamagedBuffers(paths, "dev");
    expect(await readFile(`${file()}.bad`, "utf8")).toBe("{ damaged");
    expect((await stat(`${file()}.bad`)).mode & 0o777).toBe(0o600);
    expect(await Bun.file(file()).exists()).toBe(false);
    // Nothing there: nothing to keep.
    await keepDamagedBuffers(paths, "dev");
    expect(await readFile(`${file()}.bad`, "utf8")).toBe("{ damaged");
  });
});

describe("final-c2 fix 3: a bad state file gives a warning and is kept before it is written again", () => {
  const write = async (text: string) => {
    await mkdir(paths.stateDir, { recursive: true });
    await writeFile(paths.stateFile, text);
  };

  const fileLevel: [string, string][] = [
    ["not JSON", "garbage{"],
    ["an array", "[1, 2]"],
    ["null", "null"],
    ["a number", "42"],
  ];
  for (const [name, text] of fileLevel) {
    test(`${name}: the defaults and one warning naming the file; the file is left alone`, async () => {
      await write(text);
      const read = await readState(paths);
      expect(read.state).toEqual(DEFAULT_STATE);
      expect(read.warnings.length).toBe(1);
      expect(read.warnings[0]).toContain(paths.stateFile);
      expect(await readFile(paths.stateFile, "utf8")).toBe(text);

      const state = await loadState(paths);
      expect(state).toEqual(DEFAULT_STATE);
      expect(stateWarnings(state)).toEqual(read.warnings);
    });
  }

  test("wrong types of single keys: the readable keys are kept, one warning names the file and the keys", async () => {
    await write(JSON.stringify({
      onboarded: "yes",
      lastConnection: "dev",
      providerTests: { claude: { ok: "no" }, codex: { ok: true, at: "t", message: "m" } },
    }));
    const read = await readState(paths);
    expect(read.state).toEqual({ onboarded: false, lastConnection: "dev", providerTests: { codex: { ok: true, at: "t", message: "m" } } });
    expect(read.warnings.length).toBe(1);
    expect(read.warnings[0]).toContain(paths.stateFile);
    expect(read.warnings[0]).toContain("onboarded");
    expect(read.warnings[0]).toContain("providerTests");
    expect(read.warnings[0]).not.toContain("lastConnection");

    await write(JSON.stringify({ onboarded: true, lastConnection: 7, providerTests: [] }));
    const second = await readState(paths);
    expect(second.state).toEqual({ onboarded: true, lastConnection: null, providerTests: {} });
    expect(second.warnings[0]).toContain("lastConnection");
    expect(second.warnings[0]).toContain("providerTests");
  });

  test("a directory in the file's place: the defaults and a warning", async () => {
    await mkdir(paths.stateFile, { recursive: true });
    const read = await readState(paths);
    expect(read.state).toEqual(DEFAULT_STATE);
    expect(read.warnings.length).toBe(1);
    expect(read.warnings[0]).toContain(paths.stateFile);
  });

  test.skipIf(process.getuid?.() === 0)("an unreadable file: the defaults and a warning; the file is left alone", async () => {
    await write(JSON.stringify({ onboarded: true, lastConnection: "dev", providerTests: {} }));
    await chmod(paths.stateFile, 0o000);
    try {
      const read = await readState(paths);
      expect(read.state).toEqual(DEFAULT_STATE);
      expect(read.warnings.length).toBe(1);
      expect(read.warnings[0]).toContain(paths.stateFile);
      expect((await stat(paths.stateFile)).mode & 0o777).toBe(0);
    } finally {
      await chmod(paths.stateFile, 0o600);
    }
  });

  test("a missing file, a good file and a file without some keys give no warning", async () => {
    expect((await readState(paths)).warnings).toEqual([]);
    await saveState(paths, { onboarded: true, lastConnection: null, providerTests: {} });
    expect((await readState(paths)).warnings).toEqual([]);
    await write(JSON.stringify({ onboarded: true }));
    expect((await readState(paths)).warnings).toEqual([]);
  });

  test("the first save after loading a damaged file keeps the original beside it as state.json.bad (0600)", async () => {
    await write("garbage{");
    await loadState(paths);
    expect(await readFile(paths.stateFile, "utf8")).toBe("garbage{");
    await saveState(paths, { onboarded: true, lastConnection: "dev", providerTests: {} });
    expect(await readFile(`${paths.stateFile}.bad`, "utf8")).toBe("garbage{");
    expect((await stat(`${paths.stateFile}.bad`)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(paths.stateFile, "utf8")).lastConnection).toBe("dev");

    // A later save does not replace the kept original.
    await saveState(paths, { onboarded: true, lastConnection: "other", providerTests: {} });
    expect(await readFile(`${paths.stateFile}.bad`, "utf8")).toBe("garbage{");
  });

  test("a save after loading a good file keeps nothing", async () => {
    await saveState(paths, DEFAULT_STATE);
    await loadState(paths);
    await saveState(paths, { ...DEFAULT_STATE, onboarded: true });
    expect(await Bun.file(`${paths.stateFile}.bad`).exists()).toBe(false);
  });

  test.skipIf(process.getuid?.() === 0)("an unreadable file is kept as .bad with mode 0600 before the first save", async () => {
    const original = JSON.stringify({ onboarded: true, lastConnection: "dev", providerTests: {} });
    await write(original);
    await chmod(paths.stateFile, 0o000);
    await loadState(paths);
    await saveState(paths, DEFAULT_STATE);
    expect((await stat(`${paths.stateFile}.bad`)).mode & 0o777).toBe(0o600);
    expect(await readFile(`${paths.stateFile}.bad`, "utf8")).toBe(original);
  });
});

describe("final-c2 fix 6: the history file is capped where it is written", () => {
  const entry = (i: number) => ({ ts: "2026-11-13T10:00:00Z", connection: "a", sql: `select ${i}`, ok: true, rows: 1, ms: 1 });
  const fileLines = async () => (await readFile(paths.historyFile, "utf8")).split("\n").filter((l) => l.trim() !== "");

  test("6,000 appends leave between 5,000 and 5,500 lines, the newest last, and the file keeps mode 0600", async () => {
    for (let i = 0; i < 6000; i++) {
      await appendHistory(paths, entry(i));
    }
    const lines = await fileLines();
    expect(lines.length).toBeGreaterThanOrEqual(HISTORY_LIMIT);
    expect(lines.length).toBeLessThanOrEqual(HISTORY_LIMIT + 500);
    expect(JSON.parse(lines[lines.length - 1]!).sql).toBe("select 5999");
    expect((await stat(paths.historyFile)).mode & 0o777).toBe(0o600);
  }, 30_000);

  test("appends started together are capped as well", async () => {
    await Promise.all(Array.from({ length: 6000 }, (_, i) => appendHistory(paths, entry(i))));
    const lines = await fileLines();
    expect(lines.length).toBeGreaterThanOrEqual(HISTORY_LIMIT);
    expect(lines.length).toBeLessThanOrEqual(HISTORY_LIMIT + 500);
    expect(JSON.parse(lines[lines.length - 1]!).sql).toBe("select 5999");
  }, 30_000);

  test("200 appends racing with 50 reads lose nothing", async () => {
    // A file near the cap, so that trims happen while the appends and reads run.
    await mkdir(paths.stateDir, { recursive: true });
    await writeFile(
      paths.historyFile,
      Array.from({ length: HISTORY_LIMIT + 450 }, (_, i) => JSON.stringify({ ...entry(i), connection: "old" })).join("\n") + "\n",
      { mode: 0o600 },
    );
    const work: Promise<unknown>[] = [];
    for (let i = 0; i < 200; i++) {
      work.push(appendHistory(paths, { ...entry(i), connection: "new" }));
      if (i % 4 === 0) work.push(readHistory(paths));
    }
    await Promise.all(work);
    const sqls = new Set((await fileLines()).map((l) => JSON.parse(l)).filter((e) => e.connection === "new").map((e) => e.sql));
    for (let i = 0; i < 200; i++) {
      expect(sqls.has(`select ${i}`)).toBe(true);
    }
    const lines = await fileLines();
    expect(lines.length).toBeLessThanOrEqual(HISTORY_LIMIT + 500);
    expect((await readHistory(paths)).length).toBe(Math.min(HISTORY_LIMIT, lines.length));
  }, 30_000);

  test("a file with a damaged line is kept as it is by appends, and the line is skipped when read", async () => {
    await mkdir(paths.stateDir, { recursive: true });
    await writeFile(paths.historyFile, `${JSON.stringify(entry(1))}\nnot json\n`, { mode: 0o600 });
    await appendHistory(paths, entry(2));
    expect(await readFile(paths.historyFile, "utf8")).toBe(`${JSON.stringify(entry(1))}\nnot json\n${JSON.stringify(entry(2))}\n`);
    expect((await readHistory(paths)).map((e) => e.sql)).toEqual(["select 2", "select 1"]);
  });
});
