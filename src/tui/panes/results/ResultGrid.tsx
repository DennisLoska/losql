import { createEffect, createMemo, createSignal, type JSX, onCleanup, Show } from "solid-js";
import type { Result } from "../../../core/db/types";
import { useConfig } from "../../context/config";
import { useDeps } from "../../context/deps";
import { tweenValue } from "../../motion/tween";
import { DataGrid, type FlashSpec } from "./DataGrid";
import { type GridColumn, isNumericColumn, type Viewport } from "./grid-model";

export type { FlashSpec } from "./DataGrid";

/** A Result drawn in a `DataGrid`: numeric columns right-aligned, rows fading in when a new Result arrives. */
export function ResultGrid(props: {
  result: Result;
  cursor: { row: number; column: number };
  selectedRows: { start: number; end: number } | null;
  flash: FlashSpec | null;
  onViewport?: (vp: Viewport, boxHeight: number) => void;
}): JSX.Element {
  const deps = useDeps();
  const config = useConfig();
  const [fadeT, setFadeT] = createSignal(1);
  let lastResult: Result | null = null;

  createEffect(() => {
    const res = props.result;
    if (res === lastResult) return;
    lastResult = res;
    if (!config.animations()) {
      setFadeT(1);
      return;
    }
    const start = deps.clock.now();
    setFadeT(0);
    const off = deps.clock.onFrame((now) => {
      const elapsed = now - start;
      setFadeT(tweenValue(0, 1, elapsed, 200));
      if (elapsed >= 200) off();
    });
    onCleanup(off);
  });

  const columns = createMemo<GridColumn[]>(() =>
    props.result.columns.map((col, i) => ({
      name: col.name,
      align: isNumericColumn(props.result, i) ? "right" : "left",
    })),
  );

  // Keyed on the Result's identity: a new Result mounts a fresh grid scrolled to its origin.
  return (
    <Show when={props.result} keyed>
      {(result: Result) => (
        <DataGrid
          columns={columns()}
          rows={result.rows}
          cursor={props.cursor}
          selectedRows={props.selectedRows}
          flash={props.flash}
          fadeT={fadeT()}
          onViewport={props.onViewport}
        />
      )}
    </Show>
  );
}
