import type { Relation, RelationDetails, RelationRef, SchemaSnapshot } from "../db/types";
import { MAX_DESCRIBE_CHARS, MAX_DIGEST_CHARS } from "./prompt";

const DEFAULT_MAX_RELATIONS = 60;
const MAX_IDENTIFIER_CHARS = 64;

export function sanitizeIdentifier(text: string): string {
  const cleaned = text
    .replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, " ")
    .replace(/[<>]/g, "_");
  if (cleaned.length > MAX_IDENTIFIER_CHARS) {
    let end = MAX_IDENTIFIER_CHARS;
    const prev = cleaned.charCodeAt(end - 1);
    if (prev >= 0xd800 && prev <= 0xdbff) {
      end--;
    }
    return `${cleaned.slice(0, end)}…`;
  }
  return cleaned;
}

function displayRelationName(namespace: string, relationName: string): string {
  const cleanRel = sanitizeIdentifier(relationName);
  if (namespace === "main" || namespace === "public") {
    return cleanRel;
  }
  return `${sanitizeIdentifier(namespace)}.${cleanRel}`;
}

function formatNamesOnlyDigest(displayNames: string[]): string {
  const total = displayNames.length;
  const header = `${total} relations (names only; use the describe action to see columns):\n`;

  let bodyLen = 0;
  let bestK = 0;
  let bestSuffix = `\n… (${total} more relations omitted)`;

  for (let k = 1; k <= total; k++) {
    const nameLen = displayNames[k - 1]!.length;
    bodyLen += k === 1 ? nameLen : 2 + nameLen;
    if (k === total) {
      if (header.length + bodyLen <= MAX_DIGEST_CHARS) {
        return `${header}${displayNames.join(", ")}`;
      }
      break;
    }
    const omitted = total - k;
    const suffix = `\n… (${omitted} more relations omitted)`;
    if (header.length + bodyLen + suffix.length <= MAX_DIGEST_CHARS) {
      bestK = k;
      bestSuffix = suffix;
    } else if (header.length + bodyLen > MAX_DIGEST_CHARS) {
      break;
    }
  }

  if (bestK >= 1) {
    return `${header}${displayNames.slice(0, bestK).join(", ")}${bestSuffix}`;
  }
  return `${header}… (${total} more relations omitted)`;
}

export function schemaDigest(
  schema: SchemaSnapshot,
  options?: { maxRelations?: number },
): string {
  const maxRelations = options?.maxRelations ?? DEFAULT_MAX_RELATIONS;
  const entries: { namespace: string; relation: Relation; displayName: string }[] = [];

  for (const ns of schema.namespaces) {
    for (const rel of ns.relations) {
      entries.push({
        namespace: ns.name,
        relation: rel,
        displayName: displayRelationName(ns.name, rel.name),
      });
    }
  }

  if (entries.length === 0) {
    return "(the database has no tables or views)";
  }

  if (entries.length > maxRelations) {
    return formatNamesOnlyDigest(entries.map((e) => e.displayName));
  }

  const lines: string[] = [];
  for (const { relation, displayName } of entries) {
    const prefix = relation.kind === "view" ? "view " : "";
    const cols = relation.columns
      .map((col) => {
        let part = `${sanitizeIdentifier(col.name)} ${sanitizeIdentifier(col.type)}`;
        if (col.primaryKey) {
          part += " pk";
        }
        if (col.references) {
          part += ` -> ${sanitizeIdentifier(col.references.relation)}.${sanitizeIdentifier(col.references.column)}`;
        }
        return part;
      })
      .join(", ");
    lines.push(`${prefix}${displayName}(${cols})`);
  }

  const fullText = lines.join("\n");
  if (fullText.length > MAX_DIGEST_CHARS) {
    return formatNamesOnlyDigest(entries.map((e) => e.displayName));
  }

  return fullText;
}

export const MAX_DESCRIBE_RELATIONS = 50;
const MAX_DESCRIBE_EXPRESSION_CHARS = 400;

interface ResolvedRelation {
  namespace: string;
  relation: Relation;
}

