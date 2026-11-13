import { appendFile, chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Paths } from "./paths";

export interface AppState {
  onboarded: boolean;
  lastConnection: string | null;
  providerTests: Record<string, { ok: boolean; at: string; message: string }>;
}

export const DEFAULT_STATE: AppState = {
  onboarded: false,
  lastConnection: null,
  providerTests: {},
};

export interface HistoryEntry {
  ts: string;
  connection: string;
  sql: string;
  ok: boolean;
  rows: number | null;
  ms: number;
}

export const HISTORY_LIMIT = 5000;

export interface SavedBuffer {
  name: string;
  path: string | null;
  text: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function writeAtomicJson(dir: string, filePath: string, data: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmpFile = `${filePath}.tmp`;
  await writeFile(tmpFile, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmpFile, 0o600);
  await rename(tmpFile, filePath);
}

/** What `loadState` warned about, per returned state (see `stateWarnings`). */
const loadWarnings = new WeakMap<AppState, string[]>();
/** State files found damaged when they were loaded: each is kept as `.bad` before it is written. */
const damagedStateFiles = new Set<string>();

function defaultState(): AppState {
  return {
    onboarded: DEFAULT_STATE.onboarded,
    lastConnection: DEFAULT_STATE.lastConnection,
    providerTests: {},
  };
}

/**
 * The state and what was wrong with its file. A file that is not there is no error. A file that is
 * there but could not be read, or not all of it, gives the defaults for what could not be read and
 * one warning that names the file. The file is never changed here: the first `saveState` after
 * this keeps it beside the new one as `state.json.bad`.
 */
export async function readState(paths: Paths): Promise<{ state: AppState; warnings: string[] }> {
  const file = paths.stateFile;
  const kept = `it is kept as ${file}.bad when the state is next saved`;
  const damaged = (state: AppState, warning: string) => {
    damagedStateFiles.add(file);
    return { state, warnings: [warning] };
  };

  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { state: defaultState(), warnings: [] };
    }
    const reason = typeof code === "string" ? code : err instanceof Error ? err.message : String(err);
    return damaged(defaultState(), `state: could not read ${file} (${reason}); using defaults; ${kept}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return damaged(defaultState(), `state: ${file} is not valid JSON; using defaults; ${kept}`);
  }

  if (!isPlainObject(parsed)) {
    return damaged(defaultState(), `state: ${file} does not hold a JSON object; using defaults; ${kept}`);
  }

  const unreadable: string[] = [];
  let onboarded = DEFAULT_STATE.onboarded;
  if (typeof parsed.onboarded === "boolean") {
    onboarded = parsed.onboarded;
  } else if (parsed.onboarded !== undefined) {
    unreadable.push("onboarded");
  }

  let lastConnection = DEFAULT_STATE.lastConnection;
  if (typeof parsed.lastConnection === "string" || parsed.lastConnection === null) {
    lastConnection = parsed.lastConnection;
  } else if (parsed.lastConnection !== undefined) {
    unreadable.push("lastConnection");
  }

  const providerTests: Record<string, { ok: boolean; at: string; message: string }> = {};
  if (isPlainObject(parsed.providerTests)) {
    let skipped = false;
    for (const [key, val] of Object.entries(parsed.providerTests)) {
      if (
        isPlainObject(val) &&
        typeof val.ok === "boolean" &&
        typeof val.at === "string" &&
        typeof val.message === "string"
      ) {
        providerTests[key] = { ok: val.ok, at: val.at, message: val.message };
      } else {
        skipped = true;
      }
    }
    if (skipped) unreadable.push("providerTests");
  } else if (parsed.providerTests !== undefined) {
    unreadable.push("providerTests");
  }

  const state = { onboarded, lastConnection, providerTests };
  if (unreadable.length > 0) {
    return damaged(
      state,
      `state: some values in ${file} could not be read (${unreadable.join(", ")}); using defaults for them; ${kept}`,
    );
  }
  return { state, warnings: [] };
}

/** The state of `readState`; its warnings are given by `stateWarnings` for the returned object. */
export async function loadState(paths: Paths): Promise<AppState> {
  const { state, warnings } = await readState(paths);
  if (warnings.length > 0) {
    loadWarnings.set(state, warnings);
  }
  return state;
}

/** The warnings `loadState` had when it returned `state` (none for any other object). */
export function stateWarnings(state: AppState): string[] {
  return loadWarnings.get(state) ?? [];
}

export async function saveState(paths: Paths, state: AppState): Promise<void> {
  if (damagedStateFiles.has(paths.stateFile)) {
    // The damaged original is kept before it is written over; if that fails, nothing is written.
    const badPath = `${paths.stateFile}.bad`;
    try {
      await rename(paths.stateFile, badPath);
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code !== "ENOENT") throw err;
    }
    damagedStateFiles.delete(paths.stateFile);
    if ((await stat(badPath).catch(() => null))?.isFile()) {
      await chmod(badPath, 0o600);
    }
  }
  await writeAtomicJson(paths.stateDir, paths.stateFile, state);
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  return (
    isPlainObject(value) &&
    typeof value.ts === "string" &&
    typeof value.connection === "string" &&
    typeof value.sql === "string" &&
    typeof value.ok === "boolean" &&
    (value.rows === null || typeof value.rows === "number") &&
    typeof value.ms === "number"
  );
}

/** How many lines past `HISTORY_LIMIT` the file may grow before it is trimmed to the newest entries. */
export const HISTORY_SLACK = 500;

/** One queue per history file: appends, trims and reads of this process never overlap. */
const historyQueues = new Map<string, Promise<unknown>>();
/** The number of non-empty lines of each history file, as this process last knew it. */
const historyLineCounts = new Map<string, number>();

function inHistoryQueue<T>(file: string, op: () => Promise<T>): Promise<T> {
  const prev = historyQueues.get(file) ?? Promise.resolve();
  const next = prev.then(op, op);
  const settled = next.then(
    () => {},
    () => {},
  );
  historyQueues.set(file, settled);
  void settled.then(() => {
    if (historyQueues.get(file) === settled) historyQueues.delete(file);
  });
  return next;
}

function parseHistory(text: string): { entries: HistoryEntry[]; lines: number } {
  const entries: HistoryEntry[] = [];
  let lines = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    lines++;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isHistoryEntry(parsed)) {
        entries.push(parsed);
      }
    } catch {
      // Skip invalid JSON lines
    }
  }
  return { entries, lines };
}

/** Rewrites the file with the newest `HISTORY_LIMIT` entries (mode 0600). Runs in the file's queue. */
async function trimHistory(paths: Paths, entries: HistoryEntry[]): Promise<HistoryEntry[]> {
  const kept = entries.slice(-HISTORY_LIMIT);
  const tmpFile = `${paths.historyFile}.${process.pid}.tmp`;
  try {
    await mkdir(paths.stateDir, { recursive: true });
    const body = kept.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(tmpFile, body, { mode: 0o600 });
    await chmod(tmpFile, 0o600);
    await rename(tmpFile, paths.historyFile);
    historyLineCounts.set(paths.historyFile, kept.length);
  } catch {
    await rm(tmpFile, { force: true }).catch(() => {});
    // Tried again after the next HISTORY_SLACK appends, not after every one.
    historyLineCounts.set(paths.historyFile, HISTORY_LIMIT);
  }
  return kept;
}

/**
 * Appends one entry. The file holds at most `HISTORY_LIMIT` + `HISTORY_SLACK` lines: when an append
 * goes past that, the file is trimmed to the newest `HISTORY_LIMIT` entries. A failed trim does not
 * fail the append.
 */
export async function appendHistory(paths: Paths, entry: HistoryEntry): Promise<void> {
  const file = paths.historyFile;
  await inHistoryQueue(file, async () => {
    let count = historyLineCounts.get(file);
    if (count === undefined) {
      try {
        count = parseHistory(await readFile(file, "utf8")).lines;
      } catch {
        count = 0;
      }
    }
    await mkdir(paths.stateDir, { recursive: true });
    await appendFile(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
    count++;
    historyLineCounts.set(file, count);
    if (count > HISTORY_LIMIT + HISTORY_SLACK) {
      let text: string | null = null;
      try {
        text = await readFile(file, "utf8");
      } catch {
        historyLineCounts.delete(file);
      }
      if (text !== null) {
        await trimHistory(paths, parseHistory(text).entries);
      }
    }
  });
}

export async function readHistory(paths: Paths, connection?: string): Promise<HistoryEntry[]> {
  const file = paths.historyFile;
  const entries = await inHistoryQueue(file, async () => {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return [];
    }
    const parsed = parseHistory(text);
    historyLineCounts.set(file, parsed.lines);
    if (parsed.entries.length > HISTORY_LIMIT) {
      return trimHistory(paths, parsed.entries);
    }
    return parsed.entries;
  });

  const filtered = connection !== undefined ? entries.filter((e) => e.connection === connection) : entries;
  return filtered.slice().reverse();
}

function bufferFilePath(paths: Paths, connectionId: string): string {
  try {
    const encoded = encodeURIComponent(connectionId);
    if (encoded.length <= 200) {
      return join(paths.buffersDir, `${encoded}.json`);
    }
  } catch {
    // Fall through to hash digest
  }
  const digest = new Bun.CryptoHasher("sha256").update(connectionId).digest("hex");
  return join(paths.buffersDir, `h-${digest}.json`);
}

function isSavedBuffer(value: unknown): value is SavedBuffer {
  return (
    isPlainObject(value) &&
    typeof value.name === "string" &&
    (value.path === null || typeof value.path === "string") &&
    typeof value.text === "string"
  );
}

export async function saveBuffers(
  paths: Paths,
  connectionId: string,
  buffers: SavedBuffer[],
  active: number,
): Promise<void> {
  const filePath = bufferFilePath(paths, connectionId);
  await writeAtomicJson(paths.buffersDir, filePath, { buffers, active });
}

/** What `loadBuffers` read. `damaged` is there when the file was there but not all of it could be read. */
export interface LoadedBuffers {
  buffers: SavedBuffer[];
  active: number;
  damaged?: { file: string; message: string };
}

/**
 * The saved Buffers of a Connection. Null when there is no file (or it holds an empty list). A file
 * that is there but damaged gives its valid entries (possibly none) and `damaged`, which names the
 * file: the file is never changed here; `keepDamagedBuffers` keeps it before it is written again.
 */
export async function loadBuffers(
  paths: Paths,
  connectionId: string,
): Promise<LoadedBuffers | null> {
  const filePath = bufferFilePath(paths, connectionId);
  const damaged = (buffers: SavedBuffer[] = [], active = 0): LoadedBuffers => ({
    buffers,
    active,
    damaged: {
      file: filePath,
      message: `Some saved buffers in ${filePath} could not be read; the file was kept as ${filePath}.bad`,
    },
  });

  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return null;
    }
    return damaged();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return damaged();
  }

  if (!isPlainObject(parsed) || !Array.isArray(parsed.buffers)) {
    return damaged();
  }

  const savedActive = parsed.active;
  const buffers: SavedBuffer[] = [];
  let skipped = 0;
  let active = 0;
  parsed.buffers.forEach((item: unknown, index: number) => {
    if (!isSavedBuffer(item)) {
      skipped++;
      return;
    }
    if (index === savedActive) {
      active = buffers.length;
    }
    buffers.push({ name: item.name, path: item.path, text: item.text });
  });

  if (skipped > 0) {
    return damaged(buffers, active);
  }

  if (buffers.length === 0) {
    return null;
  }

  return { buffers, active };
}

/**
 * Keeps the damaged file of saved Buffers beside it as `<name>.json.bad` (mode 0600; an older `.bad`
 * file is replaced), so that writing the file again loses nothing. Nothing there: nothing to keep.
 */
export async function keepDamagedBuffers(paths: Paths, connectionId: string): Promise<void> {
  const filePath = bufferFilePath(paths, connectionId);
  const badPath = `${filePath}.bad`;
  try {
    await rename(filePath, badPath);
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === "ENOENT") return;
    throw err;
  }
  if ((await stat(badPath)).isFile()) {
    await chmod(badPath, 0o600);
  }
}
