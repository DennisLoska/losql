import { type BoxRenderable, TextAttributes } from "@opentui/core";
import { createMemo, For, type JSX, Match, Show, Switch } from "solid-js";
import type { Cell, RelationDetails, RelationRef } from "../../../core/db/types";
import { highlightSql, type SyntaxRole } from "../../../core/sql/highlight";
import type { ThemeToken } from "../../../core/theme/tokens";
import { useTheme } from "../../context/theme";
import { cellWidth, graphemes } from "../../ui/cells";
import { printable } from "../../ui/printable";
import { Spinner } from "../../ui/spinner";
import { DataGrid, type FlashSpec } from "./DataGrid";
import type { GridColumn, Viewport } from "./grid-model";
import { displayName } from "./relations";

export type StructureSection = "columns" | "indexes" | "constraints" | "definition";

export interface StructureState {
  ref: RelationRef;
  status: "loading" | "ready" | "missing" | "error";
  details: RelationDetails | null;
  error?: string;
  section: StructureSection;
}

/** A section drawn as a grid: its columns and rows, or null when the Driver cannot tell. */
export interface StructureTable {
  columns: GridColumn[];
  rows: string[][];
}

export const MISSING_TEXT = "Relation no longer exists — press c to pick another";

/** The sections a Relation offers, in order: Definition only when there is one. */
export function sectionsOf(details: RelationDetails | null): StructureSection[] {
  const sections: StructureSection[] = ["columns", "indexes", "constraints"];
  if (details?.definition !== undefined && details.definition !== "") sections.push("definition");
  return sections;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The banner's summary: counts of what the Driver could tell, leaving out what it could not. */
export function summaryOf(details: RelationDetails): string {
  const parts = [plural(details.columns.length, "col", "cols")];
  if (details.indexes) parts.push(`${details.indexes.length} idx`);
  if (details.constraints) parts.push(plural(details.constraints.length, "constraint", "constraints"));
  return parts.join(" · ");
}

function targetName(namespace: string | undefined, relation: string): string {
  return namespace ? `${namespace}.${relation}` : relation;
}

function actions(onUpdate?: string, onDelete?: string): string {
  const parts: string[] = [];
  if (onUpdate) parts.push(`ON UPDATE ${onUpdate}`);
  if (onDelete) parts.push(`ON DELETE ${onDelete}`);
  return parts.join(" ");
}

/** The rows of one grid section, or null when the Driver does not report it. Every cell is raw text. */
export function sectionTable(details: RelationDetails, section: StructureSection): StructureTable | null {
  if (section === "columns") {
    const pkCount = details.columns.filter((col) => col.primaryKeyPosition !== undefined).length;
    return {
      columns: [{ name: "Column" }, { name: "Type" }, { name: "Null" }, { name: "Default" }, { name: "Key" }],
      rows: details.columns.map((col) => {
        const keys: string[] = [];
        if (col.primaryKeyPosition !== undefined) {
          keys.push(pkCount > 1 ? `PK(${col.primaryKeyPosition})` : "PK");
        }
        for (const ref of col.references) keys.push(`FK -> ${targetName(ref.namespace, ref.relation)}.${ref.column}`);
        const defaultText =
          col.defaultValue ?? (col.generated !== undefined ? `generated: ${col.generated}` : "");
        return [col.name, col.type, col.nullable ? "null" : "not null", defaultText, keys.join(", ")];
      }),
    };
  }
  if (section === "indexes") {
    if (!details.indexes) return null;
    return {
      columns: [{ name: "Name" }, { name: "Flags" }, { name: "Columns" }, { name: "Method" }, { name: "Where" }],
      rows: details.indexes.map((index) => {
        const flags = index.primary ? "PK" : index.unique ? "UNIQUE" : "";
        const included = index.includedColumns?.length ? ` (inc: ${index.includedColumns.join(", ")})` : "";
        return [index.name, flags, index.columns.join(", ") + included, index.method ?? "", index.predicate ?? ""];
      }),
    };
  }
  if (section === "constraints") {
    if (!details.constraints) return null;
    return {
      columns: [{ name: "Name" }, { name: "Type" }, { name: "Columns" }, { name: "Definition" }],
      rows: details.constraints.map((constraint) => {
        let definition = constraint.definition ?? "";
        const target = constraint.references;
        if (constraint.kind === "FOREIGN KEY" && target) {
          const to = `-> ${targetName(target.namespace, target.relation)}(${target.columns.join(", ")})`;
          definition = [to, actions(target.onUpdate, target.onDelete)].filter(Boolean).join(" ");
        }
        return [constraint.name ?? "", constraint.kind, constraint.columns.join(", "), definition];
      }),
    };
  }
  return null;
}

const SECTION_LABELS: Record<StructureSection, string> = {
  columns: "Columns",
  indexes: "Indexes",
  constraints: "Constraints",
  definition: "Definition",
};

function sectionLabel(details: RelationDetails | null, section: StructureSection): string {
  const label = SECTION_LABELS[section];
  if (!details || section === "definition") return label;
  const count =
    section === "columns" ? details.columns.length : section === "indexes" ? details.indexes?.length : details.constraints?.length;
  return count === undefined ? label : `${label} (${count})`;
}

const UNAVAILABLE: Record<"indexes" | "constraints", string> = {
  indexes: "Indexes unavailable for this Driver",
  constraints: "Constraints unavailable for this Driver",
};

const EMPTY: Record<"columns" | "indexes" | "constraints", string> = {
  columns: "No columns",
  indexes: "No indexes",
  constraints: "No constraints",
};

/** The most rows the Enter detail takes, its scroll hint included. */
export const DETAIL_MAX_ROWS = 6;

/** One display row: the UTF-16 range [start, end) of the text it shows. */
export interface TextRange {
  start: number;
  end: number;
}

/**
 * Splits a printable text into the display rows the Structure draws, each at most `width` cells wide.
 * A line feed always ends a row; a row too wide breaks after its last space, or between grapheme
 * clusters when it has none. A width of 0 or less breaks only at line feeds. The rows cover the text in
 * order, without its line feeds, so drawing and scrolling count the same rows.
 */
export function wrapRanges(text: string, width: number): TextRange[] {
  const rows: TextRange[] = [];
  let rowStart = 0;
  let rowWidth = 0;
  // The end of the last space in the current row, and the width of the row up to it.
  let breakAt = -1;
  let breakWidth = 0;
  for (const { segment, index } of graphemes.segment(text)) {
    if (segment === "\n") {
      rows.push({ start: rowStart, end: index });
      rowStart = index + 1;
      rowWidth = 0;
      breakAt = -1;
      continue;
    }
    const w = cellWidth(segment);
    if (width > 0 && rowWidth > 0 && rowWidth + w > width) {
      if (breakAt > rowStart) {
        rows.push({ start: rowStart, end: breakAt });
        rowWidth -= breakWidth;
        rowStart = breakAt;
        // What follows the space can still be too wide for a wide grapheme: break before it too.
        if (rowWidth > 0 && rowWidth + w > width) {
          rows.push({ start: rowStart, end: index });
          rowStart = index;
          rowWidth = 0;
        }
      } else {
        rows.push({ start: rowStart, end: index });
        rowStart = index;
        rowWidth = 0;
      }
      breakAt = -1;
    }
    rowWidth += w;
    if (segment === " ") {
      breakAt = index + 1;
      breakWidth = rowWidth;
    }
  }
  rows.push({ start: rowStart, end: text.length });
  return rows;
}

/** The Definition as drawn: line breaks normalized to line feeds, control characters made visible. */
export function definitionText(details: RelationDetails | null): string {
  return printable(details?.definition ?? "", { keepNewlines: true });
}

/** One row of the Enter detail: the part of a field's label and the part of its value it shows. */
export interface DetailRow {
  label: string;
  value: string;
  selected: boolean;
}

/** The fields of the selected row as `Label: value`, each wrapped to `width` cells. */
export function detailRows(table: StructureTable | null, cursor: { row: number; column: number }, width: number): DetailRow[] {
  const row = table?.rows[cursor.row];
  if (!table || !row) return [];
  const out: DetailRow[] = [];
  table.columns.forEach((col, i) => {
    const prefix = `${printable(col.name)}: `;
    const full = prefix + printable(row[i] ?? "");
    for (const range of wrapRanges(full, width)) {
      out.push({
        label: range.start < prefix.length ? full.slice(range.start, Math.min(range.end, prefix.length)) : "",
        value: full.slice(Math.max(range.start, prefix.length), range.end),
        selected: i === cursor.column,
      });
    }
  });
  return out;
}

/** The Enter detail's layout: rows of content visible, whether it scrolls, whether a hint row shows, and its height. */
export interface DetailWindow {
  visible: number;
  scrollable: boolean;
  showHint: boolean;
  height: number;
}

/**
 * The window of the Enter detail for `total` rows inside a section `maxRows` tall: at most
 * DETAIL_MAX_ROWS and never taller than the section, so neither its rows nor its scroll hint are clipped.
 * The hint takes the last row while the detail scrolls, unless only one row fits.
 */
export function detailWindow(total: number, maxRows: number): DetailWindow {
  const cap = Math.min(DETAIL_MAX_ROWS, Math.max(1, maxRows));
  if (total <= cap) return { visible: total, scrollable: false, showHint: false, height: total };
  if (cap === 1) return { visible: 1, scrollable: true, showHint: false, height: 1 };
  return { visible: cap - 1, scrollable: true, showHint: true, height: cap };
}

const ROLE_TO_TOKEN: Record<SyntaxRole, ThemeToken> = {
  keyword: "syntaxKeyword",
  function: "syntaxFunction",
  variable: "syntaxVariable",
  string: "syntaxString",
  number: "syntaxNumber",
  type: "syntaxType",
  operator: "syntaxOperator",
  punctuation: "syntaxPunctuation",
  comment: "syntaxComment",
  text: "text",
};

interface Piece {
  text: string;
  token: ThemeToken;
}

/** The highlighted pieces of each display row, highlighting the whole text once so a wrap keeps colors. */
function highlightRows(text: string, rows: TextRange[]): Piece[][] {
  const roles: { start: number; end: number; token: ThemeToken }[] = [];
  let pos = 0;
  for (const span of text.length > 0 ? highlightSql(text) : []) {
    if (span.start > pos) roles.push({ start: pos, end: span.start, token: "text" });
    if (span.end > span.start && span.end > pos) {
      roles.push({ start: Math.max(pos, span.start), end: span.end, token: ROLE_TO_TOKEN[span.role] });
    }
    pos = Math.max(pos, span.end);
  }
  if (pos < text.length) roles.push({ start: pos, end: text.length, token: "text" });
  let first = 0;
  return rows.map((row) => {
    const pieces: Piece[] = [];
    while (first < roles.length && roles[first]!.end <= row.start) first++;
    for (let i = first; i < roles.length && roles[i]!.start < row.end; i++) {
      const role = roles[i]!;
      const start = Math.max(role.start, row.start);
      const end = Math.min(role.end, row.end);
      if (end > start) pieces.push({ text: text.slice(start, end), token: role.token });
    }
    return pieces;
  });
}

/**
 * The Structure of one Relation inside the Results Pane: a banner, a section strip, and the selected
 * section drawn as a grid (Columns, Indexes, Constraints) or as highlighted SQL (Definition).
 */
export function StructureView(props: {
  state: StructureState;
  cursor: { row: number; column: number };
  /** The wrapped rows of the Enter detail; empty while it is closed. */
  detailRows: DetailRow[];
  detailTop: number;
  /** The measured height of the section the detail opens in; it bounds the detail's height. */
  detailMaxRows: number;
  /** The wrapped rows of the Definition, as ranges of `definitionText(details)`. */
  definitionRows: TextRange[];
  definitionTop: number;
  definitionHeight: number;
  flash: FlashSpec | null;
  onViewport?: (vp: Viewport) => void;
  onDefinitionViewport?: (width: number, height: number) => void;
  onDetailSize?: (width: number, height: number) => void;
}): JSX.Element {
  const theme = useTheme();

  const details = () => props.state.details;
  const sections = createMemo(() => sectionsOf(details()));
  const table = createMemo(() => {
    const d = details();
    if (!d || props.state.section === "definition") return null;
    return sectionTable(d, props.state.section);
  });

  const detailView = createMemo(() => {
    const rows = props.detailRows;
    const { visible, showHint, height } = detailWindow(rows.length, props.detailMaxRows);
    const top = props.detailTop;
    const hint = showHint
      ? `detail ${top + 1}–${Math.min(rows.length, top + visible)}/${rows.length} · j/k scroll · esc close`
      : "";
    return { rows: rows.slice(top, top + visible), hint, height };
  });

  const definition = createMemo(() => definitionText(details()));
  const definitionPieces = createMemo(() => highlightRows(definition(), props.definitionRows));
  const visibleDefinition = createMemo(() =>
    definitionPieces().slice(props.definitionTop, props.definitionTop + Math.max(1, props.definitionHeight)),
  );

  let definitionBox: BoxRenderable | null = null;
  const reportDefinitionViewport = () => {
    if (definitionBox && definitionBox.width > 0 && definitionBox.height > 0) {
      props.onDefinitionViewport?.(definitionBox.width, definitionBox.height);
    }
  };

  let tableBox: BoxRenderable | null = null;
  const reportDetailSize = () => {
    if (tableBox && tableBox.width > 0 && tableBox.height > 0) props.onDetailSize?.(tableBox.width, tableBox.height);
  };

  const unavailableText = () => {
    const section = props.state.section;
    return section === "indexes" || section === "constraints" ? UNAVAILABLE[section] : "";
  };

  return (
    <box flexDirection="column" width="100%" height="100%" flexGrow={1}>
      <box height={1} width="100%" flexShrink={0} flexDirection="row" gap={2}>
        <text fg={theme.color("text")} attributes={TextAttributes.BOLD} flexShrink={0}>
          {printable(displayName(props.state.ref))}
        </text>
        <Show when={details()}>
          <text fg={theme.color("textMuted")} flexShrink={0}>
            {details()!.kind}
          </text>
          <text fg={theme.color("textMuted")} flexShrink={0}>
            {summaryOf(details()!)}
          </text>
        </Show>
        <box flexGrow={1} />
        <text fg={theme.color("textMuted")} flexShrink={0}>
          c switch  q back
        </text>
      </box>

      <box height={1} width="100%" flexShrink={0} flexDirection="row" gap={2}>
        <For each={sections()}>
          {(section) => {
            const active = () => props.state.section === section;
            return (
              <text
                fg={active() ? theme.color("primary") : theme.color("textMuted")}
                attributes={active() ? TextAttributes.BOLD : undefined}
                flexShrink={0}
              >
                {sectionLabel(details(), section)}
              </text>
            );
          }}
        </For>
      </box>

      <Switch>
        <Match when={props.state.status === "loading" && !details()}>
          <Spinner label="loading structure" />
        </Match>
        <Match when={props.state.status === "missing"}>
          <text fg={theme.color("warning")}>{MISSING_TEXT}</text>
        </Match>
        <Match when={props.state.status === "error"}>
          <text fg={theme.color("error")}>{props.state.error ?? "The structure could not be read"}</text>
        </Match>
        <Match when={props.state.section === "definition"}>
          <box
            ref={(el: BoxRenderable) => {
              definitionBox = el;
              reportDefinitionViewport();
            }}
            onSizeChange={reportDefinitionViewport}
            flexGrow={1}
            width="100%"
            flexDirection="column"
            overflow="hidden"
          >
            <For each={visibleDefinition()}>
              {(pieces) => (
                <box height={1} width="100%" flexShrink={0} overflow="hidden">
                  <text fg={theme.color("text")} wrapMode="none">
                    <For each={pieces}>
                      {(piece) => <span style={{ fg: theme.color(piece.token) }}>{piece.text}</span>}
                    </For>
                  </text>
                </box>
              )}
            </For>
          </box>
        </Match>
        <Match when={details() && table() === null}>
          <text fg={theme.color("textMuted")}>{unavailableText()}</text>
        </Match>
        <Match when={table() !== null && table()!.rows.length === 0}>
          <text fg={theme.color("textMuted")}>
            {EMPTY[props.state.section as "columns" | "indexes" | "constraints"]}
          </text>
        </Match>
        <Match when={table()}>
          {(current: () => StructureTable) => (
            <box
              ref={(el: BoxRenderable) => {
                tableBox = el;
                reportDetailSize();
              }}
              onSizeChange={reportDetailSize}
              flexDirection="column"
              flexGrow={1}
              width="100%"
              overflow="hidden"
            >
              <box flexGrow={1} flexShrink={1} minHeight={0} width="100%" overflow="hidden">
                <Show when={current()} keyed>
                  {(t: StructureTable) => (
                    <DataGrid
                      columns={t.columns}
                      rows={t.rows as Cell[][]}
                      cursor={props.cursor}
                      selectedRows={null}
                      flash={props.flash}
                      onViewport={(vp) => props.onViewport?.(vp)}
                    />
                  )}
                </Show>
              </box>
              <Show when={detailView().rows.length > 0}>
                <box
                  flexDirection="column"
                  width="100%"
                  flexShrink={0}
                  height={detailView().height}
                  overflow="hidden"
                  backgroundColor={theme.color("backgroundElement")}
                >
                  <For each={detailView().rows}>
                    {(line) => (
                      <box flexDirection="row" width="100%" height={1} flexShrink={0} overflow="hidden">
                        <text
                          fg={line.selected ? theme.color("primary") : theme.color("textMuted")}
                          bg={theme.color("backgroundElement")}
                          attributes={line.selected ? TextAttributes.BOLD : undefined}
                          wrapMode="none"
                          flexShrink={0}
                        >
                          {line.label}
                        </text>
                        <text fg={theme.color("text")} bg={theme.color("backgroundElement")} wrapMode="none" flexShrink={0}>
                          {line.value}
                        </text>
                      </box>
                    )}
                  </For>
                  <Show when={detailView().hint}>
                    <box height={1} width="100%" flexShrink={0} overflow="hidden">
                      <text fg={theme.color("textMuted")} bg={theme.color("backgroundElement")} wrapMode="none">
                        {detailView().hint}
                      </text>
                    </box>
                  </Show>
                </box>
              </Show>
            </box>
          )}
        </Match>
      </Switch>
    </box>
  );
}
