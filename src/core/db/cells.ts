import type { Cell, Column } from "./types";

export function defineOwnProperty<T>(
  target: Record<string, T>,
  key: string,
  value: T,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

export function uniqueColumnNames(names: readonly string[]): string[] {
  const taken = new Set<string>(names);
  const used = new Set<string>();
  const nextSuffix = new Map<string, number>();
  const result: string[] = [];

  for (let i = 0; i < names.length; i++) {
    const base = names[i]!;
    let candidate = base;
    if (used.has(candidate)) {
      let suffix = nextSuffix.get(base) ?? 2;
      while (true) {
        candidate = `${base}_${suffix}`;
        suffix++;
        if (!used.has(candidate) && !taken.has(candidate)) {
          break;
        }
      }
      nextSuffix.set(base, suffix);
    }
    used.add(candidate);
    taken.add(candidate);
    result.push(candidate);
  }

  return result;
}

export function buildRowObject(
  columns: readonly Column[],
  row: readonly Cell[],
  precomputedKeys?: readonly string[],
): Record<string, Cell> {
  const keys = precomputedKeys ?? uniqueColumnNames(columns.map((c) => c.name));
  const out: Record<string, Cell> = {};
  for (let i = 0; i < keys.length; i++) {
    defineOwnProperty(out, keys[i]!, row[i] ?? null);
  }
  return out;
}

export function normalizeSharedCell(
  value: unknown,
  options?: { bigintToSafeNumber?: boolean },
): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "bigint") {
    if (
      options?.bigintToSafeNumber &&
      value >= BigInt(Number.MIN_SAFE_INTEGER) &&
      value <= BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      return Number(value);
    }
    return value.toString(10);
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
  }
  if (value instanceof Uint8Array) {
    let hex = "\\x";
    for (let i = 0; i < value.length; i++) {
      hex += value[i]!.toString(16).padStart(2, "0");
    }
    return hex;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeSharedCell(item, options));
  }
  if (typeof value === "object") {
    const out: { [key: string]: Cell } = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      defineOwnProperty(out, k, normalizeSharedCell(v, options));
    }
    return out;
  }
  return String(value);
}
