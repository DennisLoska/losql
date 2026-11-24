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
  grid: () => MenuGrid;
  page: () => number;
  progress: () => number;
  open: (tree: LeaderNode<AppApi>[]) => void;
  close: () => void;
}

/** How the entries fit the terminal: columns of `rows` entries, `pages` pages when they overflow. */
interface MenuGrid {
  colCount: number;
  colWidth: number;
  rows: number;
  pageSize: number;
  pages: number;
}

const COL_WIDTH = 28;
const MAX_ENTRY_ROWS = 10;

/**
 * The grid for `count` entries in a terminal: up to four columns, up to ten rows. When they do not fit,
 * one row is kept for the page footer and the entries are split into pages.
 */
function menuGrid(count: number, termWidth: number, termHeight: number): MenuGrid {
  const maxPanelHeight = Math.max(3, termHeight - 2);
  const colCount = Math.max(1, Math.min(4, Math.floor((termWidth - 4) / COL_WIDTH)));
  const availableWidth = Math.max(colCount, termWidth - 4 - (colCount - 1) * 4);
  const colWidth = Math.max(6, Math.min(COL_WIDTH, Math.floor(availableWidth / colCount)));
  const maxEntryRows = Math.max(1, Math.min(MAX_ENTRY_ROWS, maxPanelHeight - 2));
  const unclippedRows = Math.max(1, Math.ceil(count / colCount));
  if (unclippedRows <= maxEntryRows) {
    return { colCount, colWidth, rows: unclippedRows, pageSize: Math.max(1, count), pages: 1 };
  }
  const rows = Math.max(1, maxEntryRows - 1);
  const pageSize = rows * colCount;
  return { colCount, colWidth, rows, pageSize, pages: Math.max(1, Math.ceil(count / pageSize)) };
}

function truncateCells(text: string, maxCells: number): string {
  if (maxCells <= 0) return "";
  return cutCells(text, maxCells, { ellipsis: true });
}

function createKeyMenuController(getApi: () => AppApi): KeyMenuController {
  const deps = useDeps();
  const config = useConfig();
  const keys = useKeys();
  const dimensions = useTerminalDimensions();

  const [stack, setStack] = createSignal<LeaderNode<AppApi>[][]>([]);
  const [pageSignal, setPage] = createSignal(0);
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
    setPage(0);
    setTargetProgress(0);
  };

  const currentNodes = createMemo(() => {
    const s = stack();
    return s[s.length - 1] ?? [];
  });

  const grid = createMemo(() => menuGrid(currentNodes().length, dimensions().width, dimensions().height));
  // Clamped on every read, so a terminal that grows never leaves the menu on a page that is gone.
  const page = createMemo(() => Math.max(0, Math.min(grid().pages - 1, pageSignal())));
  const turnPage = (delta: 1 | -1): boolean => {
    const pages = grid().pages;
    if (pages <= 1) return false;
    setPage((page() + delta + pages) % pages);
    return true;
  };

  const open = (tree: LeaderNode<AppApi>[]) => {
    close();
    if (tree.length === 0) return;

    setStack([tree]);
    setPage(0);
    setTargetProgress(1);

    removeLayer = keys.pushLayer(
      (key) => {
        if (!key.ctrl && !key.meta && key.name === "backspace") {
          const s = stack();
          if (s.length > 1) {
            setStack(s.slice(0, -1));
            setPage(0);
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

        // Every entry's key works from any page: the lookup is over all of the current entries.
        if (!key.ctrl && !key.meta && key.text !== undefined) {
          const match = currentNodes().find((n) => n.key === key.text);
          if (match) {
            if (match.kind === "command") {
              close();
              void getApi().commands.run(match.command.id, "");
            } else {
              setStack((prev) => [...prev, match.children]);
              setPage(0);
            }
            return true;
          }
        }

        if (!key.ctrl && !key.meta) {
          if (key.name === "pagedown" || key.text === "]") {
            if (turnPage(1)) return true;
          } else if (key.name === "pageup" || key.text === "[") {
            if (turnPage(-1)) return true;
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
    grid,
    page,
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
        columns: [] as LeaderNode<AppApi>[][],
        colWidth: COL_WIDTH,
        panelHeight: 0,
        footer: null as string | null,
      };
    }

    const grid = controller.grid();
    const page = controller.page();
    const shown = nodes.slice(page * grid.pageSize, (page + 1) * grid.pageSize);

    const cols: LeaderNode<AppApi>[][] = [];
    for (let i = 0; i < shown.length; i += grid.rows) {
      cols.push(shown.slice(i, i + grid.rows));
    }

    const footer = grid.pages > 1 ? `page ${page + 1}/${grid.pages} · PgUp/PgDn` : null;
    const maxPanelHeight = Math.max(3, dimensions().height - 2);
    const panelHeight = Math.min(maxPanelHeight, grid.rows + 2 + (footer ? 1 : 0));

    return {
      columns: cols,
      colWidth: grid.colWidth,
      panelHeight,
      footer,
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
        flexDirection="column"
      >
        <box flexDirection="row" gap={4} flexGrow={1}>
          <For each={layout().columns}>
            {(col) => (
              <box flexDirection="column" width={layout().colWidth} flexShrink={0}>
                <For each={col}>
                  {(node) => {
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
        <Show when={layout().footer}>
          <box height={1} width="100%" flexShrink={0}>
            <text fg={theme.color("textMuted")} bg={theme.color("overlayBackground")} flexShrink={0}>
              {truncateCells(layout().footer!, Math.max(1, dimensions().width - 4))}
            </text>
          </box>
        </Show>
      </box>
    </Show>
  );
}
