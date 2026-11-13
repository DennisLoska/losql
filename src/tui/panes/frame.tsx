import { type BorderCharacters, type BorderSides, TextAttributes } from "@opentui/core";
import { createMemo, type JSX, type ParentProps, Show } from "solid-js";
import { mix } from "../../core/theme/color";
import { useConfig } from "../context/config";
import { useDeps } from "../context/deps";
import { type PaneId, useFocus } from "../context/focus";
import { useTheme } from "../context/theme";
import { createTween } from "../motion/tween";
import { toRGBA } from "../theme-bridge";

const SPLIT_BORDER_CHARS: BorderCharacters = {
  topLeft: "",
  bottomLeft: "",
  vertical: "┃",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
};

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
    const t = theme.theme();
    return toRGBA(mix(t.border, t.borderActive, activeT()));
  });

  const isOverlay = createMemo(() => {
    const layout = focus.layout();
    if (props.pane === "schema") return layout.schema === "overlay";
    if (props.pane === "agent") return layout.agent === "overlay";
    return false;
  });

  const backgroundColor = createMemo(() =>
    isOverlay() ? theme.color("overlayBackground") : theme.color("paneBackground"),
  );

  const borderSide = createMemo<BorderSides[]>(() => {
    if (props.pane === "schema") return ["right"];
    if (props.pane === "agent") return ["left"];
    return [];
  });

  return (
    <box
      id={`pane-${props.pane}`}
      width="100%"
      height="100%"
      flexDirection="column"
      backgroundColor={backgroundColor()}
      border={borderSide()}
      customBorderChars={borderSide().length > 0 ? SPLIT_BORDER_CHARS : undefined}
      borderColor={borderSide().length > 0 ? borderColor() : undefined}
      paddingLeft={1}
      paddingRight={1}
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
      <box flexGrow={1} width="100%" flexDirection="column">
        {props.children}
      </box>
    </box>
  );
}
