import type { Relation, RelationColumn, SchemaSnapshot } from "../../../core/db/types";
import { fuzzyFilter } from "../../../core/fuzzy";
import { quoteIdentifier } from "../../../core/sql/identifier";
import { cellWidth, cutCells } from "../../ui/cells";
import { printable } from "../../ui/printable";

export type TreeRow =
  | { kind: "namespace"; id: string; depth: 0; label: string; expanded: boolean }
  | {
      kind: "relation";
      id: string;
      depth: 1;
      label: string;
      expanded: boolean;
      namespace: string;
      relation: Relation;
    }
  | {
      kind: "column";
      id: string;
      depth: 2;
      label: string;
      detail: string;
      namespace: string;
      relation: Relation;
      column: RelationColumn;
    };

interface RelationCacheEntry {
  id: string;
  collapsedRow: TreeRow;
  expandedRow: TreeRow;
  columnRows: TreeRow[] | null;
}

interface NamespaceCacheEntry {
  name: string;
  id: string;
  collapsedRow: TreeRow;
  expandedRow: TreeRow;
  relations: Relation[];
  relationEntries: Map<Relation, RelationCacheEntry>;
}

interface SchemaCache {
  namespaces: NamespaceCacheEntry[];
  lastFilter: string | null;
  filteredRelations: Relation[][] | null;
}

const schemaCacheMap = new WeakMap<SchemaSnapshot, SchemaCache>();

function columnDetail(col: RelationColumn): string {
  let detail = col.type;
  if (col.primaryKey) {
    detail += " pk";
  }
  if (col.references) {
    detail += ` → ${col.references.relation}.${col.references.column}`;
  }
  return detail;
}

function getRelationCache(nsName: string, rel: Relation): RelationCacheEntry {
  const id = `rel:${nsName}.${rel.name}`;
  const label = rel.kind === "view" ? `${rel.name} (view)` : rel.name;
  return {
    id,
    collapsedRow: {
      kind: "relation",
      id,
      depth: 1,
      label,
      expanded: false,
      namespace: nsName,
      relation: rel,
    },
    expandedRow: {
      kind: "relation",
      id,
      depth: 1,
      label,
      expanded: true,
      namespace: nsName,
      relation: rel,
    },
    columnRows: null,
  };
}

function getColumnRows(nsName: string, rel: Relation, entry: RelationCacheEntry): TreeRow[] {
  if (entry.columnRows === null) {
    entry.columnRows = rel.columns.map((col) => ({
      kind: "column" as const,
      id: `col:${nsName}.${rel.name}.${col.name}`,
      depth: 2 as const,
      label: col.name,
      detail: columnDetail(col),
      namespace: nsName,
      relation: rel,
      column: col,
    }));
  }
  return entry.columnRows;
}

function getSchemaCache(schema: SchemaSnapshot): SchemaCache {
  let cached = schemaCacheMap.get(schema);
  if (cached) return cached;

  const namespaces: NamespaceCacheEntry[] = schema.namespaces.map((ns) => {
    const id = `ns:${ns.name}`;
    const relationEntries = new Map<Relation, RelationCacheEntry>();
    for (const rel of ns.relations) {
      relationEntries.set(rel, getRelationCache(ns.name, rel));
    }
    return {
      name: ns.name,
      id,
      collapsedRow: {
        kind: "namespace",
        id,
        depth: 0,
        label: ns.name,
        expanded: false,
      },
      expandedRow: {
        kind: "namespace",
        id,
        depth: 0,
        label: ns.name,
        expanded: true,
      },
      relations: ns.relations,
      relationEntries,
    };
  });

  cached = {
    namespaces,
    lastFilter: null,
    filteredRelations: null,
  };
  schemaCacheMap.set(schema, cached);
  return cached;
}

export function defaultExpanded(schema: SchemaSnapshot): Set<string> {
  return new Set(schema.namespaces.map((ns) => `ns:${ns.name}`));
}

