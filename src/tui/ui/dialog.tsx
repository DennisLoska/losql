import { RGBA } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { createMemo, createSignal, type JSX, onCleanup, type ParentProps, untrack } from "solid-js";
import { useConfig } from "../context/config";
import { useDeps } from "../context/deps";
import { useTheme } from "../context/theme";
import { easeOutCubic, tweenValue } from "../motion/tween";

export function DialogHost(
  props: ParentProps<{
    width?: number;
    zIndex?: number;
  }>,
): JSX.Element {
  const deps = useDeps();
  const config = useConfig();
  const theme = useTheme();
  const dimensions = useTerminalDimensions();

  const initialProgress = untrack(() => (config.animations() ? 0 : 1));
  const [progress, setProgress] = createSignal(initialProgress);

  if (initialProgress < 1) {
    const start = deps.clock.now();
    const duration = 120;
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

  const backdropColor = createMemo(() => {
    if (theme.theme().transparent) return undefined;
    const alpha = Math.round(120 * progress());
    return RGBA.fromInts(0, 0, 0, alpha);
  });

  const panelWidth = createMemo(() => {
    const requested = props.width ?? 60;
    return Math.max(10, Math.min(requested, dimensions().width - 4));
  });

  const riseOffset = createMemo(() => Math.round(1 - progress()));

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={dimensions().width}
      height={dimensions().height}
      zIndex={props.zIndex ?? 100}
      alignItems="center"
      justifyContent="center"
      backgroundColor={backdropColor()}
    >
      <box
        width={panelWidth()}
        flexDirection="column"
        backgroundColor={theme.color("overlayBackground")}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        marginTop={riseOffset()}
      >
        {props.children}
      </box>
    </box>
  );
}
