import type { RGBA, SyntaxStyle } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { existsSync } from "node:fs";
import {
  createComputed,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  type JSX,
  onCleanup,
  type ParentProps,
  untrack,
  useContext,
} from "solid-js";
import {
  BUILTIN_THEMES,
  listThemes,
  loadThemeJson,
  omarchyColorsPath,
  type ThemeInfo,
  type ThemeSources,
} from "../../core/theme/registry";
import { resolveTheme } from "../../core/theme/resolve";
import type { Theme, ThemeJson, ThemeToken } from "../../core/theme/tokens";
import { mixTheme } from "../motion/color";
import { easeOutCubic, tweenValue } from "../motion/tween";
import { createSyntaxStyle, toRGBA } from "../theme-bridge";
import { useConfig } from "./config";
import { useDeps } from "./deps";
import { useStatus } from "./status";

export type ColorName = ThemeToken | "paneBackground" | "overlayBackground" | "selection";

export interface ThemeApi {
  theme(): Theme;
  name(): string;
  color(name: ColorName): RGBA;
  syntax(): SyntaxStyle;
  list(): Promise<ThemeInfo[]>;
  preview(name: string | null): Promise<void>;
  select(name: string): Promise<void>;
  setTransparent(on: boolean): Promise<void>;
}

const ThemeContext = createContext<ThemeApi>();

interface ActiveThemeSource {
  name: string;
  json: ThemeJson;
  mode?: "dark" | "light";
}

export interface InitialThemeData {
  name: string;
  json: ThemeJson;
  mode?: "dark" | "light";
  theme: Theme;
  error?: string;
}

