import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, expandEnv, loadConfig, parseConfig, saveConfig } from "./config";
import { resolvePaths, type Paths } from "./paths";

describe("parseConfig", () => {
  test("an empty object yields the defaults", () => {
    expect(parseConfig({})).toEqual({ config: DEFAULT_CONFIG, warnings: [] });
  });

  test("defaults", () => {
    expect(DEFAULT_CONFIG).toEqual({
      theme: "tokyonight", mode: "dark", transparent: false, animations: true, leader: "space",
      connections: [],
      results: { maxRows: 1000, jsonMaxRows: 200, peekRows: 100 },
      agent: { provider: null, model: null, dataAccess: "rows", maxSteps: 8, stepTimeoutMs: 120000 },
    });
  });

  test("valid values are kept", () => {
    const { config, warnings } = parseConfig({
      theme: "nord", mode: "light", transparent: true, animations: false,
      connections: [{ name: "dev", url: "postgres://localhost/dev" }],
      results: { maxRows: 50 },
      agent: { provider: "codex", model: "gpt", dataAccess: "schema", maxSteps: 3 },
    });
    expect(warnings).toEqual([]);
    expect(config.theme).toBe("nord");
    expect(config.mode).toBe("light");
    expect(config.transparent).toBe(true);
    expect(config.animations).toBe(false);
    expect(config.connections).toEqual([{ name: "dev", url: "postgres://localhost/dev" }]);
    expect(config.results).toEqual({ maxRows: 50, jsonMaxRows: 200, peekRows: 100 });
    expect(config.agent).toEqual({ provider: "codex", model: "gpt", dataAccess: "schema", maxSteps: 3, stepTimeoutMs: 120000 });
  });

  test("invalid values fall back and warn", () => {
    const { config, warnings } = parseConfig({
      mode: "sepia", transparent: "yes", results: { maxRows: -1 },
      agent: { provider: "copilot" }, connections: [{ name: "x" }, "nope"],
    });
    expect(config.mode).toBe("dark");
    expect(config.transparent).toBe(false);
    expect(config.results.maxRows).toBe(1000);
    expect(config.agent.provider).toBeNull();
    expect(config.connections).toEqual([]);
    expect(warnings).toEqual([
      'config: "mode" must be "dark" or "light"',
      'config: "transparent" must be true or false',
      'config: "connections[0]" needs a name and a url',
      'config: "connections[1]" needs a name and a url',
      'config: "results.maxRows" must be a positive integer',
      'config: "agent.provider" must be one of claude, codex, opencode, antigravity',
    ]);
  });

  test("a non-object is replaced by the defaults with a warning", () => {
    expect(parseConfig([1, 2])).toEqual({ config: DEFAULT_CONFIG, warnings: ["config: expected a JSON object"] });
  });
});

