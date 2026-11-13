function foldCase(s: string): string {
  const lower = s.toLowerCase();
  if (lower.length === s.length) return lower;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const u = s[i]!;
    const l = u.toLowerCase();
    out += l.length === 1 ? l : u;
  }
  return out;
}

function isWordBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const prev = text[index - 1];
  return prev === "_" || prev === " " || prev === "." || prev === "-" || prev === "/";
}

export function fuzzyScore(query: string, text: string): number | null {
  if (query.length === 0) return 0;
  const q = foldCase(query);
  const t = foldCase(text);

  let score = 0;
  let searchFrom = 0;
  let firstMatch = -1;
  let prevMatch = -1;

  for (let i = 0; i < q.length; i++) {
    const ch = q[i]!;
    const idx = t.indexOf(ch, searchFrom);
    if (idx === -1) return null;

    if (firstMatch === -1) {
      firstMatch = idx;
    }

    score += 1;
    if (prevMatch !== -1 && idx === prevMatch + 1) {
      score += 2;
    }
    if (isWordBoundary(t, idx)) {
      score += 3;
    }

    prevMatch = idx;
    searchFrom = idx + 1;
  }

  score -= 0.01 * firstMatch;
  return score;
}

export function fuzzyFilter<T>(
  query: string,
  items: readonly T[],
  key: (item: T) => string,
): T[] {
  if (query.length === 0) return [...items];

  const scored: { item: T; score: number; len: number; index: number }[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const k = key(item);
    const score = fuzzyScore(query, k);
    if (score !== null) {
      scored.push({ item, score, len: k.length, index: i });
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.len !== b.len) return a.len - b.len;
    return a.index - b.index;
  });

  return scored.map((entry) => entry.item);
}
