function hasUpperCase(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch !== ch.toLowerCase()) {
      return true;
    }
  }
  return false;
}

function escapeRegExp(pattern: string): string {
  return pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function compilePattern(pattern: string): RegExp {
  const flags = hasUpperCase(pattern) ? "g" : "gi";
  try {
    return new RegExp(pattern, flags);
  } catch {
    return new RegExp(escapeRegExp(pattern), flags);
  }
}

function isBetweenSurrogatePair(text: string, idx: number): boolean {
  if (idx <= 0 || idx >= text.length) return false;
  const high = text.charCodeAt(idx - 1);
  const low = text.charCodeAt(idx);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

export function findMatches(text: string, pattern: RegExp): { start: number; end: number }[] {
  const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
  const re = new RegExp(pattern.source, flags);
  const matches: { start: number; end: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    let start = match.index;
    let end = start + match[0].length;
    if (end > start) {
      if (isBetweenSurrogatePair(text, start)) {
        start--;
        if (matches.length > 0 && start < matches[matches.length - 1]!.end) {
          continue;
        }
      }
      if (isBetweenSurrogatePair(text, end)) {
        end++;
      }
      matches.push({ start, end });
    } else {
      re.lastIndex = start + 1;
      if (re.lastIndex > text.length) break;
    }
  }
  return matches;
}
