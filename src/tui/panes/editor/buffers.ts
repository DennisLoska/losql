import { basename } from "node:path";
import { createComputed, onCleanup, untrack } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import {
  keepDamagedBuffers,
  type LoadedBuffers,
  loadBuffers,
  type SavedBuffer,
  saveBuffers,
} from "../../../core/state";
import type { Paths } from "../../../core/paths";
import { useToast, type ToastApi } from "../../context/toast";
import type { AppDeps } from "../../deps";
import { printable } from "../../ui/printable";

export type LoadBuffersFn = (
  paths: Paths,
  connectionId: string,
) => Promise<LoadedBuffers | null>;

export interface EditorBuffer {
  id: number;
  name: string;
  path: string | null;
  text: string;
}

export const DEMO_BUFFER_TEXT = [
  "-- Welcome to losql. In normal mode, Enter runs the statement under the cursor.",
  "select c.name, c.country, count(o.id) as orders",
  "from customers c",
  "left join orders o on o.customer_id = c.id",
  "group by c.id",
  "order by orders desc;",
].join("\n");

export function uniqueBufferName(
  existing: readonly { id?: number; name: string }[],
  baseName: string,
  excludeId?: number,
): string {
  const used = new Set<string>();
  for (const item of existing) {
    if (excludeId !== undefined && item.id === excludeId) continue;
    used.add(item.name);
  }
  if (!used.has(baseName)) return baseName;
  let n = 2;
  while (used.has(`${baseName}-${n}`)) {
    n++;
  }
  return `${baseName}-${n}`;
}

export interface BuffersStore {
  buffers(): EditorBuffer[];
  active(): number;
  activeBuffer(): EditorBuffer;
  setActive(index: number): void;
  next(): void;
  previous(): void;
  updateText(id: number, text: string): void;
  setPath(id: number, filePath: string): string;
  openBuffer(options: { name?: string; path?: string | null; text: string }): EditorBuffer;
  closeActive(): void;
  flush(): Promise<void>;
}

