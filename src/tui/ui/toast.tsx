import { type BorderCharacters, TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { createMemo, createSignal, For, type JSX, onCleanup, Show, untrack } from "solid-js";
import { useConfig } from "../context/config";
import { useDeps } from "../context/deps";
import { type Toast, useToast } from "../context/toast";
import { useTheme } from "../context/theme";
import { easeOutCubic, tweenValue } from "../motion/tween";
import { printable } from "./printable";

const TOAST_BORDER_CHARS: BorderCharacters = {
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

function ToastItem(props: { toast: Toast; maxWidth: number }): JSX.Element {
  const deps = useDeps();
  const config = useConfig();
  const theme = useTheme();

  const initialProgress = untrack(() => (config.animations() ? 0 : 1));
  const [progress, setProgress] = createSignal(initialProgress);

  if (initialProgress < 1) {
    const start = deps.clock.now();
    const duration = 150;
    const unsubscribe = deps.clock.onFrame((now) => {
      const elapsed = now - start;
      if (elapsed >= duration) {
        setProgress(1);
        unsubscribe();
      } else {
        setProgress(tweenValue(0, 1, elapsed, duration, easeOutCubic));
      }
    });
    onCleanup(unsubscribe);
  }

  const slideOffset = createMemo(() => Math.round((1 - progress()) * 6));

  return (
    <box
      width={props.maxWidth}
      flexDirection="column"
      backgroundColor={theme.color("overlayBackground")}
      border={["left"]}
      customBorderChars={TOAST_BORDER_CHARS}
      borderColor={theme.color(props.toast.kind)}
      paddingLeft={1}
      paddingRight={1}
      marginLeft={slideOffset()}
    >
      <Show when={props.toast.title}>
        <text
          fg={theme.color("text")}
          bg={theme.color("overlayBackground")}
          attributes={TextAttributes.BOLD}
        >
          {printable(props.toast.title!, { keepNewlines: true })}
        </text>
      </Show>
      <text
        fg={theme.color("text")}
        bg={theme.color("overlayBackground")}
        wrapMode="word"
      >
        {printable(props.toast.message, { keepNewlines: true })}
      </text>
    </box>
  );
}


export function Toasts(): JSX.Element {
  const toast = useToast();
  const dimensions = useTerminalDimensions();
  const boxWidth = createMemo(() => Math.max(10, Math.min(44, dimensions().width - 4)));

  return (
    <Show when={toast.items().length > 0}>
      <box
        position="absolute"
        top={1}
        right={2}
        zIndex={500}
        flexDirection="column"
        gap={1}
      >
        <For each={toast.items()}>
          {(item) => <ToastItem toast={item} maxWidth={boxWidth()} />}
        </For>
      </box>
    </Show>
  );
}
