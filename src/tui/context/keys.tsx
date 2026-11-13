import { useKeyboard, usePaste } from "@opentui/solid";
import { createContext, createSignal, type JSX, onCleanup, type ParentProps, useContext } from "solid-js";
import { type Key, keyFromEvent } from "../../core/vim/keys";
import { useConfig } from "./config";
import { useDeps } from "./deps";
import { type PaneId, useFocus } from "./focus";
import { useStatus } from "./status";

export type KeyHandler = (key: Key) => boolean;

/** shift+h/j/k/l, typed as the letters H, J, K and L (no ctrl, no meta). */
function isPaneMoveKey(key: Key): boolean {
  return !key.ctrl && !key.meta && (key.text === "H" || key.text === "J" || key.text === "K" || key.text === "L");
}

export interface KeysApi {
  dispatch(key: Key): void;
  paste(text: string): void;
  pushLayer(
    handler: KeyHandler,
    options?: { modal?: boolean; onPaste?: (text: string) => void },
  ): () => void;
  setPaneHandler(pane: PaneId, handler: KeyHandler | null): void;
  setPasteHandler(pane: PaneId, handler: ((text: string) => void) | null): void;
  addGlobal(handler: KeyHandler): () => void;
  onInterrupt(handler: () => boolean): () => void;
  chord(): string;
}

interface LayerEntry {
  handler: KeyHandler;
  modal: boolean;
  onPaste?: (text: string) => void;
}

const KeysContext = createContext<KeysApi>();

