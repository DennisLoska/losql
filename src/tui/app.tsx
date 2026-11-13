import { useRenderer } from "@opentui/solid";
import { createEffect, createSignal, getOwner, type JSX, onCleanup, onMount, Show, untrack } from "solid-js";
import type { LeaderNode } from "../core/commands/registry";
import type { Config } from "../core/config";
import { type AppState, stateWarnings } from "../core/state";
import { registerAppCommands } from "./commands";
import { type AgentApi, AgentProvider, useAgent } from "./context/agent";
import {
  type CmdlineApi,
  CmdlineProvider,
  type CommandsApi,
  CommandsProvider,
  useCmdline,
  useCommands,
} from "./context/commands";
import { type ConfigApi, ConfigProvider, useConfig } from "./context/config";
import { DepsProvider, useDeps } from "./context/deps";
import { type DialogApi, DialogProvider, useDialog } from "./context/dialog";
import { type FocusApi, FocusProvider, useFocus } from "./context/focus";
import { type KeysApi, KeysProvider, useKeys } from "./context/keys";
import { type SessionApi, SessionProvider, useSession } from "./context/session";
import { type StatusApi, StatusProvider, useStatus } from "./context/status";
import { type InitialThemeData, type ThemeApi, ThemeProvider, useTheme } from "./context/theme";
import { type ToastApi, ToastProvider, useToast } from "./context/toast";
import type { AppDeps } from "./deps";
import { openConnections } from "./dialogs/connections";
import { openHistory } from "./dialogs/history";
import { openModels } from "./dialogs/model";
import { openProviders } from "./dialogs/provider";
import { openThemes } from "./dialogs/theme";
import { Onboarding, type OnboardingStep } from "./onboarding/Onboarding";
import type { EditorApi } from "./panes/editor/EditorPane";
import type { ResultsApi } from "./panes/results/ResultsPane";
import type { SchemaApi } from "./panes/schema/SchemaPane";
import { setWidthMethod } from "./ui/cells";
import { Cmdline } from "./ui/cmdline";
import { openHelp } from "./ui/help";
import { KeyMenu } from "./ui/keymenu";
import { openPalette } from "./ui/palette";
import { printable } from "./ui/printable";
import { Toasts } from "./ui/toast";
import { Workspace } from "./workspace";

export interface TuiArgs {
  connection?: string;
  theme?: string;
  transparent?: boolean;
  animations?: boolean;
}

export interface AppApi {
  deps: AppDeps;
  config: ConfigApi;
  theme: ThemeApi;
  focus: FocusApi;
  status: StatusApi;
  keys: KeysApi;
  dialog: DialogApi;
  toast: ToastApi;
  commands: CommandsApi;
  cmdline: CmdlineApi;
  session: SessionApi;
  agent: AgentApi;
  editor: EditorApi;
  results: ResultsApi;
  schema: SchemaApi;
  onboarding(): OnboardingStep;
  onQuit(hook: () => void | Promise<void>): void;
  quit(): Promise<void>;
}

export interface Loaded {
  config: Config;
  raw: Record<string, unknown>;
  warnings: string[];
  state: AppState;
  initialTheme?: InitialThemeData;
}

