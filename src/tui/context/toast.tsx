import {
  createContext,
  createSignal,
  type JSX,
  onCleanup,
  type ParentProps,
  useContext,
} from "solid-js";
import { useDeps } from "./deps";

export type ToastKind = "info" | "success" | "warning" | "error";

export interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
  title?: string;
}

export interface ToastApi {
  show(toast: { message: string; kind?: ToastKind; title?: string; duration?: number }): void;
  items(): Toast[];
}

const ToastContext = createContext<ToastApi>();

export function ToastProvider(
  props: ParentProps<{ expose?: (api: ToastApi) => void }>,
): JSX.Element {
  const deps = useDeps();
  const [items, setItems] = createSignal<Toast[]>([]);
  const timers = new Set<() => void>();
  let nextId = 1;

  onCleanup(() => {
    for (const cancel of timers) {
      cancel();
    }
    timers.clear();
  });

  const api: ToastApi = {
    show(toast) {
      const id = nextId++;
      const entry: Toast = {
        id,
        message: toast.message,
        kind: toast.kind ?? "info",
        title: toast.title,
      };
      setItems((prev) => [...prev, entry]);
      const duration = toast.duration ?? 4000;
      const cancel = deps.clock.after(duration, () => {
        timers.delete(cancel);
        setItems((prev) => prev.filter((item) => item.id !== id));
      });
      timers.add(cancel);
    },
    items,
  };

  props.expose?.(api);

  return <ToastContext.Provider value={api}>{props.children}</ToastContext.Provider>;
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}