describe("loadConfig and saveConfig", () => {
  let dir: string;
  let paths: Paths;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "losql-config-"));
    paths = resolvePaths({ LOSQL_CONFIG_DIR: join(dir, "c"), LOSQL_STATE_DIR: join(dir, "s") }, dir);
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test("a missing file yields the defaults", async () => {
    const loaded = await loadConfig(paths);
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(loaded.warnings).toEqual([]);
    expect(loaded.raw).toEqual({});
  });

  test("malformed JSON yields the defaults and a warning, and the file is left alone", async () => {
    await Bun.write(paths.configFile, "{ not json");
    const loaded = await loadConfig(paths);
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(loaded.warnings).toEqual(["config: could not parse config.json; using defaults"]);
    expect(await Bun.file(paths.configFile).text()).toBe("{ not json");
  });

  test("saving keeps unknown keys and writes mode 0600", async () => {
    await Bun.write(paths.configFile, JSON.stringify({ theme: "nord", future: { x: 1 } }));
    const loaded = await loadConfig(paths);
    await saveConfig(paths, { ...loaded.config, transparent: true }, loaded.raw);
    const written = JSON.parse(await Bun.file(paths.configFile).text());
    expect(written.future).toEqual({ x: 1 });
    expect(written.theme).toBe("nord");
    expect(written.transparent).toBe(true);
    expect((await stat(paths.configFile)).mode & 0o777).toBe(0o600);
  });

  test("saving over an unparsable or non-object file backs it up to config.json.bak", async () => {
    await Bun.write(paths.configFile, "{ broken: true, }");
    await saveConfig(paths, { ...DEFAULT_CONFIG, theme: "nord" });
    expect(await Bun.file(`${paths.configFile}.bak`).text()).toBe("{ broken: true, }");
    expect((await stat(`${paths.configFile}.bak`)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await Bun.file(paths.configFile).text()).theme).toBe("nord");

    await Bun.write(paths.configFile, "[1, 2, 3]");
    await saveConfig(paths, { ...DEFAULT_CONFIG, theme: "dracula" });
    expect(await Bun.file(`${paths.configFile}.bak`).text()).toBe("[1, 2, 3]");
    expect((await stat(`${paths.configFile}.bak`)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await Bun.file(paths.configFile).text()).theme).toBe("dracula");
  });

  test("saving over a valid file or missing file creates no .bak", async () => {
    await saveConfig(paths, DEFAULT_CONFIG);
    expect(await Bun.file(`${paths.configFile}.bak`).exists()).toBe(false);
    await saveConfig(paths, { ...DEFAULT_CONFIG, theme: "nord" });
    expect(await Bun.file(`${paths.configFile}.bak`).exists()).toBe(false);
  });
});

describe("expandEnv", () => {
  test("replaces ${NAME}", () => {
    expect(expandEnv("postgres://u:${PW}@h/db", { PW: "s3cret" })).toBe("postgres://u:s3cret@h/db");
  });
  test("a missing variable is an error that names it", () => {
    expect(() => expandEnv("postgres://u:${PW}@h/db", {})).toThrow("environment variable PW is not set");
  });
  test("text without references is unchanged", () => {
    expect(expandEnv("sqlite:app.db", {})).toBe("sqlite:app.db");
  });
  test("a variable set to an empty string expands to nothing", () => {
    expect(expandEnv("postgres://u:${PW}@h/db", { PW: "" })).toBe("postgres://u:@h/db");
    expect(() => expandEnv("postgres://u:${PW}@h/db", { PW: undefined })).toThrow("environment variable PW is not set");
  });
});

describe("final-c2 fix 3: a config file that cannot be read gives a warning", () => {
  let dir: string;
  let paths: Paths;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "losql-config-"));
    paths = resolvePaths({ LOSQL_CONFIG_DIR: join(dir, "c"), LOSQL_STATE_DIR: join(dir, "s") }, dir);
  });
  afterEach(async () => {
    await chmod(paths.configFile, 0o600).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  test("a directory in the file's place: defaults, a warning naming the file, and the directory is left alone", async () => {
    await mkdir(paths.configFile, { recursive: true });
    const loaded = await loadConfig(paths);
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(loaded.warnings.length).toBe(1);
    expect(loaded.warnings[0]).toContain(paths.configFile);
    expect(loaded.warnings[0]).toContain("using defaults");
    expect((await stat(paths.configFile)).isDirectory()).toBe(true);
  });

  test.skipIf(process.getuid?.() === 0)("an unreadable file: defaults, a warning naming the file, and the file is left alone", async () => {
    await mkdir(paths.configDir, { recursive: true });
    await Bun.write(paths.configFile, JSON.stringify({ theme: "nord" }));
    await chmod(paths.configFile, 0o000);
    const loaded = await loadConfig(paths);
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(loaded.warnings.length).toBe(1);
    expect(loaded.warnings[0]).toContain(paths.configFile);
    expect((await stat(paths.configFile)).mode & 0o777).toBe(0);
  });

  test("a missing file and a missing directory are not an error", async () => {
    expect((await loadConfig(paths)).warnings).toEqual([]);
  });
});