function AppShell(props: {
  args: TuiArgs;
  loaded: Loaded;
  quitHooks: Array<() => void | Promise<void>>;
  quit: () => Promise<void>;
  onApiReady: (api: AppApi) => void;
  expose?: (api: AppApi) => void;
  ui?: (api: AppApi) => JSX.Element;
}): JSX.Element {
  const deps = useDeps();
  const config = useConfig();
  const status = useStatus();
  const focus = useFocus();
  const theme = useTheme();
  const keys = useKeys();
  const dialog = useDialog();
  const toast = useToast();
  const commands = useCommands();
  const cmdline = useCmdline();
  const session = useSession();
  const agent = useAgent();
  const renderer = useRenderer();
  // Every width in the interface is measured as this renderer draws (see ui/cells.ts).
  setWidthMethod(renderer.widthMethod);
  const onCapabilities = () => setWidthMethod(renderer.widthMethod);
  renderer.on("capabilities", onCapabilities);
  onCleanup(() => renderer.off("capabilities", onCapabilities));

  const startsWithOnboarding = untrack(() => !props.ui && !config.state().onboarded);
  const [onboardingDone, setOnboardingDone] = createSignal(!startsWithOnboarding);
  let readOnboardingStep: () => OnboardingStep = () => "welcome";

  createEffect(() => {
    renderer.setBackgroundColor(theme.color("background"));
  });

  onMount(() => {
    for (const warning of [...config.warnings, ...stateWarnings(props.loaded.state)]) {
      toast.show({ message: warning, kind: "warning" });
    }

    const argConn = props.args.connection?.trim();
    const envConn = deps.env.DATABASE_URL?.trim();
    const stateConn = config.state().lastConnection?.trim();
    const initialConnection =
      (argConn ? argConn : undefined) ??
      (envConn ? envConn : undefined) ??
      (stateConn ? stateConn : undefined);

    if (initialConnection) {
      void session.connect(initialConnection).then((res) => {
        if (!res.ok) {
          toast.show({
            title: "Could not connect",
            message: res.message,
            kind: "error",
          });
          if (!props.ui && onboardingDone()) {
            void openConnections(api);
          }
        }
      });
    } else if (!props.ui && onboardingDone()) {
      void openConnections(api);
    }
  });

  const api: AppApi = {
    deps,
    config,
    theme,
    focus,
    status,
    keys,
    dialog,
    toast,
    commands,
    cmdline,
    session,
    agent,
    editor: undefined as unknown as EditorApi,
    results: undefined as unknown as ResultsApi,
    schema: undefined as unknown as SchemaApi,
    onboarding: () => (onboardingDone() ? "done" : readOnboardingStep()),
    onQuit(hook) {
      props.quitHooks.push(hook);
    },
    quit: props.quit,
  };

  const commandOffs = new Map<string, () => void>();
  commands.register = (command) => {
    commandOffs.get(command.id)?.();
    const off = commands.registry.register(command);
    commandOffs.set(command.id, off);
    if (getOwner()) {
      onCleanup(() => {
        if (commandOffs.get(command.id) === off) {
          commandOffs.delete(command.id);
        }
        off();
      });
    }
  };

  props.onApiReady(api);
  registerAppCommands(api);

  commands.register({
    id: "connections.pick",
    title: "Connections",
    ex: ["connections"],
    keys: "c",
    run: (ctx) => {
      void openConnections(ctx);
    },
  });

  commands.register({
    id: "history.pick",
    title: "History",
    ex: ["history"],
    keys: "h",
    run: (ctx) => openHistory(ctx),
  });

  commands.register({
    id: "provider.pick",
    title: "Provider",
    ex: ["provider"],
    keys: "p",
    run: (ctx) => {
      void openProviders(ctx);
    },
  });

  let modelPicking = false;
  commands.register({
    id: "model.pick",
    title: "Model",
    ex: ["model"],
    keys: "m",
    run: async (ctx) => {
      if (modelPicking) return;
      const prov = ctx.agent.provider();
      if (!prov || !prov.installed) {
        await openProviders(ctx);
        return;
      }
      modelPicking = true;
      try {
        const chosen = await openModels(ctx, prov.id);
        if (chosen === null) return;
        const nextModel = chosen === "default" ? null : chosen;
        try {
          await ctx.config.set((c) => ({
            ...c,
            agent: { ...c.agent, model: nextModel },
          }));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.toast.show({
            message: printable(`Config could not be saved: ${msg}`),
            kind: "error",
          });
        }
      } finally {
        modelPicking = false;
      }
    },
  });

  commands.register({
    id: "theme.pick",
    title: "Themes",
    keys: "t",
    run: (ctx) => {
      void openThemes(ctx);
    },
  });

  let openKeyMenu: (tree: LeaderNode<AppApi>[]) => void = () => {};
  const content = props.ui ? (
    props.ui(api)
  ) : (
    <Show
      when={onboardingDone()}
      fallback={
        <Onboarding
          api={api}
          rawConfig={props.loaded.raw}
          exposeStep={(s) => {
            readOnboardingStep = s;
          }}
          onDone={() => {
            setOnboardingDone(true);
          }}
        />
      }
    >
      <Workspace
        exposeSchema={(schema) => {
          api.schema = schema;
        }}
        exposeEditor={(editor) => {
          api.editor = editor;
        }}
        exposeResults={(results) => {
          api.results = results;
        }}
        onQuit={(hook) => api.onQuit(hook)}
      />
    </Show>
  );
  props.expose?.(api);

  const removeGlobal = keys.addGlobal((key) => {
    if (!key.ctrl && !key.meta && key.text === ":") {
      cmdline.open({
        prefix: ":",
        onSubmit: (text) => {
          void commands.runEx(text);
        },
      });
      return true;
    }

    if (key.ctrl && !key.meta && key.name === "p") {
      void openPalette(api);
      return true;
    }

    if (!key.ctrl && !key.meta && key.name === "f1") {
      openHelp(api);
      return true;
    }

    const leader = config.config().leader;
    const isLeader =
      leader === "space"
        ? !key.ctrl && !key.meta && key.name === "space"
        : !key.ctrl && !key.meta && key.text === leader;
    if (isLeader) {
      const tree = commands.registry.leaderTree(api);
      if (tree.length === 0) return false;
      openKeyMenu(tree);
      return true;
    }

    return false;
  });

  onCleanup(removeGlobal);

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      backgroundColor={theme.color("background")}
    >
      {content}
      <KeyMenu
        getApi={() => api}
        exposeOpen={(open) => {
          openKeyMenu = open;
        }}
      />
      <Cmdline />
    </box>
  );
}

