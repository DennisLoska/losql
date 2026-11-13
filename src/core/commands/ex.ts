import type { Command, CommandRegistry } from "./registry";

export type ParsedEx =
  | { kind: "command"; name: string; args: string; bang: boolean }
  | { kind: "line"; line: number };

export function parseEx(input: string): ParsedEx | null {
  let trimmed = input.trim();
  if (trimmed.startsWith(":")) {
    trimmed = trimmed.slice(1).trim();
  }
  if (trimmed.length === 0) return null;

  if (/^\d+$/.test(trimmed)) {
    return { kind: "line", line: Number(trimmed) };
  }

  const match = /^([A-Za-z]+)(!)?([\s\S]*)$/.exec(trimmed);
  if (!match) return null;

  const name = match[1]!;
  const bang = match[2] === "!";
  const args = (match[3] ?? "").trim();

  return { kind: "command", name, args, bang };
}

export function resolveEx<Ctx>(
  registry: CommandRegistry<Ctx>,
  name: string,
): Command<Ctx> | undefined {
  if (name.length === 0) return undefined;

  const exact = registry.byEx(name);
  if (exact !== undefined) return exact;

  const byCanonical = new Map<string, Command<Ctx>>();
  for (const cmd of registry.all()) {
    const canonical = cmd.ex?.[0];
    if (canonical && canonical.startsWith(name)) {
      byCanonical.set(canonical, cmd);
    }
  }

  return byCanonical.size === 1 ? byCanonical.values().next().value : undefined;
}
