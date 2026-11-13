import { createEffect, createMemo, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { mix } from "../../core/theme/color";
import { useConfig } from "../context/config";
import { useDeps } from "../context/deps";
import { useTheme } from "../context/theme";
import { toRGBA } from "../theme-bridge";

export const LOGO: readonly string[] = [
  "██      ██████  ███████  ██████  ██     ",
  "██     ██    ██ ██      ██    ██ ██     ",
  "██     ██    ██ ███████ ██    ██ ██     ",
  "██     ██    ██      ██ ██ ▄▄ ██ ██     ",
  "███████ ██████  ███████  ██████  ███████",
];

const LOGO_PERIOD_MS = 2400;
const LOGO_BAND_HALF_WIDTH = 6;

export function Logo(): JSX.Element {
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

  const maxCols = createMemo(() => Math.max(1, ...LOGO.map((l) => Array.from(l).length)));

  const colColors = createMemo(() => {
    const t = theme.theme();
    const width = maxCols();
    const phase =
      (((elapsed() % LOGO_PERIOD_MS) + LOGO_PERIOD_MS) % LOGO_PERIOD_MS) / LOGO_PERIOD_MS;
    const center = phase * width;
    return Array.from({ length: width }, (_, col) => {
      const distance = Math.abs(col - center);
      if (distance >= LOGO_BAND_HALF_WIDTH) {
        return toRGBA(t.primary);
      }
      const weight = 1 - distance / LOGO_BAND_HALF_WIDTH;
      return toRGBA(mix(t.primary, t.secondary, weight));
    });
  });

  return (
    <box flexDirection="column">
      <For each={LOGO}>
        {(line) => (
          <Show
            when={config.animations()}
            fallback={<text fg={theme.color("primary")}>{line}</text>}
          >
            <text>
              <For each={Array.from(line)}>
                {(ch, colIdx) => (
                  <span style={{ fg: colColors()[colIdx()] ?? theme.color("primary") }}>
                    {ch}
                  </span>
                )}
              </For>
            </text>
          </Show>
        )}
      </For>
    </box>
  );
}
