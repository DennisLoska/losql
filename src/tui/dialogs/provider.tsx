import { createMemo, createSignal, type JSX, Show } from "solid-js";
import type { ProviderStatus } from "../../core/agent/detect";
import { PROVIDERS } from "../../core/agent/providers";
import { ProviderError, type ProviderErrorKind, runProvider } from "../../core/agent/run";
import { PROVIDER_IDS, type ProviderId } from "../../core/config";
import type { AppApi } from "../app";
import { errorAdvice } from "../panes/agent/transcript-model";
import { printable } from "../ui/printable";
import { DialogSelect, type SelectOption } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { openModels } from "./model";
import {
  isValidModelName,
  markProviderSaveFailed,
  registerQuitCancel,
  resolveProviderPath,
  takeProviderSaveFailed,
} from "./shared";

export const DATA_NOTICE =
  'The agent sends your schema, the statements involved and up to 50 rows per query to the provider you choose. Set agent.dataAccess to "schema" to keep rows on this machine.';

const activeProviders = new WeakMap<AppApi, Promise<ProviderId | "none" | null>>();

const PROVIDERS_DIALOG_WIDTH = 80;

async function runProviderTest(
  api: AppApi,
  id: ProviderId,
  model: string | null,
  signal?: AbortSignal,
): Promise<{ ok: boolean; message: string; kind: ProviderErrorKind }> {
  const adapter = PROVIDERS[id];
  const effectiveModel = model === "default" ? null : model;
  if (effectiveModel !== null && !isValidModelName(effectiveModel)) {
    return {
      ok: false,
      message: `Not a model name: ${printable(effectiveModel)}`,
      kind: "other",
    };
  }

  const binPath = resolveProviderPath(api, id);
  if (!binPath) {
    return {
      ok: false,
      message: `${adapter.label} could not be started: not found`,
      kind: "missing",
    };
  }

  const start = api.deps.clock.now();
  try {
    await runProvider(
      adapter,
      {
        prompt: "Reply with the single word: ok",
        system: "You are a connectivity check. Reply with one word.",
        model: effectiveModel,
      },
      {
        exec: api.deps.exec,
        binPath,
        env: api.deps.env,
        connections: api.config.config().connections,
        signal,
        timeoutMs: 60000,
      },
    );
    const seconds = Math.max(0, (api.deps.clock.now() - start) / 1000);
    return {
      ok: true,
      message: `replied in ${seconds.toFixed(1)}s`,
      kind: "other",
    };
  } catch (err) {
    if (err instanceof ProviderError) {
      return {
        ok: false,
        message: err.message,
        kind: err.kind,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: msg,
      kind: "other",
    };
  }
}

export async function testProvider(
  api: AppApi,
  id: ProviderId,
  model: string | null,
): Promise<{ ok: boolean; message: string }> {
  const controller = new AbortController();
  const offQuit = registerQuitCancel(api, () => {
    controller.abort();
  });
  try {
    const res = await runProviderTest(api, id, model, controller.signal);
    return { ok: res.ok, message: res.message };
  } finally {
    offQuit();
  }
}

type FailedAction = "retry" | "another" | "anyway";

function selectFailedTestAction(
  api: AppApi,
  label: string,
  errorMessage: string,
  advice: string,
  onOpen: (close: () => void) => void,
): Promise<FailedAction | null> {
  return new Promise<FailedAction | null>((resolve) => {
    let settled = false;
    const options: SelectOption<FailedAction>[] = [
      { title: "Try again", value: "retry" },
      { title: "Choose another", value: "another" },
      { title: "Use it anyway", value: "anyway" },
    ];
    const close = api.dialog.open(
      (closeSelf) => (
        <DialogSelect
          title={`${printable(label)} did not answer`}
          panelWidth={PROVIDERS_DIALOG_WIDTH}
          notice={{ text: errorMessage, kind: "error" }}
          description={advice.length > 0 ? printable(advice, { keepNewlines: true }) : undefined}
          options={options}
          onSelect={(opt) => {
            if (settled) return;
            settled = true;
            resolve(opt.value);
            closeSelf();
          }}
        />
      ),
      {
        width: PROVIDERS_DIALOG_WIDTH,
        onClose() {
          if (!settled) {
            settled = true;
            resolve(null);
          }
        },
      },
    );
    onOpen(close);
  });
}

type ProviderChoice = ProviderId | "none";

function shortenHomePath(path: string, home: string | undefined): string {
  const cleanHome = home?.trim().replace(/\/+$/, "");
  if (!cleanHome) return path;
  if (path === cleanHome) return "~";
  if (path.startsWith(`${cleanHome}/`)) {
    return `~${path.slice(cleanHome.length)}`;
  }
  return path;
}

function buildProviderOptions(
  statuses: ProviderStatus[],
  home: string | undefined,
): SelectOption<ProviderChoice>[] {
  const byId = new Map<ProviderId, ProviderStatus>();
  for (const s of statuses) {
    byId.set(s.id, s);
  }

  const options: SelectOption<ProviderChoice>[] = [];
  for (const id of PROVIDER_IDS) {
    const adapter = PROVIDERS[id];
    const st = byId.get(id);
    const installed = Boolean(st?.installed && st.path);
    const label = st?.label ?? adapter.label;
    const installHint = st?.installHint ?? adapter.installHint;

    if (installed && st?.path) {
      const ver = st.version ? printable(st.version) : "version unknown";
      const displayPath = shortenHomePath(st.path, home);
      options.push({
        title: printable(label),
        description: `${ver} · ${printable(displayPath)}`,
        value: id,
      });
    } else {
      options.push({
        title: printable(label),
        description: `not found · ${printable(installHint)}`,
        disabled: true,
        value: id,
      });
    }
  }

  options.push({
    title: "Continue without an agent",
    description: "You can set one up later with space p",
    value: "none",
  });

  return options;
}

/** Resolves with the chosen Provider, "none" for "Continue without an agent", or null when dismissed. */
export function openProviders(
  api: AppApi,
  options?: { step?: string },
): Promise<ProviderId | "none" | null> {
  const existing = activeProviders.get(api);
  if (existing) return existing;
  takeProviderSaveFailed(api);

  // Set while the dialog is being opened: undoes what this call registered and started when opening throws.
  const opening: { undo: (() => void) | null } = { undo: null };
  const promise = new Promise<ProviderId | "none" | null>((resolve) => {
    let settled = false;
    let busy = false;
    let closeMain: (() => void) | null = null;
    let closeFailedSub: (() => void) | null = null;
    let activeTestController: AbortController | null = null;

    const [detected, setDetected] = createSignal(api.agent.providers().length === 4);
    const [testingLabel, setTestingLabel] = createSignal<string | null>(null);

    const finish = (value: ProviderId | "none" | null) => {
      if (settled) return;
      settled = true;
      offQuit();
      activeProviders.delete(api);
      activeTestController?.abort();
      activeTestController = null;
      closeFailedSub?.();
      closeFailedSub = null;
      resolve(value);
    };

    const offQuit = registerQuitCancel(api, () => {
      finish(null);
      closeMain?.();
    });

    const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

    /**
     * A save that failed is not a choice: the configuration and state in memory go back to what
     * they were, the toast names the file, and the dialog resolves null.
     */
    const failSave = async (
      what: "config" | "state",
      err: unknown,
      rollback: () => Promise<void>,
      close: () => void,
    ) => {
      await rollback().catch(() => {});
      api.toast.show({
        message: printable(`Could not save ${what}: ${errorText(err)}`),
        kind: "error",
      });
      if (settled) return;
      markProviderSaveFailed(api);
      finish(null);
      close();
    };

    const saveAndFinish = async (
      id: ProviderId,
      modelToSave: string | null,
      ok: boolean,
      message: string,
      close: () => void,
    ) => {
      if (settled) return;
      const adapter = PROVIDERS[id];
      const at = new Date(api.deps.now()).toISOString();
      const prevAgent = api.config.config().agent;
      const prevTests = api.config.state().providerTests;
      const restoreConfig = () => api.config.set((c) => ({ ...c, agent: prevAgent }));
      try {
        await api.config.set((c) => ({
          ...c,
          agent: { ...c.agent, provider: id, model: modelToSave },
        }));
      } catch (err) {
        await failSave("config", err, restoreConfig, close);
        return;
      }
      try {
        await api.config.setState({
          providerTests: {
            ...prevTests,
            [id]: { ok, at, message },
          },
        });
      } catch (err) {
        await failSave(
          "state",
          err,
          async () => {
            await Promise.allSettled([
              restoreConfig(),
              api.config.setState({ providerTests: prevTests }),
            ]);
          },
          close,
        );
        return;
      }
      if (settled) return;
      if (ok) {
        api.toast.show({
          kind: "success",
          message: `${printable(adapter.label)} is ready (${printable(message)})`,
        });
      } else {
        api.toast.show({
          kind: "warning",
          message: `${printable(adapter.label)} was saved, but its test failed`,
        });
      }
      finish(id);
      close();
    };

    opening.undo = () => {
      settled = true;
      offQuit();
      activeTestController?.abort();
      activeTestController = null;
    };
    closeMain = api.dialog.open(
      (close): JSX.Element => {
        const title = () =>
          options?.step ? `${options.step} · Choose your agent` : "Choose your agent";

        const selectOptions = createMemo<SelectOption<ProviderChoice>[]>(() =>
          buildProviderOptions(api.agent.providers(), api.deps.env.HOME),
        );

        const currentChoice = createMemo<ProviderChoice | undefined>(
          () => api.config.config().agent.provider ?? undefined,
        );

        const handleSelect = async (opt: SelectOption<ProviderChoice>) => {
          if (busy || settled) return;
          const choice = opt.value;

          if (choice === "none") {
            busy = true;
            try {
              const prevAgent = api.config.config().agent;
              try {
                await api.config.set((c) => ({
                  ...c,
                  agent: { ...c.agent, provider: null, model: null },
                }));
              } catch (err) {
                await failSave(
                  "config",
                  err,
                  () => api.config.set((c) => ({ ...c, agent: prevAgent })),
                  close,
                );
                return;
              }
              if (settled) return;
              finish("none");
              close();
            } finally {
              busy = false;
            }
            return;
          }

          busy = true;
          try {
            const chosenModel = await openModels(api, choice, options);
            if (settled || chosenModel === null) {
              return;
            }

            const modelToSave = chosenModel === "default" ? null : chosenModel;
            const adapter = PROVIDERS[choice];

            while (!settled) {
              const controller = new AbortController();
              activeTestController = controller;
              setTestingLabel(adapter.label);

              let testResult: { ok: boolean; message: string; kind: ProviderErrorKind };
              try {
                testResult = await runProviderTest(api, choice, modelToSave, controller.signal);
              } finally {
                if (activeTestController === controller) {
                  activeTestController = null;
                }
                if (!settled) {
                  setTestingLabel(null);
                }
              }

              if (settled || controller.signal.aborted) {
                return;
              }

              if (testResult.ok) {
                await saveAndFinish(choice, modelToSave, true, testResult.message, close);
                return;
              }

              const advice = errorAdvice(testResult.kind, {
                label: adapter.label,
                binary: adapter.binaries[0] ?? choice,
                installHint: adapter.installHint,
              });

              const action = await selectFailedTestAction(
                api,
                adapter.label,
                testResult.message,
                advice,
                (closeSub) => {
                  closeFailedSub = closeSub;
                },
              );
              closeFailedSub = null;

              if (settled) {
                return;
              }

              if (action === "retry") {
                continue;
              }
              if (action === "anyway") {
                await saveAndFinish(choice, modelToSave, false, testResult.message, close);
                return;
              }
              return;
            }
          } finally {
            busy = false;
          }
        };

        return (
          <Show
            when={detected()}
            fallback={<Spinner label="Detecting agents…" />}
          >
            <Show
              when={testingLabel() === null}
              fallback={<Spinner label={`Testing ${printable(testingLabel()!)}…`} />}
            >
              <DialogSelect
                title={title()}
                panelWidth={PROVIDERS_DIALOG_WIDTH}
                description={DATA_NOTICE}
                options={selectOptions()}
                current={currentChoice()}
                onSelect={(opt) => {
                  // A failure here (the Model dialog that could not open) is reported; the
                  // Provider dialog stays open and usable.
                  handleSelect(opt).catch((err: unknown) => {
                    api.status.say(err instanceof Error ? err.message : String(err), "error");
                  });
                }}
              />
            </Show>
          </Show>
        );
      },
      {
        width: PROVIDERS_DIALOG_WIDTH,
        onClose() {
          finish(null);
        },
      },
    );

    opening.undo = null;

    void api.agent
      .detect()
      .catch((err: unknown) => {
        if (!settled) {
          api.status.say(err instanceof Error ? err.message : String(err), "error");
        }
      })
      .finally(() => {
        if (!settled) {
          setDetected(true);
        }
      });
  });

  if (opening.undo) {
    // Opening failed: the promise holds the rejection and is not kept, so the next call opens anew.
    opening.undo();
    return promise;
  }
  activeProviders.set(api, promise);
  return promise;
}
