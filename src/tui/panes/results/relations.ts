import type {
  Relation,
  RelationColumnDetail,
  RelationDetails,
  RelationRef,
  SchemaSnapshot,
} from "../../../core/db/types";
import type { DialogApi } from "../../context/dialog";
import type { SelectOption } from "../../ui/select";

export function sameRelation(a: RelationRef | null | undefined, b: RelationRef | null | undefined): boolean {
  return a != null && b != null && a.namespace === b.namespace && a.name === b.name;
}

export function qualifiedName(ref: RelationRef): string {
  return `${ref.namespace}.${ref.name}`;
}

/** The name as a banner shows it: bare in the default namespace (`main`, `public`), qualified elsewhere. */
export function displayName(ref: RelationRef): string {
  return ref.namespace === "main" || ref.namespace === "public" ? ref.name : qualifiedName(ref);
}

export function findRelation(schema: SchemaSnapshot | null, ref: RelationRef): Relation | undefined {
  return schema?.namespaces
    .find((ns) => ns.name === ref.namespace)
    ?.relations.find((rel) => rel.name === ref.name);
}

function allRelations(schema: SchemaSnapshot): RelationRef[] {
  return schema.namespaces.flatMap((ns) => ns.relations.map((rel) => ({ namespace: ns.name, name: rel.name })));
}

/**
 * The Relation a Command argument names, from the latest snapshot: `name` or `namespace.name`, an exact
 * match before a case-folded one. Throws a Command error when nothing or more than one Relation matches.
 */
export function resolveRelation(schema: SchemaSnapshot | null, arg: string): RelationRef {
  const input = arg.trim();
  if (!schema) throw new Error("The schema is not loaded yet");
  const refs = allRelations(schema);
  const matching = (fold: (text: string) => string): RelationRef[] => {
    const wanted = fold(input);
    const qualified = refs.filter((ref) => fold(qualifiedName(ref)) === wanted);
    if (qualified.length > 0) return qualified;
    return refs.filter((ref) => fold(ref.name) === wanted);
  };
  for (const fold of [(text: string) => text, (text: string) => text.toLowerCase()]) {
    const found = matching(fold);
    if (found.length === 1) return found[0]!;
    if (found.length > 1) {
      const names = found.slice(0, 5).map(qualifiedName).join(", ");
      throw new Error(`Ambiguous Relation: ${input} (${names})`);
    }
  }
  throw new Error(`No Relation named ${input}`);
}

/** Opens the Relation picker over the snapshot, preselecting `current` when it is still there. */
export async function pickRelation(
  dialog: DialogApi,
  schema: SchemaSnapshot | null,
  current: RelationRef | null,
): Promise<RelationRef | null> {
  if (!schema) throw new Error("The schema is not loaded yet");
  const options: SelectOption<RelationRef>[] = schema.namespaces.flatMap((ns) =>
    ns.relations.map((rel) => ({
      title: qualifiedName({ namespace: ns.name, name: rel.name }),
      value: { namespace: ns.name, name: rel.name },
      hint: rel.kind,
    })),
  );
  const preselect = options.find((opt) => sameRelation(opt.value, current))?.value;
  return dialog.select<RelationRef>({
    title: "Inspect structure",
    options,
    placeholder: "Relation",
    empty: "No Relations",
    ...(preselect ? { current: preselect } : {}),
  });
}

/**
 * Structure built from the snapshot, for a Driver without `describeRelation`: the columns only.
 * Indexes, constraints and the definition stay undefined, which the view reports as unavailable.
 */
export function detailsFromSnapshot(ref: RelationRef, relation: Relation): RelationDetails {
  let pkPosition = 0;
  const columns: RelationColumnDetail[] = relation.columns.map((col) => {
    const detail: RelationColumnDetail = {
      name: col.name,
      type: col.type,
      nullable: col.nullable,
      references: col.references ? [{ relation: col.references.relation, column: col.references.column }] : [],
    };
    if (col.primaryKey) detail.primaryKeyPosition = ++pkPosition;
    return detail;
  });
  return { namespace: ref.namespace, name: ref.name, kind: relation.kind, columns };
}
