import { type Accessor, createContext, createSignal, type JSX, type ParentProps, useContext } from "solid-js";
import { printable } from "../ui/printable";
import type { PaneId } from "./focus";

export interface PaneStatus {
  mode: string;
  pending: string;
  position: string;
}

export interface StatusApi {
  register(pane: PaneId, status: Accessor<PaneStatus>): void;
  current(): PaneStatus;
  message(): { text: string; kind: "info" | "error" } | null;
  say(text: string, kind?: "info" | "error"): void;
  clear(): void;
}

interface InternalStatusContext {
  api: StatusApi;
  setFocusedPane: (pane: Accessor<PaneId>) => void;
}

const DEFAULT_PANE_STATUS: PaneStatus = {
  mode: "NORMAL",
  pending: "",
  position: "",
};

const StatusContext = createContext<InternalStatusContext>();

export function StatusProvider(
  props: ParentProps<{ expose?: (api: StatusApi) => void }>,
): JSX.Element {
  const [registered, setRegistered] = createSignal<Partial<Record<PaneId, Accessor<PaneStatus>>>>({});
  const [focusedPane, setFocusedPaneSignal] = createSignal<Accessor<PaneId>>(() => "editor");
  const [message, setMessage] = createSignal<{ text: string; kind: "info" | "error" } | null>(null);

  const api: StatusApi = {
    register(pane: PaneId, status: Accessor<PaneStatus>): void {
      setRegistered((prev) => ({ ...prev, [pane]: status }));
    },
    current(): PaneStatus {
      const pane = focusedPane()();
      const accessor = registered()[pane];
      const raw = accessor ? accessor() : DEFAULT_PANE_STATUS;
      return {
        mode: printable(raw.mode),
        pending: printable(raw.pending),
        position: printable(raw.position),
      };
    },
    message() {
      const msg = message();
      return msg ? { text: printable(msg.text), kind: msg.kind } : null;
    },
    say(text: string, kind: "info" | "error" = "info"): void {
      setMessage({ text, kind });
    },
    clear(): void {
      setMessage(null);
    },
  };


  props.expose?.(api);

  return (
    <StatusContext.Provider
      value={{
        api,
        setFocusedPane: (pane) => setFocusedPaneSignal(() => pane),
      }}
    >
      {props.children}
    </StatusContext.Provider>
  );
}

export function useStatus(): StatusApi {
  const ctx = useContext(StatusContext);
  if (!ctx) throw new Error("useStatus must be used within a StatusProvider");
  return ctx.api;
}

export function useBindStatusFocus(): (pane: Accessor<PaneId>) => void {
  const ctx = useContext(StatusContext);
  if (!ctx) throw new Error("useBindStatusFocus must be used within a StatusProvider");
  return ctx.setFocusedPane;
}
