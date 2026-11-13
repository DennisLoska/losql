import {
  createContext,
  createSignal,
  getOwner,
  type JSX,
  onCleanup,
  type ParentProps,
  untrack,
  useContext,
} from "solid-js";
import { parseEx, resolveEx } from "../../core/commands/ex";
import { type Command, CommandRegistry } from "../../core/commands/registry";
import type { AppApi } from "../app";
import { createLineInput, type LineInput } from "../ui/line-input";
import { useKeys } from "./keys";
import { useStatus } from "./status";

export interface CmdlineOptions {
  prefix: string;
  initial?: string;
  onSubmit: (text: string) => void;
  onCancel?: () => void;
}

export interface CmdlineApi {
  open(options: CmdlineOptions): void;
  active(): boolean;
  prefix(): string;
  input: LineInput;
}

export interface CommandsApi {
  registry: CommandRegistry<AppApi>;
  register(command: Command<AppApi>): void;
  runEx(input: string): Promise<void>;
  run(id: string, args?: string): Promise<void>;
}

const CmdlineContext = createContext<CmdlineApi>();
const CommandsContext = createContext<CommandsApi>();

export function CmdlineProvider(props: ParentProps): JSX.Element {
  const keys = useKeys();
  const input = createLineInput();
  const [prefix, setPrefix] = createSignal(":");
  const [active, setActive] = createSignal(false);

  let currentOptions: CmdlineOptions | null = null;
  let removeLayer: (() => void) | null = null;

  const close = () => {
    if (removeLayer) {
      removeLayer();
      removeLayer = null;
    }
    currentOptions = null;
    setActive(false);
  };

  const open = (options: CmdlineOptions) => {
    const prev = currentOptions;
    close();
    prev?.onCancel?.();
    currentOptions = options;
    setPrefix(options.prefix);
    input.set(options.initial ?? "");
    setActive(true);

    removeLayer = keys.pushLayer(
      (key) => {
        const opts = currentOptions;
        if (!opts) return false;

        if (!key.ctrl && !key.meta && key.name === "enter") {
          const text = input.text();
          close();
          opts.onSubmit(text);
          return true;
        }
        if (
          (!key.ctrl && !key.meta && key.name === "escape") ||
          (key.ctrl && !key.meta && key.name === "c")
        ) {
          close();
          opts.onCancel?.();
          return true;
        }
        if (!key.ctrl && !key.meta && key.name === "backspace") {
          if (input.text().length === 0) {
            close();
            opts.onCancel?.();
            return true;
          }
          input.feed(key);
          return true;
        }
        input.feed(key);
        return true;
      },
      {
        modal: true,
        onPaste(text) {
          input.paste(text);
        },
      },
    );
  };

  onCleanup(close);

  const api: CmdlineApi = {
    open,
    active,
    prefix,
    input,
  };

  return (
    <CmdlineContext.Provider value={api}>
      {props.children}
    </CmdlineContext.Provider>
  );
}

export function useCmdline(): CmdlineApi {
  const ctx = useContext(CmdlineContext);
  if (!ctx) throw new Error("useCmdline must be used within a CmdlineProvider");
  return ctx;
}

export function CommandsProvider(
  props: ParentProps<{ getApi: () => AppApi }>,
): JSX.Element {
  const status = useStatus();
  const registry = new CommandRegistry<AppApi>();
  const [version, setVersion] = createSignal(0);

  const origRegister = registry.register.bind(registry);
  registry.register = (command: Command<AppApi>): (() => void) => {
    const off = origRegister(command);
    setVersion((v) => v + 1);
    return () => {
      off();
      setVersion((v) => v + 1);
    };
  };

  const origAll = registry.all.bind(registry);
  registry.all = (): Command<AppApi>[] => {
    version();
    return origAll();
  };

  const origLeaderTree = registry.leaderTree.bind(registry);
  registry.leaderTree = (ctx: AppApi) => {
    version();
    return origLeaderTree(ctx);
  };

  const run = async (id: string, args = ""): Promise<void> => {
    const command = untrack(() => registry.byId(id));
    if (!command) return;
    const appApi = props.getApi();
    if (!untrack(() => registry.isAvailable(command, appApi))) return;
    try {
      await command.run(appApi, args);
    } catch (err) {
      status.say(err instanceof Error ? err.message : String(err), "error");
    }
  };

  const runEx = async (input: string): Promise<void> => {
    const parsed = parseEx(input);
    if (!parsed) return;
    if (parsed.kind === "line") {
      await run("editor.gotoLine", String(parsed.line));
      return;
    }
    const command = untrack(() => resolveEx(registry, parsed.name));
    if (!command) {
      const matches = untrack(() => {
        const byCanonical = new Map<string, Command<AppApi>>();
        for (const cmd of registry.all()) {
          const canonical = cmd.ex?.[0];
          if (canonical && canonical.startsWith(parsed.name)) {
            byCanonical.set(canonical, cmd);
          }
        }
        return Array.from(byCanonical.keys());
      });
      if (matches.length > 1) {
        status.say(
          `Ambiguous command: ${parsed.name} (${matches.slice(0, 5).join(", ")})`,
          "error",
        );
        return;
      }
      status.say(`Not a command: ${parsed.name}`, "error");
      return;
    }
    const appApi = props.getApi();
    if (!untrack(() => registry.isAvailable(command, appApi))) {
      status.say(`Not available here: ${command.ex?.[0] ?? parsed.name}`, "error");
      return;
    }
    await run(command.id, parsed.args);
  };

  const api: CommandsApi = {
    registry,
    register(command: Command<AppApi>): void {
      const off = registry.register(command);
      if (getOwner()) {
        onCleanup(off);
      }
    },
    runEx,
    run,
  };

  return <CommandsContext.Provider value={api}>{props.children}</CommandsContext.Provider>;
}

export function useCommands(): CommandsApi {
  const ctx = useContext(CommandsContext);
  if (!ctx) throw new Error("useCommands must be used within a CommandsProvider");
  return ctx;
}