export async function loadInitialTheme(
  deps: { paths: { themesDir: string }; env: Record<string, string | undefined>; home: string },
  requested: string,
  cfgMode: "dark" | "light",
  transparent: boolean,
): Promise<InitialThemeData> {
  const sources: ThemeSources = {
    themesDir: deps.paths.themesDir,
    omarchyColors: deps.env.LOSQL_OMARCHY_COLORS ?? omarchyColorsPath(deps.env, deps.home, existsSync),
  };
  try {
    const loaded = await loadThemeJson(requested, sources);
    const theme = resolveTheme(requested, loaded.json, {
      mode: loaded.mode ?? cfgMode,
      transparent,
    });
    return { name: requested, json: loaded.json, mode: loaded.mode, theme };
  } catch (err) {
    const json = BUILTIN_THEMES.tokyonight!;
    const theme = resolveTheme("tokyonight", json, {
      mode: cfgMode,
      transparent,
    });
    return {
      name: "tokyonight",
      json,
      theme,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function ThemeProvider(
  props: ParentProps<{ initialTheme?: InitialThemeData; expose?: (api: ThemeApi) => void }>,
): JSX.Element {
  const deps = useDeps();
  const config = useConfig();
  const status = useStatus();
  const renderer = useRenderer();

  const getSources = (): ThemeSources => ({
    themesDir: deps.paths.themesDir,
    omarchyColors: deps.env.LOSQL_OMARCHY_COLORS ?? omarchyColorsPath(deps.env, deps.home, existsSync),
  });

  const initialRequested = untrack(() => config.config().theme);
  const initialBuiltinJson = Object.hasOwn(BUILTIN_THEMES, initialRequested)
    ? BUILTIN_THEMES[initialRequested]!
    : BUILTIN_THEMES.tokyonight!;
  const initialBuiltinName = Object.hasOwn(BUILTIN_THEMES, initialRequested)
    ? initialRequested
    : "tokyonight";

  const initialSource: ActiveThemeSource = props.initialTheme
    ? {
        name: props.initialTheme.name,
        json: props.initialTheme.json,
        mode: props.initialTheme.mode,
      }
    : {
        name: initialBuiltinName,
        json: initialBuiltinJson,
      };

  const resolveFromSource = (
    source: ActiveThemeSource,
    cfgMode: "dark" | "light",
    transparent: boolean,
  ): Theme => {
    return resolveTheme(source.name, source.json, {
      mode: source.mode ?? cfgMode,
      transparent,
    });
  };

  const initialResolved =
    props.initialTheme?.theme ??
    untrack(() => resolveFromSource(initialSource, config.config().mode, config.config().transparent));

  const [selectedName, setSelectedName] = createSignal<string>(initialSource.name);
  const [previewName, setPreviewName] = createSignal<string | null>(null);
  const [activeSource, setActiveSource] = createSignal<ActiveThemeSource>(initialSource);
  const [theme, setTheme] = createSignal<Theme>(initialResolved);
  const [targetTheme, setTargetTheme] = createSignal<Theme>(initialResolved);

  if (props.initialTheme?.error) {
    status.say(props.initialTheme.error, "error");
  }

  let unsubscribeFrame: (() => void) | null = null;
  let selectAttempt = 0;
  let selectSeq = 0;
  let previewSeq = 0;

  const stopTween = () => {
    if (unsubscribeFrame !== null) {
      unsubscribeFrame();
      unsubscribeFrame = null;
    }
  };

  onCleanup(stopTween);

  const transitionTo = (next: Theme, animate: boolean) => {
    stopTween();
    setTargetTheme(next);
    if (!animate || !untrack(() => config.animations())) {
      setTheme(next);
      return;
    }
    const from = untrack(theme);
    const start = deps.clock.now();
    const duration = 200;
    unsubscribeFrame = deps.clock.onFrame((now) => {
      const elapsed = now - start;
      if (elapsed >= duration) {
        stopTween();
        setTheme(next);
      } else {
        const t = tweenValue(0, 1, elapsed, duration, easeOutCubic);
        setTheme(mixTheme(from, next, t));
      }
    });
  };

  const loadAndResolve = async (
    targetName: string,
    checkSeq: () => boolean,
    onApply: (source: ActiveThemeSource, resolved: Theme) => void,
    sources: ThemeSources = getSources(),
  ): Promise<boolean> => {
    const loaded = await loadThemeJson(targetName, sources);
    const resolved = resolveTheme(targetName, loaded.json, {
      mode: loaded.mode ?? untrack(() => config.config().mode),
      transparent: untrack(() => config.config().transparent),
    });
    if (!checkSeq()) return false;
    onApply({ name: targetName, json: loaded.json, mode: loaded.mode }, resolved);
    return true;
  };

  let prevMode = untrack(() => config.config().mode);
  let prevTransparent = untrack(() => config.config().transparent);

  createComputed(() => {
    const cfg = config.config();
    if (cfg.mode !== prevMode || cfg.transparent !== prevTransparent) {
      prevMode = cfg.mode;
      prevTransparent = cfg.transparent;
      const source = untrack(activeSource);
      const resolved = resolveFromSource(source, cfg.mode, cfg.transparent);
      transitionTo(resolved, false);
    }
  });

  const loadInitial = async () => {
    const sSeq = selectSeq;
    const pSeq = ++previewSeq;
    const requested = untrack(() => config.config().theme);
    try {
      await loadAndResolve(
        requested,
        () => sSeq === selectSeq && pSeq === previewSeq,
        (source, resolved) => {
          setSelectedName(requested);
          setActiveSource(source);
          transitionTo(resolved, false);
        },
      );
    } catch (err) {
      if (sSeq !== selectSeq || pSeq !== previewSeq) return;
      status.say(err instanceof Error ? err.message : String(err), "error");
      const fallbackSource: ActiveThemeSource = {
        name: "tokyonight",
        json: BUILTIN_THEMES.tokyonight!,
      };
      const fallback = resolveFromSource(
        fallbackSource,
        untrack(() => config.config().mode),
        untrack(() => config.config().transparent),
      );
      setSelectedName("tokyonight");
      setActiveSource(fallbackSource);
      transitionTo(fallback, false);
    }
  };

  if (!props.initialTheme) {
    void loadInitial();
  }

  createEffect(() => {
    const currentDisplayed = previewName() ?? selectedName();
    if (currentDisplayed !== "omarchy") return;
    const colorFile = getSources().omarchyColors;
    if (!colorFile) return;

    // The file followed is the one found when the Theme was shown: during a theme switch of Omarchy it is
    // missing for a moment, and then the colours shown stay and nothing is said until it is back.
    const followed: ThemeSources = { themesDir: deps.paths.themesDir, omarchyColors: colorFile };
    const reload = () => {
      if (!existsSync(colorFile)) return;
      const sSeq = selectSeq;
      const pSeq = ++previewSeq;
      void (async () => {
        try {
          await loadAndResolve(
            "omarchy",
            () => sSeq === selectSeq && pSeq === previewSeq && (untrack(previewName) ?? untrack(selectedName)) === "omarchy",
            (source, resolved) => {
              setActiveSource(source);
              transitionTo(resolved, true);
            },
            followed,
          );
        } catch (err) {
          if (sSeq !== selectSeq || pSeq !== previewSeq) return;
          if (!existsSync(colorFile)) return;
          status.say(err instanceof Error ? err.message : String(err), "error");
        }
      })();
    };

    const unwatch = deps.watch(colorFile, reload);
    onCleanup(unwatch);
  });

  let currentSyntax: SyntaxStyle | null = null;
  const syntaxMemo = createMemo<SyntaxStyle>(() => {
    const nextSyntax = createSyntaxStyle(targetTheme(), renderer);
    const prevSyntax = currentSyntax;
    currentSyntax = nextSyntax;
    if (prevSyntax) {
      queueMicrotask(() => {
        prevSyntax.destroy();
      });
    }
    return nextSyntax;
  });

  onCleanup(() => {
    currentSyntax?.destroy();
    currentSyntax = null;
  });

  const api: ThemeApi = {
    theme,
    name: selectedName,
    color(name: ColorName): RGBA {
      return toRGBA(theme()[name]);
    },
    syntax: syntaxMemo,
    list(): Promise<ThemeInfo[]> {
      return listThemes(getSources());
    },
    async preview(name: string | null): Promise<void> {
      const sSeq = selectSeq;
      const pSeq = ++previewSeq;
      await Promise.resolve();
      const targetName = name ?? untrack(selectedName);
      await loadAndResolve(
        targetName,
        () => sSeq === selectSeq && pSeq === previewSeq,
        (source, resolved) => {
          setPreviewName(name);
          setActiveSource(source);
          transitionTo(resolved, true);
        },
      );
    },
    async select(name: string): Promise<void> {
      const attempt = ++selectAttempt;
      const loaded = await loadThemeJson(name, getSources());
      if (attempt <= selectSeq) return;
      const resolved = resolveTheme(name, loaded.json, {
        mode: loaded.mode ?? untrack(() => config.config().mode),
        transparent: untrack(() => config.config().transparent),
      });
      selectSeq = attempt;
      previewSeq++;
      setPreviewName(null);
      setSelectedName(name);
      setActiveSource({ name, json: loaded.json, mode: loaded.mode });
      transitionTo(resolved, true);
      await Promise.resolve();
      if (selectSeq !== attempt) return;
      await config.set((c) => ({ ...c, theme: untrack(selectedName) }));
    },
    async setTransparent(on: boolean): Promise<void> {
      await config.set((c) => ({ ...c, transparent: on }));
    },
  };

  props.expose?.(api);

  return <ThemeContext.Provider value={api}>{props.children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeApi {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
