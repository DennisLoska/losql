import { type BorderSides, TextAttributes } from "@opentui/core";
import { createMemo, type JSX, type ParentProps, Show } from "solid-js";
import { mix } from "../../core/theme/color";
import type { Rgba, Theme } from "../../core/theme/tokens";
import { useConfig } from "../context/config";
import { useDeps } from "../context/deps";
import { type PaneId, useFocus } from "../context/focus";
import { useTheme } from "../context/theme";
import { createTween } from "../motion/tween";
import { toRGBA } from "../theme-bridge";

const ALL_BORDER_SIDES: BorderSides[] = ["top", "right", "bottom", "left"];
const NO_BORDER_SIDES: BorderSides[] = [];

const SUBTLE_ORANGE_DARK: Rgba = { r: 235, g: 140, b: 78, a: 255 };
const SUBTLE_ORANGE_LIGHT: Rgba = { r: 210, g: 112, b: 44, a: 255 };

export function paneBorderColors(t: Theme): { inactive: Rgba; active: Rgba } {
  const inactive: Rgba = { ...mix(t.overlayBackground, t.borderSubtle, 0.5), a: 255 };
  const orange = t.mode === "dark" ? SUBTLE_ORANGE_DARK : SUBTLE_ORANGE_LIGHT;
  const weight = t.mode === "dark" ? 0.56 : 0.68;
  const active: Rgba = { ...mix(t.overlayBackground, orange, weight), a: 255 };
  return { inactive, active };
}

export function PaneFrame(props: ParentProps<{ pane: PaneId; title?: JSX.Element }>): JSX.Element {
  const deps = useDeps();
  const config = useConfig();
  const focus = useFocus();
  const theme = useTheme();

  const activeT = createTween(() => (focus.pane() === props.pane ? 1 : 0), {
    duration: 120,
    clock: deps.clock,
    enabled: () => config.animations(),
  });

  const borderColor = createMemo(() => {
    const { inactive, active } = paneBorderColors(theme.theme());
    return toRGBA(mix(inactive, active, activeT()));
  });

  const isOverlay = createMemo(() => {
    const layout = focus.layout();
    if (props.pane === "schema") return layout.schema === "overlay";
    if (props.pane === "agent") return layout.agent === "overlay";
    return false;
  });

  const hasBorder = createMemo(() => {
    if (props.pane === "results" && focus.zoomed()) return false;
    if (focus.size().height < 16) return false;
    return true;
  });

  const borderSides = createMemo<BorderSides[]>(() =>
    hasBorder() ? ALL_BORDER_SIDES : NO_BORDER_SIDES,
  );

  const backgroundColor = createMemo(() =>
    isOverlay() ? theme.color("overlayBackground") : theme.color("paneBackground"),
  );

  const padLeft = createMemo(() => {
    if (!hasBorder()) return 1;
    return props.pane === "editor" ? 0 : 1;
  });

  const padRight = createMemo(() => {
    if (!hasBorder()) return 1;
    return props.pane === "editor" || props.pane === "schema" ? 0 : 1;
  });

  return (
    <box
      id={`pane-${props.pane}`}
      width="100%"
      height="100%"
      flexDirection="column"
      backgroundColor={backgroundColor()}
      border={borderSides()}
      borderStyle="rounded"
      borderColor={borderColor()}
      paddingLeft={padLeft()}
      paddingRight={padRight()}
    >
      <Show when={props.title !== undefined}>
        <box height={1} width="100%" flexShrink={0} flexDirection="row">
          {typeof props.title === "string" ? (
            <text fg={theme.color("textMuted")} attributes={TextAttributes.BOLD}>
              {props.title}
            </text>
          ) : (
            props.title
          )}
        </box>
      </Show>
      <box flexGrow={1} width="100%" flexDirection="column" overflow="hidden">
        {props.children}
      </box>
    </box>
  );
}