export function buildTree(
  schema: SchemaSnapshot,
  expanded: ReadonlySet<string>,
  filter: string,
): TreeRow[] {
  const cache = getSchemaCache(schema);
  const rows: TreeRow[] = [];

  if (filter.length === 0) {
    for (const ns of cache.namespaces) {
      const nsExpanded = expanded.has(ns.id);
      rows.push(nsExpanded ? ns.expandedRow : ns.collapsedRow);
      if (nsExpanded) {
        for (const rel of ns.relations) {
          let relEntry = ns.relationEntries.get(rel);
          if (!relEntry) {
            relEntry = getRelationCache(ns.name, rel);
            ns.relationEntries.set(rel, relEntry);
          }
          const relExpanded = expanded.has(relEntry.id);
          rows.push(relExpanded ? relEntry.expandedRow : relEntry.collapsedRow);
          if (relExpanded) {
            const colRows = getColumnRows(ns.name, rel, relEntry);
            for (let i = 0; i < colRows.length; i++) {
              rows.push(colRows[i]!);
            }
          }
        }
      }
    }
    return rows;
  }

  let matchedPerNs = cache.filteredRelations;
  if (cache.lastFilter !== filter || matchedPerNs === null) {
    matchedPerNs = cache.namespaces.map((ns) =>
      fuzzyFilter(filter, ns.relations, (r) => r.name),
    );
    cache.lastFilter = filter;
    cache.filteredRelations = matchedPerNs;
  }

  for (let nIdx = 0; nIdx < cache.namespaces.length; nIdx++) {
    const ns = cache.namespaces[nIdx]!;
    const matched = matchedPerNs[nIdx]!;
    if (matched.length === 0) continue;

    rows.push(ns.expandedRow);
    for (const rel of matched) {
      let relEntry = ns.relationEntries.get(rel);
      if (!relEntry) {
        relEntry = getRelationCache(ns.name, rel);
        ns.relationEntries.set(rel, relEntry);
      }
      const relExpanded = expanded.has(relEntry.id);
      rows.push(relExpanded ? relEntry.expandedRow : relEntry.collapsedRow);
      if (relExpanded) {
        const colRows = getColumnRows(ns.name, rel, relEntry);
        for (let i = 0; i < colRows.length; i++) {
          rows.push(colRows[i]!);
        }
      }
    }
  }

  return rows;
}

export { quoteIdentifier };

export function qualifiedName(namespace: string, relation: string): string {
  const quotedRel = quoteIdentifier(relation);
  if (namespace === "main" || namespace === "public") {
    return quotedRel;
  }
  return `${quoteIdentifier(namespace)}.${quotedRel}`;
}

export function peekSql(namespace: string, relation: string, limit: number): string {
  return `select * from ${qualifiedName(namespace, relation)} limit ${limit}`;
}

export function rowText(row: TreeRow): string {
  if (row.kind === "namespace") {
    return quoteIdentifier(row.label);
  }
  if (row.kind === "relation") {
    return qualifiedName(row.namespace, row.relation.name);
  }
  return quoteIdentifier(row.column.name);
}

export function truncateCells(text: string, maxCells: number): string {
  if (maxCells <= 0) return "";
  return cutCells(text, maxCells, { ellipsis: true });
}

export function formatColumnRow(
  rawLabel: string,
  rawDetail: string,
  availWidth: number,
): { label: string; detail: string } {
  const cleanLabel = printable(rawLabel);
  const cleanDetail = printable(rawDetail);
  const contentBudget = Math.max(0, availWidth - 4);
  if (contentBudget <= 0) {
    return { label: "", detail: "" };
  }
  const labelW = cellWidth(cleanLabel);
  const detailW = cellWidth(cleanDetail);
  if (cleanDetail.length === 0) {
    return { label: truncateCells(cleanLabel, contentBudget), detail: "" };
  }
  if (labelW + 2 + detailW <= contentBudget) {
    return { label: cleanLabel, detail: `  ${cleanDetail}` };
  }
  const minLabelCells = Math.min(labelW, 4);
  if (minLabelCells + 2 + detailW <= contentBudget) {
    const labelBudget = contentBudget - 2 - detailW;
    return {
      label: truncateCells(cleanLabel, labelBudget),
      detail: `  ${cleanDetail}`,
    };
  }
  const labelBudget = Math.max(
    1,
    Math.min(labelW, Math.max(4, Math.floor((contentBudget - 2) / 2))),
  );
  const fittedLabel = truncateCells(cleanLabel, labelBudget);
  const usedLabel = cellWidth(fittedLabel);
  const detailBudget = Math.max(0, contentBudget - usedLabel - 2);
  if (detailBudget === 0) {
    return { label: truncateCells(cleanLabel, contentBudget), detail: "" };
  }
  return {
    label: fittedLabel,
    detail: `  ${truncateCells(cleanDetail, detailBudget)}`,
  };
}

export function syncExpandedOnRefresh(
  prevSchema: SchemaSnapshot | null,
  nextSchema: SchemaSnapshot,
  prevExpanded: ReadonlySet<string>,
): Set<string> {
  if (prevSchema === null) {
    return defaultExpanded(nextSchema);
  }
  const prevNsNames = new Set(prevSchema.namespaces.map((ns) => ns.name));
  const next = new Set<string>();
  let hasRelInPrev = false;
  for (const id of prevExpanded) {
    if (id.startsWith("rel:")) {
      hasRelInPrev = true;
      break;
    }
  }

  const validRelIds = new Set<string>();
  for (const ns of nextSchema.namespaces) {
    const nsId = `ns:${ns.name}`;
    if (!prevNsNames.has(ns.name) || prevExpanded.has(nsId)) {
      next.add(nsId);
    }
    if (hasRelInPrev) {
      for (const rel of ns.relations) {
        validRelIds.add(`rel:${ns.name}.${rel.name}`);
      }
    }
  }

  if (hasRelInPrev) {
    for (const id of prevExpanded) {
      if (id.startsWith("rel:") && validRelIds.has(id)) {
        next.add(id);
      }
    }
  }

  return next;
}

