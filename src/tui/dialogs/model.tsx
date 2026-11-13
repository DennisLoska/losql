import { createMemo, createSignal, type JSX, Show } from "solid-js";
import { listModels } from "../../core/agent/detect";
import { PROVIDERS } from "../../core/agent/providers";
import type { ProviderId } from "../../core/config";
import type { AppApi } from "../app";
import { printable } from "../ui/printable";
import { DialogSelect, type SelectOption } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { isValidModelName, registerQuitCancel, resolveProviderPath } from "./shared";

const MODELS_NOT_LISTED = "Models could not be listed; you can still type a name";

const activeModels = new WeakMap<AppApi, Promise<string | null>>();

/** Resolves with the Model ("default" included), or null when dismissed. Does not save. */
export function openModels(
  api: AppApi,
  id: ProviderId,
  options?: { step?: string },
): Promise<string | null> {
  const existing = activeModels.get(api);
  if (existing) return existing;

  // Set while the dialog is being opened: undoes what this call registered and started when opening throws.
  const opening: { undo: (() => void) | null } = { undo: null };
  const promise = new Promise<string | null>((resolve) => {
    let settled = false;
    let closeDialog: (() => void) | null = null;
    const controller = new AbortController();
    const [models, setModels] = createSignal<string[] | null>(null);
    const [notice, setNotice] = createSignal<{ text: string; kind: "info" | "error" } | null>(null);

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      offQuit();
      activeModels.delete(api);
      controller.abort();
      resolve(value);
    };

    const offQuit = registerQuitCancel(api, () => {
      finish(null);
      closeDialog?.();
    });

    opening.undo = () => {
      settled = true;
      offQuit();
      controller.abort();
    };
    closeDialog = api.dialog.open(
      (close): JSX.Element => {
        const title = () =>
          options?.step ? `${options.step} · Choose a model` : "Choose a model";

        const currentModel = createMemo<string | undefined>(() => {
          const agentCfg = api.config.config().agent;
          if (agentCfg.provider !== id) return undefined;
          return agentCfg.model ?? "default";
        });

        const selectOptions = createMemo<SelectOption<string>[]>(() => {
          const list = models() ?? [];
          return list.map((m) => ({
            title: printable(m),
            value: m,
          }));
        });

        return (
          <Show
            when={models() !== null}
            fallback={<Spinner label="Loading models…" />}
          >
            <DialogSelect
              title={title()}
              notice={notice()}
              options={selectOptions()}
              current={currentModel()}
              custom={(text) => ({
                title: `Use "${printable(text)}"`,
                value: text,
              })}
              onSelect={(opt) => {
                if (!isValidModelName(opt.value)) {
                  // A refused name keeps the dialog open so that the typed text can be corrected.
                  const reason = `Not a model name: ${printable(opt.value)}`;
                  api.status.say(reason, "error");
                  setNotice({ text: reason, kind: "error" });
                  return;
                }
                finish(opt.value);
                close();
              }}
            />
          </Show>
        );
      },
      {
        onClose() {
          finish(null);
        },
      },
    );

    opening.undo = null;

    const adapter = PROVIDERS[id];
    const binPath = resolveProviderPath(api, id);

    void (async () => {
      let rawModels: string[];
      // listModels falls back to the static list when the CLI fails; the exec it is given
      // tells a failed listing from an empty one.
      let listingFailed = false;
      if (binPath) {
        rawModels = await listModels(adapter, binPath, async (req) => {
          try {
            const res = await api.deps.exec({ ...req, signal: controller.signal });
            if (res.code !== 0 || res.timedOut || res.aborted) listingFailed = true;
            return res;
          } catch (err) {
            listingFailed = true;
            throw err;
          }
        }, api.deps.env, api.config.config().connections);
      } else {
        rawModels = [...adapter.staticModels];
      }
      if (settled) return;
      if (listingFailed) {
        setNotice({ text: MODELS_NOT_LISTED, kind: "info" });
      }

      const valid: string[] = [];
      const seen = new Set<string>();
      for (const m of rawModels) {
        if (isValidModelName(m) && !seen.has(m)) {
          seen.add(m);
          valid.push(m);
        }
      }
      if (valid.length === 0) {
        valid.push("default");
      }
      setModels(valid);
    })();
  });

  if (opening.undo) {
    // Opening failed: the promise holds the rejection and is not kept, so the next call opens anew.
    opening.undo();
    return promise;
  }
  activeModels.set(api, promise);
  return promise;
}