export function App(props: {
  deps: AppDeps;
  args: TuiArgs;
  loaded: Loaded;
  expose?: (api: AppApi) => void;
  ui?: (api: AppApi) => JSX.Element;
}): JSX.Element {
  const quitHooks: Array<() => void | Promise<void>> = [];
  let quitting: Promise<void> | null = null;
  let currentApi!: AppApi;

  const quit = (): Promise<void> => {
    if (quitting) return quitting;
    quitting = (async () => {
      try {
        for (const hook of [...quitHooks]) {
          let cancelTimer: (() => void) | undefined;
          try {
            await Promise.race([
              (async () => {
                await hook();
              })(),
              new Promise<void>((resolve) => {
                cancelTimer = props.deps.clock.after(2000, resolve);
              }),
            ]);
          } catch {
            // Ignore hook errors so remaining hooks still run
          } finally {
            cancelTimer?.();
          }
        }
      } finally {
        props.deps.exit(0);
      }
    })();
    return quitting;
  };

  return (
    <DepsProvider deps={props.deps}>
      <ConfigProvider args={props.args} loaded={props.loaded}>
        <StatusProvider>
          <FocusProvider>
            <ThemeProvider initialTheme={props.loaded.initialTheme}>
              <KeysProvider onQuit={quit}>
                <ToastProvider>
                  <DialogProvider>
                    <CmdlineProvider>
                      <CommandsProvider getApi={() => currentApi}>
                        <SessionProvider onQuit={(hook) => quitHooks.push(hook)}>
                          <AgentProvider
                            getApi={() => currentApi}
                            onQuit={(hook) => quitHooks.push(hook)}
                          >
                            <AppShell
                              args={props.args}
                              loaded={props.loaded}
                              quitHooks={quitHooks}
                              quit={quit}
                              onApiReady={(a) => {
                                currentApi = a;
                              }}
                              expose={props.expose}
                              ui={props.ui}
                            />
                          </AgentProvider>
                        </SessionProvider>
                      </CommandsProvider>
                    </CmdlineProvider>
                  </DialogProvider>
                  <Toasts />
                </ToastProvider>
              </KeysProvider>
            </ThemeProvider>
          </FocusProvider>
        </StatusProvider>
      </ConfigProvider>
    </DepsProvider>
  );
}
