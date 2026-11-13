import { expect, test } from "bun:test";
import { resolvePaths } from "./paths";

test("defaults follow XDG under the home directory", () => {
  const p = resolvePaths({}, "/home/u");
  expect(p.configDir).toBe("/home/u/.config/losql");
  expect(p.configFile).toBe("/home/u/.config/losql/config.json");
  expect(p.themesDir).toBe("/home/u/.config/losql/themes");
  expect(p.stateDir).toBe("/home/u/.local/state/losql");
  expect(p.stateFile).toBe("/home/u/.local/state/losql/state.json");
  expect(p.historyFile).toBe("/home/u/.local/state/losql/history.jsonl");
  expect(p.buffersDir).toBe("/home/u/.local/state/losql/buffers");
});

test("XDG variables are honoured", () => {
  const p = resolvePaths({ XDG_CONFIG_HOME: "/x/c", XDG_STATE_HOME: "/x/s" }, "/home/u");
  expect(p.configDir).toBe("/x/c/losql");
  expect(p.stateDir).toBe("/x/s/losql");
});

test("LOSQL_ variables win", () => {
  const p = resolvePaths({ XDG_CONFIG_HOME: "/x/c", LOSQL_CONFIG_DIR: "/l/c", LOSQL_STATE_DIR: "/l/s" }, "/home/u");
  expect(p.configDir).toBe("/l/c");
  expect(p.stateDir).toBe("/l/s");
});
