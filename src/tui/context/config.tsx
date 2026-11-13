import { createContext, createMemo, createSignal, type JSX, type ParentProps, useContext } from "solid-js";
import { type Config, saveConfig } from "../../core/config";
import { type AppState, saveState } from "../../core/state";
import type { Loaded, TuiArgs } from "../app";
import { useDeps } from "./deps";

export interface ConfigApi {
  config(): Config;
  set(update: (config: Config) => Config): Promise<void>;
  animations(): boolean;
  state(): AppState;
  setState(patch: Partial<AppState>): Promise<void>;
  warnings: string[];
}

const ConfigContext = createContext<ConfigApi>();

type ConfigOverrides = Partial<Pick<Config, "theme" | "transparent" | "animations">>;

function buildOverrides(args: TuiArgs): ConfigOverrides {
  const overrides: ConfigOverrides = {};
  if (args.theme !== undefined) overrides.theme = args.theme;
  if (args.transparent !== undefined) overrides.transparent = args.transparent;
  if (args.animations !== undefined) overrides.animations = args.animations;
  return overrides;
}

export function ConfigProvider(
  props: ParentProps<{ args: TuiArgs; loaded: Loaded; expose?: (api: ConfigApi) => void }>,
): JSX.Element {
  const deps = useDeps();
  const [fileConfig, setFileConfig] = createSignal<Config>(props.loaded.config);
  const [overrides, setOverrides] = createSignal<ConfigOverrides>(buildOverrides(props.args));
  const [state, setStateSignal] = createSignal<AppState>(props.loaded.state);

  const effectiveConfig = createMemo<Config>(() => ({
    ...fileConfig(),
    ...overrides(),
  }));

  let saveChain: Promise<void> = Promise.resolve();

  const enqueueSave = (task: () => Promise<void>): Promise<void> => {
    const next = saveChain.then(task, task);
    saveChain = next.catch(() => {});
    return next;
  };

  const api: ConfigApi = {
    config: effectiveConfig,
    set(update: (config: Config) => Config): Promise<void> {
      const prevFile = fileConfig();
      const prevOverrides = overrides();
      const before = { ...prevFile, ...prevOverrides };
      const updatedEffective = update(before);
      const updatedFile = update(prevFile);

      const nextOverrides: ConfigOverrides = { ...prevOverrides };
      const overrideKeys = ["theme", "transparent", "animations"] as const;
      for (const key of overrideKeys) {
        if (key in nextOverrides) {
          if (updatedEffective[key] !== before[key] || updatedFile[key] !== prevFile[key]) {
            delete nextOverrides[key];
          }
        }
      }

      const nextFile: Config = {
        ...updatedEffective,
        ...("theme" in nextOverrides ? { theme: prevFile.theme } : {}),
        ...("transparent" in nextOverrides ? { transparent: prevFile.transparent } : {}),
        ...("animations" in nextOverrides ? { animations: prevFile.animations } : {}),
      };

      setOverrides(nextOverrides);
      setFileConfig(nextFile);

      return enqueueSave(() => saveConfig(deps.paths, nextFile, props.loaded.raw));
    },
    animations(): boolean {
      return effectiveConfig().animations && deps.env.LOSQL_NO_ANIMATIONS !== "1";
    },
    state,
    setState(patch: Partial<AppState>): Promise<void> {
      const next = { ...state(), ...patch };
      setStateSignal(next);
      return enqueueSave(() => saveState(deps.paths, next));
    },
    warnings: props.loaded.warnings,
  };

  props.expose?.(api);

  return <ConfigContext.Provider value={api}>{props.children}</ConfigContext.Provider>;
}

export function useConfig(): ConfigApi {
  const ctx = useContext(ConfigContext);
  if (!ctx) throw new Error("useConfig must be used within a ConfigProvider");
  return ctx;
}
