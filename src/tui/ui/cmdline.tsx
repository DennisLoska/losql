import { useTerminalDimensions } from "@opentui/solid";
import { type JSX, Show } from "solid-js";
import { useCmdline } from "../context/commands";
import { useTheme } from "../context/theme";
import { InputLine } from "./input-line";

export function Cmdline(): JSX.Element {
  const theme = useTheme();
  const cmdline = useCmdline();
  const dimensions = useTerminalDimensions();

  return (
    <Show when={cmdline.active()}>
      <box
        position="absolute"
        left={0}
        top={Math.max(0, dimensions().height - 1)}
        height={1}
        width={dimensions().width}
        zIndex={90}
        flexShrink={0}
        flexDirection="row"
        backgroundColor={theme.color("background")}
      >
        <InputLine input={cmdline.input} prefix={cmdline.prefix()} />
      </box>
    </Show>
  );
}
