import { expect, test } from "bun:test";
import { parseEx, resolveEx } from "./ex";
import { CommandRegistry } from "./registry";

test("parseEx", () => {
  expect(parseEx("q")).toEqual({ kind: "command", name: "q", args: "", bang: false });
  expect(parseEx("q!")).toEqual({ kind: "command", name: "q", args: "", bang: true });
  expect(parseEx("  w  /tmp/a.sql ")).toEqual({ kind: "command", name: "w", args: "/tmp/a.sql", bang: false });
  expect(parseEx("set maxrows=50")).toEqual({ kind: "command", name: "set", args: "maxrows=50", bang: false });
  expect(parseEx("ask top 10 customers")).toEqual({ kind: "command", name: "ask", args: "top 10 customers", bang: false });
  expect(parseEx(":run all")).toEqual({ kind: "command", name: "run", args: "all", bang: false });
  expect(parseEx("42")).toEqual({ kind: "line", line: 42 });
  expect(parseEx("")).toBeNull();
  expect(parseEx("   ")).toBeNull();
});

test("resolveEx accepts an exact name or an unambiguous prefix of a canonical name", () => {
  const registry = new CommandRegistry<null>();
  const noop = () => {};
  registry.register({ id: "quit", title: "Quit", ex: ["quit", "q"], run: noop });
  registry.register({ id: "write", title: "Write", ex: ["write", "w"], run: noop });
  registry.register({ id: "run", title: "Run", ex: ["run"], run: noop });
  registry.register({ id: "refresh", title: "Refresh", ex: ["refresh"], run: noop });
  expect(resolveEx(registry, "q")?.id).toBe("quit");
  expect(resolveEx(registry, "qu")?.id).toBe("quit");
  expect(resolveEx(registry, "wri")?.id).toBe("write");
  expect(resolveEx(registry, "run")?.id).toBe("run");
  expect(resolveEx(registry, "ru")?.id).toBe("run");
  expect(resolveEx(registry, "r")).toBeUndefined();
  expect(resolveEx(registry, "zzz")).toBeUndefined();
});

test("resolveEx resolves shared exact ex names and unambiguous prefixes to the last registered command", () => {
  const registry = new CommandRegistry<null>();
  const noop = () => {};
  registry.register({ id: "quit.1", title: "Quit 1", ex: ["quit", "q"], run: noop });
  registry.register({ id: "quit.2", title: "Quit 2", ex: ["quit", "q"], run: noop });
  registry.register({ id: "query", title: "Query", ex: ["query"], run: noop });

  expect(resolveEx(registry, "quit")?.id).toBe("quit.2");
  expect(resolveEx(registry, "q")?.id).toBe("quit.2");
  expect(resolveEx(registry, "qui")?.id).toBe("quit.2");
  expect(resolveEx(registry, "qu")).toBeUndefined();
});