export function KeysProvider(
  props: ParentProps<{ onQuit: () => Promise<void>; expose?: (api: KeysApi) => void }>,
): JSX.Element {
  const deps = useDeps();
  const config = useConfig();
  const status = useStatus();
  const focus = useFocus();

  const [chord, setChord] = createSignal("");
  const layers: LayerEntry[] = [];
  const paneHandlers = new Map<PaneId, KeyHandler>();
  const pasteHandlers = new Map<PaneId, (text: string) => void>();
  const globals: KeyHandler[] = [];
  const interruptHandlers: Array<() => boolean> = [];
  let lastCtrlC: number | null = null;

  function safeCall(fn: () => boolean): boolean {
    try {
      return fn();
    } catch (err) {
      status.say(err instanceof Error ? err.message : String(err), "error");
      return false;
    }
  }

  function safeRun(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      status.say(err instanceof Error ? err.message : String(err), "error");
    }
  }

  function interruptOrQuit(): void {
    const interruptSnapshot = [...interruptHandlers];
    for (let i = interruptSnapshot.length - 1; i >= 0; i--) {
      const handler = interruptSnapshot[i]!;
      if (!interruptHandlers.includes(handler)) continue;
      if (safeCall(handler)) {
        lastCtrlC = null;
        return;
      }
    }
    const now = deps.clock.now();
    if (lastCtrlC !== null && now - lastCtrlC <= 1000) {
      lastCtrlC = null;
      void props.onQuit();
    } else {
      lastCtrlC = now;
      status.say("Press ctrl+c again to quit");
    }
  }

  function isLeaderKey(key: Key): boolean {
    const leader = config.config().leader;
    return leader === "space"
      ? !key.ctrl && !key.meta && key.name === "space"
      : !key.ctrl && !key.meta && key.text === leader;
  }

  function dispatch(key: Key): void {
    status.clear(); // a message lasts until the next key

    const layerSnapshot = [...layers];
    for (let i = layerSnapshot.length - 1; i >= 0; i--) {
      const layer = layerSnapshot[i]!;
      if (!layers.includes(layer)) continue;
      if (safeCall(() => layer.handler(key))) return;
      if (layer.modal) return;
    }

    if (chord() !== "") {
      setChord("");
      if (!key.meta && ["h", "j", "k", "l", "w"].includes(key.name)) {
        focus.move(key.name as "h" | "j" | "k" | "l" | "w");
      }
      return;
    }

    // shift+h/j/k/l move the focus like ctrl+h/j/k/l, but only while the focused Pane takes neither
    // text nor a command in progress: its status shows normal mode and nothing pending. Otherwise
    // (insert or visual mode, a count, an operator, a prefix waiting for its next key) the Pane gets
    // the key as before.
    if (isPaneMoveKey(key) && !isLeaderKey(key)) {
      const paneStatus = status.current();
      if (paneStatus.mode === "NORMAL" && paneStatus.pending === "") {
        focus.move(key.text!.toLowerCase() as "h" | "j" | "k" | "l");
        return;
      }
    }

    const paneHandler = paneHandlers.get(focus.pane());
    if (paneHandler && safeCall(() => paneHandler(key))) return;

    if (key.ctrl && key.name === "w") {
      setChord("^W");
      return;
    }
    if (key.ctrl && ["h", "j", "k", "l"].includes(key.name)) {
      focus.move(key.name as "h" | "j" | "k" | "l");
      return;
    }
    if (key.ctrl && key.name === "c") {
      interruptOrQuit();
      return;
    }

    const globalSnapshot = [...globals];
    for (let i = globalSnapshot.length - 1; i >= 0; i--) {
      const handler = globalSnapshot[i]!;
      if (!globals.includes(handler)) continue;
      if (safeCall(() => handler(key))) return;
    }
  }

  function paste(text: string): void {
    const layerSnapshot = [...layers];
    for (let i = layerSnapshot.length - 1; i >= 0; i--) {
      const layer = layerSnapshot[i]!;
      if (!layers.includes(layer)) continue;
      if (layer.onPaste) {
        safeRun(() => layer.onPaste!(text));
        return;
      }
      if (layer.modal) return;
    }
    const panePaste = pasteHandlers.get(focus.pane());
    if (panePaste) {
      safeRun(() => panePaste(text));
    }
  }

  useKeyboard((event) => {
    event.preventDefault();
    dispatch(keyFromEvent(event));
  });

  const decoder = new TextDecoder();
  usePaste((event) => {
    // The paste is ours alone: without this the terminal library also hands it to the focused
    // renderable (the Editor's textarea), which would insert it a second time behind the engine.
    event.preventDefault();
    event.stopPropagation();
    paste(decoder.decode(event.bytes));
  });

  const api: KeysApi = {
    dispatch,
    paste,
    pushLayer(handler, options) {
      const entry: LayerEntry = {
        handler,
        modal: options?.modal ?? false,
        onPaste: options?.onPaste,
      };
      layers.push(entry);
      return () => {
        const idx = layers.indexOf(entry);
        if (idx >= 0) layers.splice(idx, 1);
      };
    },
    setPaneHandler(pane, handler) {
      if (handler === null) {
        paneHandlers.delete(pane);
      } else {
        paneHandlers.set(pane, handler);
      }
    },
    setPasteHandler(pane, handler) {
      if (handler === null) {
        pasteHandlers.delete(pane);
      } else {
        pasteHandlers.set(pane, handler);
      }
    },
    addGlobal(handler) {
      globals.push(handler);
      return () => {
        const idx = globals.indexOf(handler);
        if (idx >= 0) globals.splice(idx, 1);
      };
    },
    onInterrupt(handler) {
      interruptHandlers.push(handler);
      return () => {
        const idx = interruptHandlers.indexOf(handler);
        if (idx >= 0) interruptHandlers.splice(idx, 1);
      };
    },
    chord,
  };

  props.expose?.(api);

  return <KeysContext.Provider value={api}>{props.children}</KeysContext.Provider>;
}

export function useKeys(): KeysApi {
  const ctx = useContext(KeysContext);
  if (!ctx) throw new Error("useKeys must be used within a KeysProvider");
  return ctx;
}

export function useLayer(handler: KeyHandler, options?: { onPaste?: (text: string) => void }): void {
  const keys = useKeys();
  const remove = keys.pushLayer(handler, { modal: false, onPaste: options?.onPaste });
  onCleanup(remove);
}

