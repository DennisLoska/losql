import { useTerminalDimensions } from "@opentui/solid";
import {
  createComputed,
  createContext,
  createMemo,
  createSignal,
  type JSX,
  type ParentProps,
  untrack,
  useContext,
} from "solid-js";
import { useBindStatusFocus } from "./status";

export type PaneId = "schema" | "editor" | "results" | "agent";

export interface FocusApi {
  pane(): PaneId;
  focus(pane: PaneId): void;
  visible(pane: PaneId): boolean;
  setVisible(pane: PaneId, visible: boolean): void;
  toggle(pane: PaneId): void;
  move(direction: "h" | "j" | "k" | "l" | "w"): void;
  layout(): { schema: "side" | "overlay"; agent: "side" | "overlay" };
  /** The Results Pane is shown full screen (not saved). */
  zoomed(): boolean;
  /** Zooms the Results Pane, or restores the layout and focus from before. */
  toggleZoom(): void;
  /** Restores the layout and focus from before zooming; does nothing when not zoomed. */
  leaveZoom(): void;
}

const FocusContext = createContext<FocusApi>();

const PANE_ORDER: readonly PaneId[] = ["schema", "editor", "results", "agent"];

export function FocusProvider(props: ParentProps<{ expose?: (api: FocusApi) => void }>): JSX.Element {
  const dimensions = useTerminalDimensions();
  const bindStatusFocus = useBindStatusFocus();

  const [pane, setPane] = createSignal<PaneId>("editor");
  const [schemaVisible, setSchemaVisible] = createSignal<boolean>(untrack(() => dimensions().width >= 70));
  const [agentVisible, setAgentVisible] = createSignal<boolean>(false);
  let lastCentre: "editor" | "results" = "editor";
  const [zoomed, setZoomed] = createSignal<boolean>(false);
  // The Pane focused before zooming. Zoom changes no sidebar and no lastCentre: it only hides
  // the other Panes, so leaving it restores the layout by showing them again.
  let beforeZoom: PaneId = "editor";

  const leaveZoom = (): void => {
    if (!zoomed()) return;
    setZoomed(false);
    setPane(beforeZoom);
  };

  const toggleZoom = (): void => {
    if (zoomed()) {
      leaveZoom();
      return;
    }
    beforeZoom = pane();
    setZoomed(true);
    setPane("results");
  };

  bindStatusFocus(pane);

  const layout = createMemo(() => {
    const width = dimensions().width;
    return {
      schema: width < 70 ? ("overlay" as const) : ("side" as const),
      agent: width < 100 ? ("overlay" as const) : ("side" as const),
    };
  });

  createComputed(() => {
    const currentLayout = layout();
    // While zoomed, the Pane focused before zooming is the one the layout keeps.
    const currentPane = untrack(zoomed) ? beforeZoom : untrack(pane);
    if (currentLayout.schema === "overlay" && currentPane !== "schema" && untrack(schemaVisible)) {
      setSchemaVisible(false);
    }
    if (currentLayout.agent === "overlay" && currentPane !== "agent" && untrack(agentVisible)) {
      setAgentVisible(false);
    }
  });

  const visible = (target: PaneId): boolean => {
    if (target === "editor" || target === "results") return true;
    if (target === "schema") return schemaVisible();
    return agentVisible();
  };

  const focus = (target: PaneId): void => {
    if (target !== "results") leaveZoom();
    if (target === "schema" && !schemaVisible()) {
      setSchemaVisible(true);
    } else if (target === "agent" && !agentVisible()) {
      setAgentVisible(true);
    }

    if (target === "editor" || target === "results") {
      lastCentre = target;
    }

    const previous = pane();
    if (previous !== target) {
      setPane(target);
      const currentLayout = layout();
      if (previous === "schema" && currentLayout.schema === "overlay") {
        setSchemaVisible(false);
      }
      if (previous === "agent" && currentLayout.agent === "overlay") {
        setAgentVisible(false);
      }
    }
  };

  const setVisible = (target: PaneId, nextVisible: boolean): void => {
    if (target === "editor" || target === "results") return;
    leaveZoom();
    if (target === "schema") {
      setSchemaVisible(nextVisible);
      if (!nextVisible && pane() === "schema") {
        focus("editor");
      }
    } else if (target === "agent") {
      setAgentVisible(nextVisible);
      if (!nextVisible && pane() === "agent") {
        focus("editor");
      }
    }
  };

  const toggle = (target: PaneId): void => {
    if (target !== "results") leaveZoom();
    if (target === "editor" || target === "results") {
      focus(target);
      return;
    }
    if (!visible(target)) {
      focus(target);
    } else if (pane() !== target) {
      focus(target);
    } else {
      setVisible(target, false);
      focus("editor");
    }
  };

  const move = (direction: "h" | "j" | "k" | "l" | "w"): void => {
    if (zoomed()) return; // the other Panes are not drawn
    const current = pane();
    if (direction === "h") {
      if (current === "agent") {
        focus(lastCentre);
      } else if ((current === "editor" || current === "results") && visible("schema")) {
        focus("schema");
      }
    } else if (direction === "l") {
      if (current === "schema") {
        focus(lastCentre);
      } else if ((current === "editor" || current === "results") && visible("agent")) {
        focus("agent");
      }
    } else if (direction === "j") {
      if (current === "editor") {
        focus("results");
      }
    } else if (direction === "k") {
      if (current === "results") {
        focus("editor");
      }
    } else if (direction === "w") {
      const visiblePanes = PANE_ORDER.filter((p) => visible(p));
      const idx = visiblePanes.indexOf(current);
      const next = visiblePanes[(idx + 1) % visiblePanes.length]!;
      focus(next);
    }
  };

  const api: FocusApi = {
    pane,
    focus,
    visible,
    setVisible,
    toggle,
    move,
    layout,
    zoomed,
    toggleZoom,
    leaveZoom,
  };

  props.expose?.(api);

  return <FocusContext.Provider value={api}>{props.children}</FocusContext.Provider>;
}

export function useFocus(): FocusApi {
  const ctx = useContext(FocusContext);
  if (!ctx) throw new Error("useFocus must be used within a FocusProvider");
  return ctx;
}
