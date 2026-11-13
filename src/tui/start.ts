import type { CliRenderer } from "@opentui/core";
import { render, useRenderer } from "@opentui/solid";
import { onCleanup } from "solid-js";
import { loadConfig } from "../core/config";
import { loadState } from "../core/state";
import { App, type Loaded, type TuiArgs } from "./app";
import { loadInitialTheme } from "./context/theme";
import { type AppDeps, realDeps } from "./deps";

export async function startTui(args: TuiArgs, deps: AppDeps = realDeps()): Promise<void> {
  let activeRenderer: CliRenderer | null = null;
  let destroyPromise: Promise<void> | null = null;
  let tearingDown = false;

  const formatFatal = (err: unknown): string =>
    err instanceof Error ? err.stack ?? err.message : String(err);

  const handleFatalDuringTeardown = (err: unknown) => {
    process.off("uncaughtException", handleFatalDuringTeardown);
    process.off("unhandledRejection", handleFatalDuringTeardown);
    process.stderr.write(`${formatFatal(err)}\n`);
    deps.exit(1);
  };

  const removeAllFatalHandlers = () => {
    process.off("uncaughtException", handleFatal);
    process.off("unhandledRejection", handleFatal);
    process.off("uncaughtException", handleFatalDuringTeardown);
    process.off("unhandledRejection", handleFatalDuringTeardown);
  };

  const enterTeardownFatalMode = () => {
    if (tearingDown) return;
    tearingDown = true;
    process.off("uncaughtException", handleFatal);
    process.off("unhandledRejection", handleFatal);
    process.on("uncaughtException", handleFatalDuringTeardown);
    process.on("unhandledRejection", handleFatalDuringTeardown);
  };

  const safeDestroy = (): Promise<void> => {
    if (destroyPromise) return destroyPromise;
    destroyPromise = (async () => {
      const renderer = activeRenderer;
      if (!renderer) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        renderer.destroy();
        await Promise.race([
          renderer.closed,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 500);
          }),
        ]);
      } catch {
        // Ignore errors while destroying renderer
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    })();
    return destroyPromise;
  };

  const handleFatal = (err: unknown) => {
    void (async () => {
      enterTeardownFatalMode();
      await safeDestroy();
      removeAllFatalHandlers();
      process.stderr.write(`${formatFatal(err)}\n`);
      deps.exit(1);
    })();
  };

  process.on("uncaughtException", handleFatal);
  process.on("unhandledRejection", handleFatal);

  try {
    const configLoaded = await loadConfig(deps.paths);
    const state = await loadState(deps.paths);
    const initialTheme = await loadInitialTheme(
      deps,
      args.theme ?? configLoaded.config.theme,
      configLoaded.config.mode,
      args.transparent ?? configLoaded.config.transparent,
    );
    const loaded: Loaded = { ...configLoaded, state, initialTheme };

    const wrappedDeps: AppDeps = {
      ...deps,
      exit(code: number) {
        void (async () => {
          enterTeardownFatalMode();
          await safeDestroy();
          removeAllFatalHandlers();
          deps.exit(code);
        })();
      },
    };

    await render(
      () => {
        activeRenderer = useRenderer();
        onCleanup(() => {
          if (!tearingDown) {
            removeAllFatalHandlers();
          }
        });
        return App({ deps: wrappedDeps, args, loaded });
      },
      { exitOnCtrlC: false, useMouse: false, targetFps: 60 },
    );
  } catch (err) {
    enterTeardownFatalMode();
    await safeDestroy();
    removeAllFatalHandlers();
    throw err;
  }
}
