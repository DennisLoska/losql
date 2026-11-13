import { createMemo, createSignal, type JSX, Show } from "solid-js";
import type { ThemeInfo } from "../../core/theme/registry";
import type { AppApi } from "../app";
import { printable } from "../ui/printable";
import { DialogSelect, type SelectOption } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { registerQuitCancel } from "./shared";

const activeThemes = new WeakMap<AppApi, Promise<string | null>>();

function sourceDescription(source: ThemeInfo["source"]): string {
  if (source === "omarchy") return "follows Omarchy";
  if (source === "user") return "yours";
  return "built in";
}

/** Resolves with the saved theme name, or null when dismissed. */
export function openThemes(
  api: AppApi,
  options?: { step?: string; preselect?: string },
): Promise<string | null> {
  const existing = activeThemes.get(api);
  if (existing) return existing;

  // Set while the dialog is being opened: undoes what this call registered and started when opening throws.
  const opening: { undo: (() => void) | null } = { undo: null };
  const promise = new Promise<string | null>((resolve) => {
    let settled = false;
    let selecting = false;
    let closeDialog: (() => void) | null = null;
    const [themes, setThemes] = createSignal<ThemeInfo[] | null>(null);

    const safePreview = async (name: string | null) => {
      try {
        await api.theme.preview(name);
      } catch (err) {
        if (!settled) {
          api.status.say(err instanceof Error ? err.message : String(err), "error");
        }
      }
    };

    const dismiss = async () => {
      if (settled) return;
      settled = true;
      offQuit();
      activeThemes.delete(api);
      await api.theme.preview(null).catch(() => {});
      resolve(null);
    };

    const offQuit = registerQuitCancel(api, async () => {
      if (settled) return;
      if (!selecting) {
        await dismiss();
      }
      closeDialog?.();
    });

    opening.undo = () => {
      settled = true;
      offQuit();
    };
    closeDialog = api.dialog.open(
      (close): JSX.Element => {
        const title = () =>
          options?.step ? `${options.step} · Pick a look` : "Themes";

        const selectOptions = createMemo<SelectOption<string>[]>(() => {
          const list = themes() ?? [];
          return list.map((info) => ({
            title: printable(info.name),
            description: sourceDescription(info.source),
            value: info.name,
          }));
        });

        const currentTheme = () => options?.preselect ?? api.theme.name();

        const handleSelect = async (opt: SelectOption<string>) => {
          if (settled || selecting) return;
          selecting = true;
          offQuit();
          activeThemes.delete(api);
          close();
          let chosen: string | null = opt.value;
          try {
            await api.theme.select(opt.value);
          } catch (err) {
            // The Theme was not applied or not saved: that is not a choice.
            chosen = null;
            const msg = err instanceof Error ? err.message : String(err);
            api.toast.show({
              message: printable(`Theme could not be saved: ${msg}`),
              kind: "error",
            });
          }
          if (!settled) {
            settled = true;
            resolve(chosen);
          }
        };

        return (
          <Show
            when={themes() !== null}
            fallback={<Spinner label="Loading themes…" />}
          >
            <DialogSelect
              title={title()}
              options={selectOptions()}
              current={currentTheme()}
              onMove={(opt) => {
                if (settled || selecting || !opt) return;
                void safePreview(opt.value);
              }}
              actions={[
                {
                  key: "<C-t>",
                  label: () =>
                    `transparent: ${api.config.config().transparent ? "on" : "off"}`,
                  run: () => {
                    if (settled || selecting) return;
                    void api.theme
                      .setTransparent(!api.config.config().transparent)
                      .catch((err) => {
                        const msg = err instanceof Error ? err.message : String(err);
                        api.toast.show({
                          message: printable(`Config could not be saved: ${msg}`),
                          kind: "error",
                        });
                      });
                  },
                },
              ]}
              onSelect={(opt) => {
                handleSelect(opt).catch((err: unknown) => {
                  api.status.say(err instanceof Error ? err.message : String(err), "error");
                  if (!settled) {
                    settled = true;
                    resolve(null);
                  }
                });
              }}
            />
          </Show>
        );
      },
      {
        onClose() {
          if (!settled && !selecting) {
            void dismiss();
          }
        },
      },
    );

    opening.undo = null;

    void api.theme
      .list()
      .then((list) => {
        if (settled || selecting) return;
        setThemes(list);
        if (options?.preselect && options.preselect !== api.theme.name()) {
          void safePreview(options.preselect);
        }
      })
      .catch((err) => {
        if (settled || selecting) return;
        api.status.say(err instanceof Error ? err.message : String(err), "error");
        setThemes([]);
      });
  });

  if (opening.undo) {
    // Opening failed: the promise holds the rejection and is not kept, so the next call opens anew.
    opening.undo();
    return promise;
  }
  activeThemes.set(api, promise);
  return promise;
}
