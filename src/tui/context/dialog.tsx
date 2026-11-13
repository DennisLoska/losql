import {
  createContext,
  createSignal,
  For,
  type JSX,
  onCleanup,
  type ParentProps,
  untrack,
  useContext,
} from "solid-js";
import { type ConfirmProps, DialogConfirm } from "../ui/confirm";
import { DialogHost } from "../ui/dialog";
import { DialogPrompt, type PromptProps } from "../ui/prompt";
import { DialogSelect, type SelectProps } from "../ui/select";
import { useKeys } from "./keys";
import { type StatusApi, useStatus } from "./status";

export interface DialogApi {
  open(
    render: (close: () => void) => JSX.Element,
    options?: { onClose?: () => void; width?: number },
  ): () => void;
  close(): void;
  clear(): void;
  depth(): number;
  select<T>(props: SelectProps<T>): Promise<T | null>;
  prompt(props: PromptProps): Promise<string | null>;
  confirm(props: ConfirmProps): Promise<boolean>;
}

interface DialogEntry {
  id: number;
  render: (close: () => void) => JSX.Element;
  width?: number;
  onClose?: () => void;
  removeModalLayer: () => void;
  close: () => void;
  closed: boolean;
}

const DialogContext = createContext<DialogApi>();

function DialogEntryRender(props: { entry: DialogEntry }): JSX.Element {
  return untrack(() => props.entry.render(props.entry.close));
}

export function DialogProvider(
  props: ParentProps<{ expose?: (api: DialogApi) => void }>,
): JSX.Element {
  const keys = useKeys();
  let status: StatusApi | null = null;
  try {
    status = useStatus();
  } catch {
    status = null;
  }
  const [stack, setStack] = createSignal<DialogEntry[]>([]);
  let nextId = 1;

  const closeEntry = (entry: DialogEntry) => {
    if (entry.closed) return;
    entry.closed = true;
    entry.removeModalLayer();
    setStack((prev) => prev.filter((item) => item !== entry));
    entry.onClose?.();
  };

  const api: DialogApi = {
    open(render, options) {
      const id = nextId++;
      let entry!: DialogEntry;
      const close = () => closeEntry(entry);

      const removeModalLayer = keys.pushLayer(
        (key) => {
          if (
            (!key.ctrl && !key.meta && key.name === "escape") ||
            (key.ctrl && !key.meta && key.name === "c")
          ) {
            close();
            return true;
          }
          return false;
        },
        { modal: true },
      );

      entry = {
        id,
        render,
        width: options?.width,
        onClose: options?.onClose,
        removeModalLayer,
        close,
        closed: false,
      };

      setStack((prev) => [...prev, entry]);
      return close;
    },
    close() {
      const current = stack();
      const top = current[current.length - 1];
      if (top) closeEntry(top);
    },
    clear() {
      const current = [...stack()].reverse();
      let firstError: unknown;
      let hasError = false;
      for (const entry of current) {
        try {
          closeEntry(entry);
        } catch (err) {
          if (!hasError) {
            hasError = true;
            firstError = err;
          }
        }
      }
      if (hasError) {
        throw firstError;
      }
    },
    depth() {
      return stack().length;
    },
    select<T>(selectProps: SelectProps<T>): Promise<T | null> {
      return new Promise<T | null>((resolve) => {
        let settled = false;
        api.open(
          (close) => (
            <DialogSelect
              {...selectProps}
              onSelect={(option) => {
                if (settled) return;
                settled = true;
                resolve(option.value);
                close();
              }}
            />
          ),
          {
            onClose() {
              if (!settled) {
                settled = true;
                resolve(null);
              }
            },
          },
        );
      });
    },
    prompt(promptProps: PromptProps): Promise<string | null> {
      return new Promise<string | null>((resolve) => {
        let settled = false;
        api.open(
          (close) => (
            <DialogPrompt
              {...promptProps}
              onSubmit={(value) => {
                if (settled) return;
                settled = true;
                resolve(value);
                close();
              }}
            />
          ),
          {
            onClose() {
              if (!settled) {
                settled = true;
                resolve(null);
              }
            },
          },
        );
      });
    },
    confirm(confirmProps: ConfirmProps): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        let settled = false;
        api.open(
          (close) => (
            <DialogConfirm
              {...confirmProps}
              onAnswer={(confirmed) => {
                if (settled) return;
                settled = true;
                resolve(confirmed);
                close();
              }}
            />
          ),
          {
            onClose() {
              if (!settled) {
                settled = true;
                resolve(false);
              }
            },
          },
        );
      });
    },
  };

  onCleanup(() => {
    try {
      api.clear();
    } catch (err) {
      try {
        status?.say(err instanceof Error ? err.message : String(err), "error");
      } catch {
        // Swallowed if status context is unavailable
      }
    }
  });
  props.expose?.(api);


  return (
    <DialogContext.Provider value={api}>
      {props.children}
      <For each={stack()}>
        {(entry, index) => (
          <DialogHost width={entry.width} zIndex={100 + index() * 10}>
            <DialogEntryRender entry={entry} />
          </DialogHost>
        )}
      </For>
    </DialogContext.Provider>
  );
}

export function useDialog(): DialogApi {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("useDialog must be used within a DialogProvider");
  return ctx;
}
