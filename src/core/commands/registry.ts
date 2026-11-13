export interface Command<Ctx> {
  id: string;
  title: string;
  group?: string;
  ex?: string[];
  keys?: string;
  when?: (ctx: Ctx) => boolean;
  run: (ctx: Ctx, args: string) => void | Promise<void>;
}

export type LeaderNode<Ctx> =
  | { kind: "command"; key: string; command: Command<Ctx> }
  | { kind: "group"; key: string; label: string; children: LeaderNode<Ctx>[] };

export class CommandRegistry<Ctx> {
  private commands: Command<Ctx>[] = [];

  register(command: Command<Ctx>): () => void {
    if (this.commands.some((c) => c.id === command.id)) {
      throw new Error(`command "${command.id}" is already registered`);
    }
    this.commands.push(command);
    return () => {
      const idx = this.commands.indexOf(command);
      if (idx !== -1) {
        this.commands.splice(idx, 1);
      }
    };
  }

  all(): Command<Ctx>[] {
    return [...this.commands];
  }

  byId(id: string): Command<Ctx> | undefined {
    return this.commands.find((c) => c.id === id);
  }

  byEx(name: string): Command<Ctx> | undefined {
    for (let i = this.commands.length - 1; i >= 0; i--) {
      const cmd = this.commands[i]!;
      if (cmd.ex !== undefined && cmd.ex.includes(name)) {
        return cmd;
      }
    }
    return undefined;
  }

  isAvailable(command: Command<Ctx>, ctx: Ctx): boolean {
    if (!command.when) return true;
    try {
      return Boolean(command.when(ctx));
    } catch {
      return false;
    }
  }

  /**
   * Builds the Leader key tree from available Commands in registration order.
   * Conflict rule (later registration wins):
   * - A one-key sequence sets the node for that key, replacing any earlier command or group node.
   * - A two-key sequence ensures the first key is a group node (replacing an earlier one-key command
   *   node with a new group labelled from this Command's `group`, or the key itself) and sets the
   *   child for the second key, replacing any earlier child with the same key.
   * - A group's label is the `group` of the Command that created the group node.
   * - Sequences of more than two keys are ignored.
   */
  leaderTree(ctx: Ctx): LeaderNode<Ctx>[] {
    const topNodes = new Map<string, LeaderNode<Ctx>>();

    for (const cmd of this.commands) {
      if (!cmd.keys) continue;
      if (!this.isAvailable(cmd, ctx)) continue;

      const parts = cmd.keys.trim().split(/\s+/);
      if (parts.length === 1 && parts[0]) {
        const key = parts[0];
        topNodes.set(key, { kind: "command", key, command: cmd });
      } else if (parts.length === 2 && parts[0] && parts[1]) {
        const [firstKey, secondKey] = parts;
        let groupNode = topNodes.get(firstKey);
        if (!groupNode || groupNode.kind !== "group") {
          groupNode = {
            kind: "group",
            key: firstKey,
            label: cmd.group ?? firstKey,
            children: [],
          };
          topNodes.set(firstKey, groupNode);
        }
        const childNode: LeaderNode<Ctx> = {
          kind: "command",
          key: secondKey,
          command: cmd,
        };
        const existingIdx = groupNode.children.findIndex((c) => c.key === secondKey);
        if (existingIdx !== -1) {
          groupNode.children[existingIdx] = childNode;
        } else {
          groupNode.children.push(childNode);
        }
      }
    }

    const result = Array.from(topNodes.values());
    for (const node of result) {
      if (node.kind === "group") {
        node.children.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      }
    }
    result.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return result;
  }
}
