import { createEffect, createMemo, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { useConfig } from "../context/config";
import { useDeps } from "../context/deps";
import { useTheme } from "../context/theme";
import { shimmer } from "../motion/shimmer";
import { toRGBA } from "../theme-bridge";

export function Shimmer(props: { text: string }): JSX.Element {
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

  const chars = createMemo(() => Array.from(props.text));
  const colors = createMemo(() => {
    const t = theme.theme();
    return shimmer(chars().length, elapsed(), t.textMuted, t.text).map(toRGBA);
  });

  return (
    <Show
      when={config.animations()}
      fallback={<text fg={theme.color("textMuted")}>{props.text}</text>}
    >
      <text>
        <For each={chars()}>
          {(ch, idx) => (
            <span style={{ fg: colors()[idx()] ?? theme.color("textMuted") }}>{ch}</span>
          )}
        </For>
      </text>
    </Show>
  );
}