export function createBuffers(
  deps: AppDeps,
  connectionId: () => string,
  onSaveError?: (message: string) => void,
): BuffersStore {
  let nextId = 1;
  let saveWarned = false;
  // The warning about a damaged file of saved Buffers goes to the toasts of the application, when
  // there is one.
  let toast: ToastApi | null = null;
  try {
    toast = useToast();
  } catch {
    toast = null;
  }
  // Connections whose file of saved Buffers was damaged when it was read: before the file is written
  // for the first time afterwards, the damaged original is kept beside it.
  const damagedFiles = new Set<string>();
  const makeDefault = (connId: string): EditorBuffer[] => [
    {
      id: nextId++,
      name: "scratch",
      path: null,
      text: connId === "demo" ? DEMO_BUFFER_TEXT : "",
    },
  ];

  const initialConnId = untrack(connectionId);
  const initialDefault = makeDefault(initialConnId);
  const [state, setState] = createStore<{ buffers: EditorBuffer[]; active: number }>({
    buffers: initialDefault,
    active: 0,
  });

  let currentConnId = initialConnId;
  let connSeq = 0;
  let loadComplete = false;
  let dirtyWhileLoading = false;
  let defaultBufferId: number | null = initialDefault[0]!.id;
  let touchedIds = new Set<number>();
  let cancelSaveTimer: (() => void) | null = null;
  let ioQueue: Promise<void> = Promise.resolve();

  const stopTimer = () => {
    if (cancelSaveTimer) {
      cancelSaveTimer();
      cancelSaveTimer = null;
    }
  };

  onCleanup(stopTimer);

  const toSaved = (list: readonly EditorBuffer[]): SavedBuffer[] =>
    list.map(({ name, path, text }) => ({ name, path, text }));

  const enqueueSave = (connId: string, list: SavedBuffer[], activeIdx: number): Promise<void> => {
    const next = ioQueue.then(async () => {
      try {
        if (damagedFiles.has(connId)) {
          await keepDamagedBuffers(deps.paths, connId);
          damagedFiles.delete(connId);
        }
        await saveBuffers(deps.paths, connId, list, activeIdx);
      } catch (err) {
        if (!saveWarned) {
          saveWarned = true;
          const msg = err instanceof Error ? err.message : String(err);
          onSaveError?.(msg);
        }
      }
    });
    ioQueue = next;
    return next;
  };

  const scheduleSave = () => {
    if (!loadComplete) {
      dirtyWhileLoading = true;
      return;
    }
    stopTimer();
    cancelSaveTimer = deps.clock.after(400, () => {
      cancelSaveTimer = null;
      if (!loadComplete) return;
      const connId = currentConnId;
      const list = untrack(() => toSaved(state.buffers));
      const activeIdx = untrack(() => state.active);
      void enqueueSave(connId, list, activeIdx);
    });
  };

  const loadForConnection = (connId: string, seq: number) => {
    const next = ioQueue.then(async () => {
      let loaded: LoadedBuffers | null = null;
      try {
        const loader = deps.loadBuffers ?? loadBuffers;
        loaded = await loader(deps.paths, connId);
      } catch {
        loaded = null;
      }
      if (seq !== connSeq || connId !== currentConnId) return;
      loadComplete = true;

      if (loaded?.damaged) {
        damagedFiles.add(connId);
        toast?.show({ message: printable(loaded.damaged.message), kind: "warning" });
      }

      if (loaded && loaded.buffers.length > 0) {
        const currentList = untrack(() => state.buffers);
        const currentActiveIdx = untrack(() => state.active);
        const currentActiveId = currentList[currentActiveIdx]?.id;

        const onlyUntouchedDefault =
          !dirtyWhileLoading &&
          touchedIds.size === 0 &&
          currentList.length === 1 &&
          currentList[0]!.id === defaultBufferId;

        if (onlyUntouchedDefault) {
          const restored: EditorBuffer[] = loaded.buffers.map((b) => ({
            id: nextId++,
            name: b.name,
            path: b.path,
            text: b.text,
          }));
          setState({
            buffers: restored,
            active: Math.max(0, Math.min(restored.length - 1, loaded.active)),
          });
        } else {
          // Keep user-touched buffers (dropping default buffer if still untouched), and add loaded buffers
          const kept = currentList.filter(
            (b) => b.id !== defaultBufferId || touchedIds.has(b.id),
          );
          const merged: EditorBuffer[] = [];
          for (const b of loaded.buffers) {
            const name = uniqueBufferName(merged, b.name);
            merged.push({
              id: nextId++,
              name,
              path: b.path,
              text: b.text,
            });
          }
          for (const u of kept) {
            const name = uniqueBufferName(merged, u.name);
            merged.push({
              id: u.id,
              name,
              path: u.path,
              text: u.text,
            });
          }
          let nextActive = Math.max(0, Math.min(merged.length - 1, loaded.active));
          if (currentActiveId !== undefined) {
            const foundIdx = merged.findIndex((b) => b.id === currentActiveId);
            if (foundIdx >= 0) {
              nextActive = foundIdx;
            }
          }
          setState({
            buffers: merged,
            active: nextActive,
          });
        }
      }

      if (dirtyWhileLoading) {
        dirtyWhileLoading = false;
        scheduleSave();
      }
    });
    ioQueue = next;
  };

  let initialized = false;
  createComputed(() => {
    const nextConnId = connectionId();
    if (!initialized) {
      initialized = true;
      currentConnId = nextConnId;
      const seq = ++connSeq;
      loadForConnection(nextConnId, seq);
      return;
    }
    if (nextConnId === currentConnId) return;

    const prevConnId = currentConnId;
    const prevWasLoaded = loadComplete;
    const prevWasDirty = dirtyWhileLoading;
    const prevList = untrack(() => toSaved(state.buffers));
    const prevActive = untrack(() => state.active);
    stopTimer();
    if (prevWasLoaded) {
      void enqueueSave(prevConnId, prevList, prevActive);
    } else if (prevWasDirty) {
      // Wait for previous connection's load in ioQueue; if we want to be safe, never overwrite an unloaded connection
    }

    currentConnId = nextConnId;
    const seq = ++connSeq;
    loadComplete = false;
    dirtyWhileLoading = false;
    touchedIds = new Set<number>();
    const def = makeDefault(nextConnId);
    defaultBufferId = def[0]!.id;
    setState({
      buffers: def,
      active: 0,
    });
    loadForConnection(nextConnId, seq);
  });

  const activeBuffer = (): EditorBuffer => {
    const list = state.buffers;
    const idx = Math.max(0, Math.min(list.length - 1, state.active));
    return list[idx]!;
  };

  return {
    buffers: () => state.buffers,
    active: () => state.active,
    activeBuffer,
    setActive(index: number) {
      const len = untrack(() => state.buffers.length);
      if (len === 0) return;
      const clamped = Math.max(0, Math.min(len - 1, index));
      setState("active", clamped);
      scheduleSave();
    },
    next() {
      const len = untrack(() => state.buffers.length);
      if (len <= 1) return;
      setState("active", (untrack(() => state.active) + 1) % len);
      scheduleSave();
    },
    previous() {
      const len = untrack(() => state.buffers.length);
      if (len <= 1) return;
      setState("active", (untrack(() => state.active) - 1 + len) % len);
      scheduleSave();
    },
    updateText(id: number, text: string) {
      const idx = untrack(() => state.buffers.findIndex((b) => b.id === id));
      if (idx < 0) return;
      if (untrack(() => state.buffers[idx]!.text) === text) return;
      touchedIds.add(id);
      setState("buffers", idx, "text", text);
      scheduleSave();
    },
    setPath(id: number, filePath: string): string {
      const list = untrack(() => state.buffers);
      const idx = list.findIndex((b) => b.id === id);
      if (idx < 0) return basename(filePath);
      touchedIds.add(id);
      const name = uniqueBufferName(list, basename(filePath), id);
      setState("buffers", idx, { name, path: filePath });
      scheduleSave();
      return name;
    },
    openBuffer(options: { name?: string; path?: string | null; text: string }): EditorBuffer {
      const list = untrack(() => state.buffers);
      const base =
        options.name ?? (options.path ? basename(options.path) : "scratch");
      const name = uniqueBufferName(list, base);
      const id = nextId++;
      touchedIds.add(id);
      const entry: EditorBuffer = {
        id,
        name,
        path: options.path ?? null,
        text: options.text,
      };
      const nextLen = list.length + 1;
      setState("buffers", list.length, entry);
      setState("active", nextLen - 1);
      scheduleSave();
      return state.buffers[nextLen - 1]!;
    },
    closeActive() {
      const len = untrack(() => state.buffers.length);
      if (len <= 1) {
        const prevId = untrack(() => state.buffers[0]?.id);
        if (prevId !== undefined) touchedIds.delete(prevId);
        const newId = nextId++;
        defaultBufferId = newId;
        setState({
          buffers: [
            {
              id: newId,
              name: "scratch",
              path: null,
              text: "",
            },
          ],
          active: 0,
        });
        scheduleSave();
        return;
      }
      const idx = untrack(() => state.active);
      const removedId = untrack(() => state.buffers[idx]?.id);
      if (removedId !== undefined) touchedIds.delete(removedId);
      setState("buffers", (prev) => prev.filter((_, i) => i !== idx));
      setState("active", Math.min(idx, len - 2));
      scheduleSave();
    },
    flush(): Promise<void> {
      stopTimer();
      const connId = currentConnId;
      if (!loadComplete) {
        dirtyWhileLoading = true;
        return ioQueue.then(() => {
          if (connId !== currentConnId || !loadComplete) return;
          stopTimer();
          const list = untrack(() => toSaved(state.buffers));
          const activeIdx = untrack(() => state.active);
          return enqueueSave(connId, list, activeIdx);
        });
      }
      const list = untrack(() => toSaved(state.buffers));
      const activeIdx = untrack(() => state.active);
      return enqueueSave(connId, list, activeIdx);
    },
  };
}
