import type { Position } from "./buffer";

export const MAX_UNDO_ENTRIES = 1000;
export const MAX_UNDO_CHARS = 16_000_000;

export interface UndoSnapshot {
  text: string;
  cursor: Position;
}

export class UndoHistory {
  private undoStack: UndoSnapshot[] = [];
  private redoStack: UndoSnapshot[] = [];
  private undoChars = 0;
  private redoChars = 0;

  constructor(
    private readonly maxEntries = MAX_UNDO_ENTRIES,
    private readonly maxChars = MAX_UNDO_CHARS,
  ) {}

  push(snapshot: UndoSnapshot): void {
    this.redoStack = [];
    this.redoChars = 0;
    this.pushToUndo(snapshot);
  }

  undo(current: UndoSnapshot): UndoSnapshot | null {
    const prev = this.undoStack.pop();
    if (!prev) return null;
    this.undoChars -= prev.text.length;
    this.pushToRedo(current);
    return prev;
  }

  redo(current: UndoSnapshot): UndoSnapshot | null {
    const next = this.redoStack.pop();
    if (!next) return null;
    this.redoChars -= next.text.length;
    this.pushToUndo(current);
    return next;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.undoChars = 0;
    this.redoChars = 0;
  }

  private pushToUndo(snapshot: UndoSnapshot): void {
    this.undoStack.push(snapshot);
    this.undoChars += snapshot.text.length;
    this.trimUndo();
  }

  private pushToRedo(snapshot: UndoSnapshot): void {
    this.redoStack.push(snapshot);
    this.redoChars += snapshot.text.length;
    this.trimRedo();
  }

  private trimUndo(): void {
    while (
      this.undoStack.length > 1 &&
      (this.undoStack.length > this.maxEntries || this.undoChars > this.maxChars)
    ) {
      const dropped = this.undoStack.shift()!;
      this.undoChars -= dropped.text.length;
    }
  }

  private trimRedo(): void {
    while (
      this.redoStack.length > 1 &&
      (this.redoStack.length > this.maxEntries || this.redoChars > this.maxChars)
    ) {
      const dropped = this.redoStack.shift()!;
      this.redoChars -= dropped.text.length;
    }
  }
}
