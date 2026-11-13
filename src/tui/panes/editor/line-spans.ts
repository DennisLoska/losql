export interface LineSpan {
  row: number;
  start: number;
  end: number;
  role: string;
}

export function spansByLine(
  text: string,
  spans: { start: number; end: number; role: string }[],
): LineSpan[] {
  if (text.length === 0 || spans.length === 0) return [];

  const lines = text.split("\n");
  const count = lines.length;
  const lineStarts = new Array<number>(count);
  const lineEnds = new Array<number>(count);

  let offset = 0;
  for (let r = 0; r < count; r++) {
    const len = lines[r]!.length;
    lineStarts[r] = offset;
    lineEnds[r] = offset + len;
    offset += len + 1;
  }

  const totalLen = lineEnds[count - 1]!;
  const out: LineSpan[] = [];
  let hintRow = 0;

  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!;
    const spanStart = Math.max(0, span.start);
    const spanEnd = Math.min(totalLen, span.end);
    if (spanEnd <= spanStart) continue;

    let row = hintRow;
    if (row >= count || lineStarts[row]! > spanStart) {
      let lo = 0;
      let hi = count - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (lineEnds[mid]! < spanStart) {
          lo = mid + 1;
        } else {
          hi = mid;
        }
      }
      row = lo;
    } else {
      while (row + 1 < count && lineEnds[row]! < spanStart) {
        row++;
      }
    }
    hintRow = row;

    for (let r = row; r < count; r++) {
      const lStart = lineStarts[r]!;
      if (lStart >= spanEnd) break;
      const lEnd = lineEnds[r]!;
      const start = Math.max(spanStart, lStart) - lStart;
      const end = Math.min(spanEnd, lEnd) - lStart;
      if (end > start) {
        out.push({ row: r, start, end, role: span.role });
      }
    }
  }

  return out;
}
