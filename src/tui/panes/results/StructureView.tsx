import { type BoxRenderable, TextAttributes } from "@opentui/core";
import { createMemo, For, type JSX, Match, Show, Switch } from "solid-js";
import type { Cell, RelationDetails, RelationRef } from "../../../core/db/types";
import { useTheme } from "../../context/theme";
import { Highlighted } from "../../ui/highlighted";
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

const DETAIL_MAX_ROWS = 6;

/**
 * The Structure of one Relation inside the Results Pane: a banner, a section strip, and the selected
 * section drawn as a grid (Columns, Indexes, Constraints) or as highlighted SQL (Definition).
 */
export function StructureView(props: {
  state: StructureState;
  cursor: { row: number; column: number };
  detailOpen: boolean;
  definitionTop: number;
  flash: FlashSpec | null;
  onViewport?: (vp: Viewport) => void;
  onDefinitionHeight?: (height: number) => void;
}): JSX.Element {
  const theme = useTheme();

  const details = () => props.state.details;
  const sections = createMemo(() => sectionsOf(details()));
  const table = createMemo(() => {
    const d = details();
    if (!d || props.state.section === "definition") return null;
    return sectionTable(d, props.state.section);
  });

  const detailLines = createMemo(() => {
    const t = table();
    if (!props.detailOpen || !t) return [];
    const row = t.rows[props.cursor.row];
    if (!row) return [];
    return t.columns.map((col, i) => ({ label: col.name, value: row[i] ?? "", selected: i === props.cursor.column }));
  });

  const definitionLines = createMemo(() => printable(details()?.definition ?? "", { keepNewlines: true }).split("\n"));

  let definitionBox: BoxRenderable | null = null;
  const reportDefinitionHeight = () => {
    if (definitionBox && definitionBox.height > 0) props.onDefinitionHeight?.(definitionBox.height);
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
              reportDefinitionHeight();
            }}
            onSizeChange={reportDefinitionHeight}
            flexGrow={1}
            width="100%"
            flexDirection="column"
          >
            <Highlighted
              language="sql"
              text={definitionLines().slice(props.definitionTop).join("\n")}
            />
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
            <box flexDirection="column" flexGrow={1} width="100%">
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
              <Show when={detailLines().length > 0}>
                <box
                  flexDirection="column"
                  width="100%"
                  flexShrink={0}
                  maxHeight={DETAIL_MAX_ROWS}
                  backgroundColor={theme.color("backgroundElement")}
                >
                  <For each={detailLines()}>
                    {(line) => (
                      <box flexDirection="row" width="100%" flexShrink={0}>
                        <text
                          fg={line.selected ? theme.color("primary") : theme.color("textMuted")}
                          bg={theme.color("backgroundElement")}
                          attributes={line.selected ? TextAttributes.BOLD : undefined}
                          flexShrink={0}
                        >
                          {`${line.label}: `}
                        </text>
                        <text fg={theme.color("text")} bg={theme.color("backgroundElement")} flexShrink={1}>
                          {printable(line.value)}
                        </text>
                      </box>
                    )}
                  </For>
                </box>
              </Show>
            </box>
          )}
        </Match>
      </Switch>
    </box>
  );
}