/** Case-insensitive lookup of requested names: `ns.rel` against qualified names, `rel` against the first match. */
function relationResolver(schema: SchemaSnapshot): (requested: string) => ResolvedRelation | undefined {
  const qualifiedMap = new Map<string, ResolvedRelation>();
  const unqualifiedMap = new Map<string, ResolvedRelation>();

  for (const ns of schema.namespaces) {
    const nsLower = ns.name.toLowerCase();
    for (const rel of ns.relations) {
      const relLower = rel.name.toLowerCase();
      const entry = { namespace: ns.name, relation: rel };
      const qualKey = `${nsLower}.${relLower}`;
      if (!qualifiedMap.has(qualKey)) {
        qualifiedMap.set(qualKey, entry);
      }
      if (!unqualifiedMap.has(relLower)) {
        unqualifiedMap.set(relLower, entry);
      }
    }
  }

  return (requested) => {
    const key = requested.toLowerCase();
    return requested.includes(".") ? qualifiedMap.get(key) : unqualifiedMap.get(key);
  };
}

/**
 * SQL text from the database (defaults, generated expressions, index predicates, constraint
 * definitions) is untrusted data: control characters and line breaks become spaces, angle brackets
 * become full-width look-alikes so no prompt tag can be opened or closed, and the text is bounded.
 */
function sanitizeSqlText(text: string): string {
  const cleaned = text
    .replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, " ")
    .replace(/</g, "\uFF1C")
    .replace(/>/g, "\uFF1E");
  if (cleaned.length > MAX_DESCRIBE_EXPRESSION_CHARS) {
    let end = MAX_DESCRIBE_EXPRESSION_CHARS;
    const prev = cleaned.charCodeAt(end - 1);
    if (prev >= 0xd800 && prev <= 0xdbff) {
      end--;
    }
    return `${cleaned.slice(0, end)}…`;
  }
  return cleaned;
}

function unknownRelationBlock(requested: string): string[] {
  return [`${sanitizeIdentifier(requested)}: no such relation`];
}

function snapshotBlock(matched: ResolvedRelation): string[] {
  const relLines: string[] = [];
  const displayName = displayRelationName(matched.namespace, matched.relation.name);
  relLines.push(`${displayName} (${matched.relation.kind})`);
  for (const col of matched.relation.columns) {
    let colLine = `  ${sanitizeIdentifier(col.name)} ${sanitizeIdentifier(col.type)}`;
    if (!col.nullable) {
      colLine += " not null";
    }
    if (col.primaryKey) {
      colLine += " primary key";
    }
    if (col.references) {
      colLine += ` references ${sanitizeIdentifier(col.references.relation)}.${sanitizeIdentifier(col.references.column)}`;
    }
    relLines.push(colLine);
  }
  return relLines;
}

function qualifiedTarget(namespace: string | undefined, relation: string): string {
  const rel = sanitizeIdentifier(relation);
  return namespace !== undefined ? `${sanitizeIdentifier(namespace)}.${rel}` : rel;
}

function detailsBlock(matched: ResolvedRelation, details: RelationDetails): string[] {
  const lines: string[] = [];
  const displayName = displayRelationName(matched.namespace, matched.relation.name);
  lines.push(`${displayName} (${details.kind})`);

  for (const col of details.columns) {
    let colLine = `  ${sanitizeIdentifier(col.name)} ${sanitizeIdentifier(col.type)}`;
    if (!col.nullable) {
      colLine += " not null";
    }
    if (col.defaultValue !== undefined) {
      colLine += ` default ${sanitizeSqlText(col.defaultValue)}`;
    }
    if (col.generated !== undefined) {
      colLine += ` generated ${sanitizeSqlText(col.generated)}`;
    }
    if (col.primaryKeyPosition !== undefined) {
      colLine += " primary key";
    }
    for (const ref of col.references) {
      colLine += ` references ${qualifiedTarget(ref.namespace, ref.relation)}.${sanitizeIdentifier(ref.column)}`;
    }
    lines.push(colLine);
  }

  if (details.indexes !== undefined) {
    lines.push("indexes:");
    if (details.indexes.length === 0) {
      lines.push("  (none)");
    }
    for (const index of details.indexes) {
      let line = `  ${sanitizeIdentifier(index.name)}`;
      if (index.primary) {
        line += " primary";
      } else if (index.unique) {
        line += " unique";
      }
      line += ` (${index.columns.map(sanitizeSqlText).join(", ")})`;
      if (index.includedColumns !== undefined && index.includedColumns.length > 0) {
        line += ` include (${index.includedColumns.map(sanitizeIdentifier).join(", ")})`;
      }
      if (index.method !== undefined) {
        line += ` ${sanitizeIdentifier(index.method)}`;
      }
      if (index.predicate !== undefined) {
        line += ` where ${sanitizeSqlText(index.predicate)}`;
      }
      lines.push(line);
    }
  }

  if (details.constraints !== undefined) {
    lines.push("constraints:");
    if (details.constraints.length === 0) {
      lines.push("  (none)");
    }
    for (const constraint of details.constraints) {
      let line = "  ";
      if (constraint.name !== undefined) {
        line += `${sanitizeIdentifier(constraint.name)} `;
      }
      line += constraint.kind;
      if (constraint.columns.length > 0) {
        line += ` (${constraint.columns.map(sanitizeIdentifier).join(", ")})`;
      }
      if (constraint.definition !== undefined) {
        line += `: ${sanitizeSqlText(constraint.definition)}`;
      } else if (constraint.references !== undefined) {
        const target = qualifiedTarget(constraint.references.namespace, constraint.references.relation);
        line += ` references ${target} (${constraint.references.columns.map(sanitizeIdentifier).join(", ")})`;
      }
      lines.push(line);
    }
  }

  return lines;
}

