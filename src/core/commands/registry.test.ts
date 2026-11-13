import { expect, test } from "bun:test";
import { CommandRegistry } from "./registry";

interface Ctx { log: string[]; agent: boolean }
const noop = () => {};

function build() {
  const registry = new CommandRegistry<Ctx>();
  registry.register({ id: "app.quit", title: "Quit", ex: ["quit", "q"], run: (ctx) => { ctx.log.push("quit"); } });
  registry.register({ id: "run.statement", title: "Run statement", ex: ["run"], keys: "r", run: noop });
  registry.register({ id: "agent.explain", title: "Explain statement", group: "Agent", keys: "a e", when: (ctx) => ctx.agent, run: noop });
  registry.register({ id: "agent.ask", title: "Ask the agent", group: "Agent", ex: ["ask"], keys: "a i", run: noop });
  registry.register({ id: "theme.pick", title: "Themes", keys: "t", run: noop });
  return registry;
}

test("lookup by id and by ex name", () => {
  const registry = build();
  expect(registry.all().map((c) => c.id)).toEqual(["app.quit", "run.statement", "agent.explain", "agent.ask", "theme.pick"]);
  expect(registry.byId("agent.ask")?.title).toBe("Ask the agent");
  expect(registry.byEx("q")?.id).toBe("app.quit");
  expect(registry.byEx("quit")?.id).toBe("app.quit");
  expect(registry.byEx("nope")).toBeUndefined();
});

test("a duplicate id throws and unregister removes a command", () => {
  const registry = build();
  expect(() => registry.register({ id: "app.quit", title: "Again", run: noop })).toThrow('command "app.quit" is already registered');
  const off = registry.register({ id: "tmp", title: "Tmp", ex: ["tmp"], run: noop });
  expect(registry.byEx("tmp")?.id).toBe("tmp");
  off();
  expect(registry.byId("tmp")).toBeUndefined();
});

test("leaderTree groups by the first key and hides commands whose condition is false", () => {
  const registry = build();
  const tree = registry.leaderTree({ log: [], agent: true });
  expect(tree.map((n) => [n.kind, n.key])).toEqual([["group", "a"], ["command", "r"], ["command", "t"]]);
  const group = tree[0]!;
  expect(group.kind === "group" && group.label).toBe("Agent");
  expect(group.kind === "group" && group.children.map((c) => c.key)).toEqual(["e", "i"]);

  const without = registry.leaderTree({ log: [], agent: false });
  const g = without[0]!;
  expect(g.kind === "group" && g.children.map((c) => c.key)).toEqual(["i"]);
});

test("leaderTree group label comes from the first visible command", () => {
  const registry = new CommandRegistry<Ctx>();
  registry.register({ id: "a.hidden", title: "Hidden", group: "Hidden", keys: "a x", when: () => false, run: noop });
  registry.register({ id: "a.visible", title: "Visible", group: "Visible", keys: "a y", run: noop });
  const tree = registry.leaderTree({ log: [], agent: true });
  expect(tree).toHaveLength(1);
  const group = tree[0]!;
  expect(group.kind).toBe("group");
  if (group.kind === "group") {
    expect(group.key).toBe("a");
    expect(group.label).toBe("Visible");
    expect(group.children.map((c) => c.key)).toEqual(["y"]);
  }
});

test("leaderTree conflict resolution: later registration wins", () => {
  // 1. `a x` registered twice (ids `a`, `b`) gives one group `a` with exactly one child `x`, command `b`
  const r1 = new CommandRegistry<Ctx>();
  r1.register({ id: "a", title: "First", group: "G1", keys: "a x", run: noop });
  r1.register({ id: "b", title: "Second", group: "G2", keys: "a x", run: noop });
  const t1 = r1.leaderTree({ log: [], agent: true });
  expect(t1).toHaveLength(1);
  expect(t1[0]?.kind).toBe("group");
  if (t1[0]?.kind === "group") {
    expect(t1[0].key).toBe("a");
    expect(t1[0].label).toBe("G1");
    expect(t1[0].children).toHaveLength(1);
    expect(t1[0].children[0]).toMatchObject({ kind: "command", key: "x", command: { id: "b" } });
  }

  // 2. `a x` then `a` gives the single command node `a`
  const r2 = new CommandRegistry<Ctx>();
  r2.register({ id: "ax", title: "Group child", group: "G", keys: "a x", run: noop });
  r2.register({ id: "b", title: "B", keys: "b", run: noop });
  r2.register({ id: "a", title: "Single", keys: "a", run: noop });
  const t2 = r2.leaderTree({ log: [], agent: true });
  expect(t2.map((n) => [n.kind, n.key])).toEqual([["command", "a"], ["command", "b"]]);
  if (t2[0]?.kind === "command") {
    expect(t2[0].command.id).toBe("a");
  }

  // 3. `a` then `a x` gives a group `a` with the one child `x`
  const r3 = new CommandRegistry<Ctx>();
  r3.register({ id: "a", title: "Single", keys: "a", run: noop });
  r3.register({ id: "b", title: "B", keys: "b", run: noop });
  r3.register({ id: "ax", title: "Group child", group: "NewGroup", keys: "a x", run: noop });
  const t3 = r3.leaderTree({ log: [], agent: true });
  expect(t3.map((n) => [n.kind, n.key])).toEqual([["group", "a"], ["command", "b"]]);
  if (t3[0]?.kind === "group") {
    expect(t3[0].label).toBe("NewGroup");
    expect(t3[0].children).toHaveLength(1);
    expect(t3[0].children[0]).toMatchObject({ kind: "command", key: "x", command: { id: "ax" } });
  }
});

test("isAvailable and leaderTree treat a throwing when predicate as not available", () => {
  const registry = new CommandRegistry<Ctx>();
  const alwaysCmd = { id: "always", title: "Always", keys: "a", run: noop };
  const trueCmd = { id: "true", title: "True", keys: "t", when: (ctx: Ctx) => ctx.agent, run: noop };
  const falseCmd = { id: "false", title: "False", keys: "f", when: () => false, run: noop };
  const throwCmd = {
    id: "throws",
    title: "Throws",
    keys: "x",
    when: () => {
      throw new Error("boom");
    },
    run: noop,
  };
  registry.register(alwaysCmd);
  registry.register(trueCmd);
  registry.register(falseCmd);
  registry.register(throwCmd);

  const ctx: Ctx = { log: [], agent: true };
  expect(registry.isAvailable(alwaysCmd, ctx)).toBe(true);
  expect(registry.isAvailable(trueCmd, ctx)).toBe(true);
  expect(registry.isAvailable(falseCmd, ctx)).toBe(false);
  expect(registry.isAvailable(throwCmd, ctx)).toBe(false);

  const tree = registry.leaderTree(ctx);
  expect(tree.map((n) => n.key)).toEqual(["a", "t"]);
});

test("byEx returns the last registered command when several share an ex name", () => {
  const registry = new CommandRegistry<Ctx>();
  registry.register({ id: "quit.first", title: "First Quit", ex: ["quit", "q"], run: noop });
  registry.register({ id: "quit.second", title: "Second Quit", ex: ["quit", "q"], run: noop });
  expect(registry.byEx("quit")?.id).toBe("quit.second");
  expect(registry.byEx("q")?.id).toBe("quit.second");
});




