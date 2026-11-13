import { type HistoryEntry, readHistory } from "../../core/state";
import type { AppApi } from "../app";
import { clusters, cutCells } from "../ui/cells";
import { printable } from "../ui/printable";
import type { SelectOption } from "../ui/select";

function formatHistoryTitle(sql: string): string {
  const firstLineRaw = sql.split(/\r\n|\r|\n/)[0] ?? "";
  const hasMoreLines = /\r\n|\r|\n/.test(sql);
  const cleanLine = printable(firstLineRaw);

  // At most 60 cells and 60 grapheme clusters of the first line.
  const byCells = cutCells(cleanLine, 60);
  const parts = clusters(byCells);
  const cut = parts.length > 60 ? parts.slice(0, 60).join("") : byCells;

  if (cut.length < cleanLine.length) {
    return `${cut}…`;
  }
  if (hasMoreLines) {
    return `${cleanLine} …`;
  }
  return cleanLine;
}

function formatHistoryHint(entry: HistoryEntry): string {
  if (!entry.ok) {
    return "error";
  }
  const rows = entry.rows ?? 0;
  const rowWord = rows === 1 ? "1 row" : `${rows} rows`;
  return `${rowWord} · ${entry.ms} ms`;
}

export function historyOptions(entries: HistoryEntry[]): SelectOption<string>[] {
  const seen = new Set<string>();
  const options: SelectOption<string>[] = [];

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (seen.has(entry.sql)) continue;
    seen.add(entry.sql);

    options.push({
      title: formatHistoryTitle(entry.sql),
      hint: formatHistoryHint(entry),
      value: entry.sql,
    });
  }

  return options;
}

export async function openHistory(api: AppApi): Promise<void> {
  const connectionId = api.session.connection()?.id;
  const newestFirst = await readHistory(api.deps.paths, connectionId);
  const oldestFirst = newestFirst.slice().reverse();
  const options = historyOptions(oldestFirst);

  const selectedSql = await api.dialog.select({
    title: "History",
    options,
    empty: "No history yet",
  });

  if (selectedSql !== null && api.editor) {
    api.editor.openBuffer({ name: "history", text: selectedSql });
    api.focus.focus("editor");
  }
}