/** Joins describe blocks and keeps the text within MAX_DESCRIBE_CHARS, cutting at line boundaries. */
function boundDescribeText(blocks: string[][], totalRelations: number): string {
  const extraCount = Math.max(0, totalRelations - MAX_DESCRIBE_RELATIONS);
  const allLines = blocks.flat();
  if (extraCount > 0) {
    allLines.push(`… and ${extraCount} more not shown`);
  }
  const fullText = allLines.join("\n");
  if (fullText.length <= MAX_DESCRIBE_CHARS) {
    return fullText;
  }

  const keptLines: string[] = [];
  let completedRelations = 0;

  for (let r = 0; r < blocks.length; r++) {
    const block = blocks[r]!;
    const remainingRelationsIfStoppedInThisBlock = totalRelations - completedRelations;

    let finishedBlock = true;
    for (let l = 0; l < block.length; l++) {
      const candidateLines = [...keptLines, block[l]!];
      const candidateBody = candidateLines.join("\n");
      const remainingAfterLine =
        l === block.length - 1 ? totalRelations - (completedRelations + 1) : remainingRelationsIfStoppedInThisBlock;
      const suffix =
        remainingAfterLine > 0 ? `\n… (${remainingAfterLine} more relations omitted)` : "";
      if (candidateBody.length + suffix.length <= MAX_DESCRIBE_CHARS) {
        keptLines.push(block[l]!);
      } else {
        finishedBlock = false;
        break;
      }
    }

    if (finishedBlock) {
      completedRelations++;
    } else {
      break;
    }
  }

  const omitted = totalRelations - completedRelations;
  if (keptLines.length === 0) {
    return `… (${omitted} more relations omitted)`;
  }
  return `${keptLines.join("\n")}\n… (${omitted} more relations omitted)`;
}

export function describeRelations(schema: SchemaSnapshot, names: string[]): string {
  const resolve = relationResolver(schema);
  const blocks = names.slice(0, MAX_DESCRIBE_RELATIONS).map((requested) => {
    const matched = resolve(requested);
    return matched ? snapshotBlock(matched) : unknownRelationBlock(requested);
  });
  return boundDescribeText(blocks, names.length);
}

/**
 * Like describeRelations, but asks `load` for the Driver's rich Relation details (defaults,
 * generated columns, indexes, constraints). Each resolved Relation is loaded at most once; a null
 * from `load` falls back to the Schema snapshot columns. An aborted signal stops before the next load.
 */
export async function describeRelationsWithDetails(
  schema: SchemaSnapshot,
  names: string[],
  load: (ref: RelationRef, signal?: AbortSignal) => Promise<RelationDetails | null>,
  signal?: AbortSignal,
): Promise<string> {
  const resolve = relationResolver(schema);
  const loaded = new Map<string, RelationDetails | null>();
  const blocks: string[][] = [];

  for (const requested of names.slice(0, MAX_DESCRIBE_RELATIONS)) {
    const matched = resolve(requested);
    if (!matched) {
      blocks.push(unknownRelationBlock(requested));
      continue;
    }

    const key = `${matched.namespace}\u0000${matched.relation.name}`;
    let details = loaded.get(key);
    if (details === undefined) {
      signal?.throwIfAborted();
      details = await load({ namespace: matched.namespace, name: matched.relation.name }, signal);
      loaded.set(key, details);
    }
    blocks.push(details === null ? snapshotBlock(matched) : detailsBlock(matched, details));
  }

  return boundDescribeText(blocks, names.length);
}
