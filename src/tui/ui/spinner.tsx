import { createEffect, createSignal, type JSX, onCleanup, Show } from "solid-js";
import { useConfig } from "../context/config";
import { useDeps } from "../context/deps";
import { useTheme } from "../context/theme";
import { SPINNER_STATIC, spinnerFrame } from "../motion/shimmer";

export function Spinner(props: { label?: string }): JSX.Element {
  const deps = useDeps();
  const config = useConfig();
  const theme = useTheme();
  const [elapsed, setElapsed] = createSignal(0);

  createEffect(() => {
    if (!config.animations()) {
      setElapsed(0);
      return;
    }
    const start = deps.clock.now();
    setElapsed(0);
    const unsubscribe = deps.clock.onFrame((now) => {
      setElapsed(now - start);
    });
    onCleanup(unsubscribe);
  });

  const glyph = () => (config.animations() ? spinnerFrame(elapsed()) : SPINNER_STATIC);

  return (
    <text>
      <span style={{ fg: theme.color("primary") }}>{glyph()}</span>
      <Show when={props.label !== undefined && props.label !== ""}>
        <span style={{ fg: theme.color("text") }}>{` ${props.label}`}</span>
      </Show>
    </text>
  );
}
