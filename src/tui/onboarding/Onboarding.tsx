import { existsSync } from "node:fs";
import { createSignal, type JSX, onCleanup } from "solid-js";
import { omarchyColorsPath } from "../../core/theme/registry";
import type { AppApi } from "../app";
import { openConnections } from "../dialogs/connections";
import { openProviders } from "../dialogs/provider";
import { takeProviderSaveFailed } from "../dialogs/shared";
import { openThemes } from "../dialogs/theme";
import { printable } from "../ui/printable";
import { Welcome } from "./Welcome";

export type OnboardingStep = "welcome" | "connect" | "agent" | "look" | "done";

export function Onboarding(props: {
  onDone: () => void;
  api: AppApi;
  rawConfig: Record<string, unknown>;
  exposeStep?: (step: () => OnboardingStep) => void;
}): JSX.Element {
  const [step, setStep] = createSignal<OnboardingStep>("welcome");
  props.exposeStep?.(step);

  const api = props.api;
  let stopped = false;
  let busy = false;
  let skippedConnect = false;

  onCleanup(() => {
    stopped = true;
  });

  api.onQuit(() => {
    stopped = true;
  });

  const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

  const finish = async (): Promise<void> => {
    try {
      await api.config.setState({ onboarded: true });
    } catch (err) {
      if (!stopped) {
        api.toast.show({
          message: printable(`State could not be saved: ${errorText(err)}`),
          kind: "warning",
        });
      }
    }
    if (stopped) return;
    setStep("done");
    props.onDone();
    api.toast.show({
      message: "You are set. Press space for the menu and F1 for help.",
    });
    if (
      api.session.status() !== "connected" &&
      api.session.status() !== "connecting"
    ) {
      void openConnections(api).catch((err: unknown) => {
        api.status.say(printable(errorText(err)), "error");
      });
    }
  };

  const resolvePreselect = async (): Promise<string | undefined> => {
    if (props.rawConfig.theme !== undefined) {
      return undefined;
    }
    const omarchyFile =
      api.deps.env.LOSQL_OMARCHY_COLORS ??
      omarchyColorsPath(api.deps.env, api.deps.home, existsSync);
    if (omarchyFile && existsSync(omarchyFile)) {
      return "omarchy";
    }
    try {
      const list = await api.theme.list();
      return list.some((t) => t.name === "omarchy") ? "omarchy" : undefined;
    } catch {
      return undefined;
    }
  };

  /** Shows one step and answers the step that comes next. */
  const runStep = async (current: "connect" | "agent" | "look"): Promise<OnboardingStep> => {
    setStep(current);
    if (current === "connect") {
      const connected = await openConnections(api, { step: "Step 1 of 3" });
      return connected ? "agent" : "welcome";
    }
    if (current === "agent") {
      takeProviderSaveFailed(api);
      const chosen = await openProviders(api, { step: "Step 2 of 3" });
      if (chosen !== null) return "look";
      // A choice that could not be saved stays on this step; the toast says why.
      if (takeProviderSaveFailed(api)) return "agent";
      return skippedConnect ? "welcome" : "connect";
    }
    const preselect = await resolvePreselect();
    if (stopped) return "welcome";
    const chosen = await openThemes(api, {
      step: "Step 3 of 3",
      ...(preselect !== undefined ? { preselect } : {}),
    });
    return chosen !== null ? "done" : "agent";
  };

  /**
   * Drives the steps from `first` until the onboarding is back on the welcome screen or done. One
   * loop awaits one step at a time, so going back and forth leaves nothing pending. A failure in a
   * step is reported on the status line and brings back the welcome screen.
   */
  const run = async (first: "connect" | "agent" | "done"): Promise<void> => {
    if (stopped || busy || step() === "done") return;
    busy = true;
    try {
      let next: OnboardingStep = first;
      while (!stopped && (next === "connect" || next === "agent" || next === "look")) {
        next = await runStep(next);
      }
      if (stopped) return;
      if (next === "done") {
        await finish();
      } else {
        setStep("welcome");
      }
    } catch (err) {
      if (!stopped) {
        api.status.say(printable(errorText(err)), "error");
        setStep("welcome");
      }
    } finally {
      busy = false;
    }
  };

  const removeLayer = api.keys.pushLayer(
    (key) => {
      if (stopped || step() !== "welcome" || busy) return false;
      if (api.dialog.depth() > 0 || api.cmdline.active()) return false;

      if (!key.ctrl && !key.meta && (key.name === "return" || key.name === "enter")) {
        if (api.session.status() === "connected" && api.session.connection() !== null) {
          skippedConnect = true;
          void run("agent");
        } else {
          skippedConnect = false;
          void run("connect");
        }
        return true;
      }

      if (!key.ctrl && !key.meta && key.name === "escape") {
        void run("done");
        return true;
      }

      return false;
    },
    { modal: false },
  );

  onCleanup(removeLayer);

  return <Welcome />;
}
