import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { createMemo, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import type { LeaderNode } from "../../core/commands/registry";
import type { AppApi } from "../app";
import { useConfig } from "../context/config";
import { useDeps } from "../context/deps";
import { useKeys } from "../context/keys";
import { useTheme } from "../context/theme";
import { createTween } from "../motion/tween";
import { cellWidth, cutCells } from "./cells";
import { printable } from "./printable";

interface KeyMenuController {
  active: () => boolean;
  currentNodes: () => LeaderNode<AppApi>[];
  progress: () => number;
  open: (tree: LeaderNode<AppApi>[]) => void;
  close: () => void;
}

function truncateCells(text: string, maxCells: number): string {
  if (maxCells <= 0) return "";
  return cutCells(text, maxCells, { ellipsis: true });
}

function createKeyMenuController(getApi: () => AppApi): KeyMenuController {
  const deps = useDeps();
  const config = useConfig();
  const keys = useKeys();

  const [stack, setStack] = createSignal<LeaderNode<AppApi>[][]>([]);
  const [targetProgress, setTargetProgress] = createSignal(0);

  const progress = createTween(targetProgress, {
    duration: 100,
    clock: deps.clock,
    enabled: () => config.animations() && stack().length > 0,
  });

  let removeLayer: (() => void) | null = null;

  const close = () => {
    if (removeLayer) {
      removeLayer();
      removeLayer = null;
    }
    setStack([]);
    setTargetProgress(0);
  };

  const currentNodes = createMemo(() => {
    const s = stack();
    return s[s.length - 1] ?? [];
  });

  const open = (tree: LeaderNode<AppApi>[]) => {
    close();
    if (tree.length === 0) return;

    setStack([tree]);
    setTargetProgress(1);

    removeLayer = keys.pushLayer(
      (key) => {
        if (!key.ctrl && !key.meta && key.name === "backspace") {
          const s = stack();
          if (s.length > 1) {
            setStack(s.slice(0, -1));
          } else {
            close();
          }
          return true;
        }

        if (
          (!key.ctrl && !key.meta && key.name === "escape") ||
          (key.ctrl && !key.meta && key.name === "c")
        ) {
          close();
          return true;
        }

        if (!key.ctrl && !key.meta && key.text !== undefined) {
          const match = currentNodes().find((n) => n.key === key.text);
          if (match) {
            if (match.kind === "command") {
              close();
              void getApi().commands.run(match.command.id, "");
            } else {
              setStack((prev) => [...prev, match.children]);
            }
            return true;
          }
        }

        close();
        return true;
      },
      { modal: true },
    );
  };

  onCleanup(close);

  return {
    active: () => stack().length > 0,
    currentNodes,
    progress,
    open,
    close,
  };
}

export function KeyMenu(props: {
  getApi: () => AppApi;
  exposeOpen: (open: (tree: LeaderNode<AppApi>[]) => void) => void;
}): JSX.Element {
  const theme = useTheme();
  const dimensions = useTerminalDimensions();
  const controller = createKeyMenuController(props.getApi);
  props.exposeOpen(controller.open);

  const layout = createMemo(() => {
    const nodes = controller.currentNodes();
    if (nodes.length === 0) {
      return {
        columns: [] as Array<Array<LeaderNode<AppApi> | { kind: "more"; count: number }>>,
        colWidth: 28,
        panelHeight: 0,
      };
    }

    const termWidth = dimensions().width;
    const termHeight = dimensions().height;
    const maxPanelHeight = Math.max(3, termHeight - 2);
    const colCount = Math.max(1, Math.min(4, Math.floor((termWidth - 4) / 28)));
    const availableWidth = Math.max(colCount, termWidth - 4 - (colCount - 1) * 4);
    const colWidth = Math.max(6, Math.min(28, Math.floor(availableWidth / colCount)));

    const unclippedRowsPerCol = Math.max(1, Math.ceil(nodes.length / colCount));
    const maxEntryRows = Math.max(1, Math.min(10, maxPanelHeight - 2));
    const rowsPerCol = Math.min(unclippedRowsPerCol, maxEntryRows);

    const capacity = rowsPerCol * colCount;
    const overflows = nodes.length > capacity;

    type CellItem = LeaderNode<AppApi> | { kind: "more"; count: number };
    const items: CellItem[] = overflows
      ? [
          ...nodes.slice(0, Math.max(0, capacity - 1)),
          { kind: "more", count: nodes.length - Math.max(0, capacity - 1) },
        ]
      : [...nodes];

    const cols: CellItem[][] = [];
    for (let i = 0; i < items.length; i += rowsPerCol) {
      cols.push(items.slice(i, i + rowsPerCol));
    }

    let maxColRows = 0;
    for (const col of cols) {
      if (col.length > maxColRows) maxColRows = col.length;
    }

    const panelHeight = Math.min(maxPanelHeight, maxColRows + 2);

    return {
      columns: cols,
      colWidth,
      panelHeight,
    };
  });

  const topPos = createMemo(() => {
    const h = layout().panelHeight;
    const slideOffset = Math.round(1 - controller.progress());
    return Math.max(0, dimensions().height - 1 - h + slideOffset);
  });

  return (
    <Show when={controller.active()}>
      <box
        position="absolute"
        left={0}
        top={topPos()}
        width={dimensions().width}
        height={layout().panelHeight}
        zIndex={80}
        backgroundColor={theme.color("overlayBackground")}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        flexDirection="row"
        gap={4}
      >
        <For each={layout().columns}>
          {(col) => (
            <box flexDirection="column" width={layout().colWidth} flexShrink={0}>
              <For each={col}>
                {(node) => {
                  if (node.kind === "more") {
                    return (
                      <box flexDirection="row" height={1} width={layout().colWidth}>
                        <text
                          fg={theme.color("textMuted")}
                          bg={theme.color("overlayBackground")}
                          flexShrink={0}
                        >
                          {`… ${node.count} more`}
                        </text>
                      </box>
                    );
                  }
                  const keyPart = () => `${printable(node.key)}  `;
                  const titleBudget = () =>
                    Math.max(1, layout().colWidth - cellWidth(keyPart()));
                  const label = () => {
                    const raw =
                      node.kind === "group"
                        ? `+${printable(node.label)}`
                        : printable(node.command.title);
                    return truncateCells(raw, titleBudget());
                  };
                  const labelColor = () =>
                    node.kind === "group" ? theme.color("accent") : theme.color("text");
                  return (
                    <box flexDirection="row" height={1} width={layout().colWidth}>
                      <text
                        fg={theme.color("primary")}
                        bg={theme.color("overlayBackground")}
                        attributes={TextAttributes.BOLD}
                        flexShrink={0}
                      >
                        {keyPart()}
                      </text>
                      <text
                        fg={labelColor()}
                        bg={theme.color("overlayBackground")}
                        flexShrink={0}
                      >
                        {label()}
                      </text>
                    </box>
                  );
                }}
              </For>
            </box>
          )}
        </For>
      </box>
    </Show>
  );
}
