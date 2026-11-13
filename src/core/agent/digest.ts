import type { Relation, SchemaSnapshot } from "../db/types";
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

export function describeRelations(schema: SchemaSnapshot, names: string[]): string {
  const qualifiedMap = new Map<string, { namespace: string; relation: Relation }>();
  const unqualifiedMap = new Map<string, { namespace: string; relation: Relation }>();

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

  const boundedNames = names.slice(0, MAX_DESCRIBE_RELATIONS);
  const extraCount = Math.max(0, names.length - boundedNames.length);
  const extraLine = extraCount > 0 ? `… and ${extraCount} more not shown` : undefined;
  const blocks: string[][] = [];

  for (const requested of boundedNames) {
    const key = requested.toLowerCase();
    const matched = requested.includes(".")
      ? qualifiedMap.get(key)
      : unqualifiedMap.get(key);

    if (!matched) {
      blocks.push([`${sanitizeIdentifier(requested)}: no such relation`]);
      continue;
    }

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
    blocks.push(relLines);
  }

  const allLines = blocks.flat();
  if (extraLine !== undefined) {
    allLines.push(extraLine);
  }
  const fullText = allLines.join("\n");
  if (fullText.length <= MAX_DESCRIBE_CHARS) {
    return fullText;
  }

  const totalRelations = names.length;
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



